import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';

import { ScaError } from '../domain/errors.js';
import { stableHash, stableStringify, sha256Tag } from '../domain/hash.js';
import { adaptTranscript, assertTranscriptIdentity } from '../hosts/index.js';
import { atomicWriteText } from '../store/atomic.js';
import { withAdvisoryLock } from '../store/lock.js';
import { validateLedger, validateManifest } from './integrity.js';
import { validateReworkClaim } from './rework-validation.js';
import { BatchReadContext } from './runtime.js';
import { resolvePaths } from '../store/paths.js';
import {
  batchIdSchema, batchInputSchema, batchSubmissionSchema, ledgerSchema, manifestSchema,
  pageRequestSchema, WORKER_GUIDANCE,
  type BatchManifest, type BatchLedger, type BatchSubmission, type Judgment,
  type PageCursor, type SourceSnapshot,
} from './schema.js';

function invalid(detail: string): never { throw new ScaError('schema_invalid', detail); }

async function readSourceBytes(file: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 64 * 1024 * 1024) throw new ScaError('payload_too_large', 'prototype source limit is 64 MiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

export async function buildBatch(input: unknown): Promise<BatchManifest> {
  const parsed = batchInputSchema.parse(input);
  const sources: SourceSnapshot[] = [];
  const bodies = new Map<string, string>();
  const candidates = new Map<string, string>();
  const targets: BatchManifest['targets'] = [];
  for (const entry of parsed.sources) {
    const created = Date.parse(entry.created_at);
    if (created < Date.parse(parsed.scope.start) || created >= Date.parse(parsed.scope.end)) {
      invalid('source created_at is outside frozen scope');
    }
    const sourcePath = path.resolve(entry.path);
    const sourceSize = (await fs.stat(sourcePath)).size;
    if (sourceSize > 64 * 1024 * 1024) throw new ScaError('payload_too_large', 'prototype source limit is 64 MiB; split or use the original semantic workflow');
    const before = await readSourceBytes(sourcePath);
    const transcript = await adaptTranscript(sourcePath);
    await assertTranscriptIdentity(transcript, { host: entry.host, sessionId: entry.session_id });
    const after = await readSourceBytes(sourcePath);
    if (!before.equals(after)) throw new ScaError('coverage_incomplete', 'source changed during indexing; retry');
    const sourceHash = `sha256:${createHash('sha256').update(before).digest('hex')}`;
    const sourceId = `src-${stableHash({ input: { ...entry, path: sourcePath }, sourceHash }).slice(7)}`;
    if (sources.some(source => source.source_id === sourceId)) invalid('duplicate source declaration');
    const events: SourceSnapshot['events'] = [];
    for (const [index, event] of transcript.events.entries()) {
      const evidenceId = `ev-${stableHash([sourceId, index, event]).slice(7)}`;
      const bodyHash = sha256Tag(event.text ?? '');
      const reuse = bodies.get(event.text ?? '');
      events.push({ evidence_id: evidenceId, body_hash: bodyHash, event,
        ...(reuse === undefined ? {} : { reading_reuse_of: reuse }) });
      if (reuse === undefined) bodies.set(event.text ?? '', evidenceId);
      if (event.kind === 'user_message') {
        const targetId = `target-${stableHash(evidenceId).slice(7)}`;
        // Adapter event IDs may be line-derived: matching is advisory, never automatic event merging.
        const contextKey = stableStringify({ host: entry.host, session: entry.session_id,
          role: entry.role, role_basis: entry.role_basis, parent: entry.parent_session_id ?? null,
          event: { id: event.id, kind: event.kind, role: event.role, origin: event.origin,
            timestamp: event.timestamp, text: event.text },
          neighbors: transcript.events.slice(Math.max(0, index - 1), index + 2).map(item => ({
            kind: item.kind, role: item.role, origin: item.origin, text: item.text,
          })),
        });
        const candidate = candidates.get(contextKey);
        targets.push({ target_id: targetId, source_id: sourceId, evidence_id: evidenceId,
          ...(candidate === undefined ? {} : { reuse_candidate_of: candidate }) });
        if (candidate === undefined) candidates.set(contextKey, targetId);
      }
    }
    sources.push({ source_id: sourceId, input: { ...entry, path: sourcePath }, source_hash: sourceHash,
      byte_length: before.length, frozen_bytes_base64: before.toString('base64'),
      parser_version: transcript.parser_version,
      coverage: transcript.coverage === 'full' && transcript.stats.sidechain_records === 0 && transcript.stats.compacted_records === 0 ? 'full' : 'partial',
      excluded_sidechain_records: transcript.stats.sidechain_records, compacted_records: transcript.stats.compacted_records,
      parent_status: entry.parent_session_id === undefined ? 'not_declared' : 'unverified', events });
  }
  return manifestSchema.parse({ schema: 'session-correction-analysis/batch-manifest/v1',
    batch_id: parsed.batch_id, scope: parsed.scope, sources, targets });
}

function directory(root: string, batchId: string): string {
  return path.join(resolvePaths(root).root, 'batches', batchIdSchema.parse(batchId));
}

export async function saveBatch(root: string, input: unknown): Promise<BatchManifest> {
  const manifest = await buildBatch(input);
  return persistBatch(root, manifest);
}

export async function persistBatch(root: string, input: BatchManifest): Promise<BatchManifest> {
  const manifest = validateManifest(input);
  const dir = directory(root, manifest.batch_id);
  await withAdvisoryLock(resolvePaths(root), `batch-${manifest.batch_id}`, async () => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    let existing: BatchManifest | undefined;
    try { existing = validateManifest(JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as unknown); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (existing !== undefined) {
      if (stableHash(existing) !== stableHash(manifest)) invalid('batch is immutable; use a new batch id for appended sources or growth');
      return;
    }
    await atomicWriteText(dir, 'manifest.json', stableStringify(manifest), 0o600);
  });
  return manifest;
}

export async function loadBatchReadContext(root: string, batchId: string): Promise<BatchReadContext> {
  try {
    const context = BatchReadContext.create(JSON.parse(await fs.readFile(path.join(directory(root, batchId), 'manifest.json'), 'utf8')) as unknown);
    if (context.manifest.batch_id !== batchId) invalid('batch identity mismatch');
    return context;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) invalid('batch manifest is malformed; preserve private state and inspect the protocol');
    throw error;
  }
}

export async function loadBatch(root: string, batchId: string): Promise<BatchManifest> {
  try {
    const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(directory(root, batchId), 'manifest.json'), 'utf8')) as unknown);
    if (manifest.batch_id !== batchId) invalid('batch identity mismatch');
    return manifest;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) invalid('batch manifest is malformed; preserve private state and inspect the protocol');
    throw error;
  }
}

export interface EvidencePage {
  schema: string;
  manifest_hash: string;
  guidance: string;
  items: { evidence_id: string; source_id: string; event_id: string; kind: string;
    source_ref: SourceSnapshot['events'][number]['event']['source_ref'];
    actor: SourceSnapshot['input']['role']; role_basis: SourceSnapshot['input']['role_basis'];
    origin?: SourceSnapshot['events'][number]['event']['origin']; timestamp?: string;
    text_offset: number;
    text: string; complete: boolean; reading_reuse_of?: string }[];
  targets: BatchManifest['targets'];
  next_cursor: PageCursor | null;
}

export function evidencePage(input: BatchManifest, request: unknown): EvidencePage {
  const manifest = manifestSchema.parse(input);
  return pageFromSnapshot(manifest, stableHash(manifest), request);
}

export function createEvidencePager(input: BatchManifest | BatchReadContext): (request: unknown) => EvidencePage {
  const context = input instanceof BatchReadContext ? input : BatchReadContext.create(input);
  return request => structuredClone(pageFromSnapshot(context.manifest, context.manifest_hash, request, context));
}

function pageFromSnapshot(manifest: BatchManifest, hash: string, request: unknown, context?: BatchReadContext): EvidencePage {
  const options = pageRequestSchema.parse(request);
  let cursor: PageCursor = options.cursor ?? { manifest_hash: hash, source_index: 0, event_index: 0, text_offset: 0 };
  if (cursor.manifest_hash !== hash) invalid('cursor belongs to another snapshot');
  if (options.evidence_id !== undefined) {
    let found = false;
    const position = context?.position(options.evidence_id);
    if (position !== undefined) { cursor = { manifest_hash: hash, source_index: position.source_index, event_index: position.event_index, text_offset: 0, expand: true }; found = true; }
    for (const [si, source] of found ? [] : manifest.sources.entries()) {
      const ei = source.events.findIndex(event => event.evidence_id === options.evidence_id);
      if (ei >= 0) { cursor = { manifest_hash: hash, source_index: si, event_index: ei, text_offset: 0, expand: true }; found = true; break; }
    }
    if (!found) throw new ScaError('evidence_not_found');
  }
  const page: EvidencePage = { schema: 'session-correction-analysis/batch-page/v1', manifest_hash: hash,
    guidance: WORKER_GUIDANCE, items: [], targets: [], next_cursor: cursor };
  // Reserve space for cursor growth at a source boundary before returning a rollback page.
  const fits = (): boolean => Buffer.byteLength(stableStringify(page)) + 128 <= options.max_bytes;
  while (cursor.source_index < manifest.sources.length) {
    const source = manifest.sources[cursor.source_index];
    if (source === undefined) invalid('invalid source cursor');
    if (cursor.event_index === source.events.length && cursor.text_offset === 0) {
      cursor = { ...cursor, source_index: cursor.source_index + 1, event_index: 0 }; continue;
    }
    const indexed = source.events[cursor.event_index];
    if (indexed === undefined) invalid('invalid event cursor');
    const raw = indexed.event.text ?? '';
    const reuseOnly = indexed.reading_reuse_of !== undefined && cursor.expand !== true;
    const text = reuseOnly ? '' : raw;
    if (cursor.text_offset > text.length ||
      (cursor.text_offset > 0 && /[\uDC00-\uDFFF]/u.test(text[cursor.text_offset] ?? '') && /[\uD800-\uDBFF]/u.test(text[cursor.text_offset - 1] ?? ''))) invalid('invalid text offset');
    const offset = cursor.text_offset;
    const baseTargets = page.targets.length;
    const targets = context?.targets(indexed.evidence_id) ?? manifest.targets.filter(target => target.evidence_id === indexed.evidence_id);
    page.targets.push(...targets);
    const item: EvidencePage['items'][number] = { evidence_id: indexed.evidence_id, source_id: source.source_id,
      event_id: indexed.event.id, kind: indexed.event.kind, source_ref: indexed.event.source_ref,
      actor: source.input.role, role_basis: source.input.role_basis,
      ...(indexed.event.origin === undefined ? {} : { origin: indexed.event.origin }),
      ...(indexed.event.timestamp === undefined ? {} : { timestamp: indexed.event.timestamp }),
      text_offset: offset, text: '', complete: false,
      ...(reuseOnly && indexed.reading_reuse_of !== undefined ? { reading_reuse_of: indexed.reading_reuse_of } : {}) };
    page.items.push(item);
    let low = offset; let high = text.length;
    const setEnd = (end: number): void => {
      item.text = text.slice(offset, end); item.complete = end === text.length;
      page.next_cursor = item.complete ? { ...cursor, event_index: cursor.event_index + 1, text_offset: 0 }
        : { ...cursor, text_offset: end };
    };
    setEnd(low);
    if (!fits()) {
      page.items.pop(); page.targets.length = baseTargets; page.next_cursor = cursor;
      if (page.items.length === 0) invalid('byte budget cannot fit evidence metadata');
      return page;
    }
    while (low < high) {
      let mid = Math.ceil((low + high) / 2);
      if (mid < text.length && /[\uD800-\uDBFF]/u.test(text[mid - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(text[mid] ?? '')) mid += 1;
      setEnd(mid);
      if (fits()) low = mid;
      else {
        high = mid - 1;
        if (high > offset && /[\uD800-\uDBFF]/u.test(text[high - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(text[high] ?? '')) high -= 1;
      }
    }
    if (low < text.length && /[\uD800-\uDBFF]/u.test(text[low - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(text[low] ?? '')) low -= 1;
    setEnd(low);
    if (low === offset && low < text.length) {
      page.items.pop(); page.targets.length = baseTargets; page.next_cursor = cursor;
      if (page.items.length === 0) invalid('byte budget cannot fit a text code point');
      return page;
    }
    if (!item.complete) return page;
    cursor = { ...cursor, event_index: cursor.event_index + 1, text_offset: 0 };
    page.next_cursor = cursor;
    if (cursor.expand === true) { page.next_cursor = null; return page; }
  }
  if (cursor.source_index !== manifest.sources.length || cursor.event_index !== 0 || cursor.text_offset !== 0) invalid('invalid terminal cursor');
  page.next_cursor = null;
  return page;
}

function currentJudgments(ledger: BatchLedger): Map<string, Judgment> {
  const result = new Map<string, Judgment>();
  for (const entry of ledger.history) for (const judgment of entry.judgments) result.set(judgment.target_id, judgment);
  return result;
}

export async function readLedger(root: string, input: BatchManifest | BatchReadContext): Promise<BatchLedger> {
  const manifest = input instanceof BatchReadContext ? input.manifest : input;
  try {
    const ledger = validateLedger(JSON.parse(await fs.readFile(path.join(directory(root, manifest.batch_id), 'ledger.json'), 'utf8')) as unknown, input);
    if (ledger.manifest_hash !== (input instanceof BatchReadContext ? input.manifest_hash : stableHash(manifest))) invalid('ledger snapshot mismatch');
    return ledger;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) invalid('batch ledger is malformed; preserve private state and inspect the protocol');
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return { schema: 'session-correction-analysis/batch-ledger/v1', manifest_hash: input instanceof BatchReadContext ? input.manifest_hash : stableHash(manifest), revision: 0, history: [] };
  }
}

export async function submitBatch(root: string, batchId: string, input: unknown): Promise<{ duplicate: boolean; revision: number }> {
  const submission: BatchSubmission = batchSubmissionSchema.parse(input);
  return withAdvisoryLock(resolvePaths(root), `batch-${batchIdSchema.parse(batchId)}`, async () => {
    const manifest = await loadBatch(root, batchId);
    const ledger = await readLedger(root, manifest);
    if (submission.manifest_hash !== stableHash(manifest)) invalid('submission snapshot mismatch');
    const requestHash = stableHash(submission);
    const replay = ledger.history.find(entry => entry.request_id === submission.request_id);
    if (replay !== undefined) {
      if (replay.request_hash !== requestHash) invalid('request id payload conflict');
      return { duplicate: true, revision: ledger.revision };
    }
    const evidence = new Map(manifest.sources.flatMap(source => source.events.map(event => [event.evidence_id, event] as const)));
    const seen = new Set<string>();
    for (const judgment of submission.judgments) {
      validateReworkClaim(manifest, judgment);
      const target = manifest.targets.find(item => item.target_id === judgment.target_id);
      if (target === undefined || seen.has(judgment.target_id)) invalid('unknown or duplicate target');
      seen.add(judgment.target_id);
      const version = ledger.history.reduce((sum, entry) => sum + Number(entry.judgments.some(item => item.target_id === judgment.target_id)), 0);
      if (judgment.expected_version !== version) throw new ScaError('revision_conflict');
      if (!judgment.inspected_evidence_ids.includes(target.evidence_id) || judgment.inspected_evidence_ids.some(id => !evidence.has(id)) || judgment.unresolved_evidence_ids.some(id => !evidence.has(id))) invalid('inspection references must include target and known evidence');
      if (judgment.judgment !== 'uncertain' && (judgment.evidence_status !== 'sufficient' || judgment.unresolved_evidence_ids.length > 0)) invalid('unresolved evidence requires uncertain judgment');
      if ((judgment.judgment === 'positive') !== ['correction', 'intervention'].includes(judgment.classification) || ((judgment.judgment === 'uncertain') !== (judgment.classification === 'unresolved'))) invalid('classification conflicts with judgment');
      if (judgment.reading === 'reused_exact') {
        invalid('semantic reuse is disabled until independent source identity and context verification are implemented; inspect each target');
      } else if (judgment.reuse_target_id !== undefined) invalid('reuse reference requires reused_exact');
      if (judgment.judgment === 'positive' && !judgment.citations.some(citation => citation.evidence_id === target.evidence_id)) invalid('positive judgment requires target citation');
      for (const citation of judgment.citations) {
        const item = evidence.get(citation.evidence_id);
        if (item === undefined || !judgment.inspected_evidence_ids.includes(citation.evidence_id) || !(item.event.text ?? '').includes(citation.quote)) throw new ScaError('citation_mismatch');
      }
    }
    const next = ledgerSchema.parse({ ...ledger, revision: ledger.revision + 1,
      history: [...ledger.history, { request_id: submission.request_id, request_hash: requestHash, judgments: submission.judgments,
        ...(submission.schema === 'session-correction-analysis/batch-submission/v2' ? { submission_schema: submission.schema } : {}) }] });
    await atomicWriteText(directory(root, batchId), 'ledger.json', stableStringify(next), 0o600);
    return { duplicate: false, revision: next.revision };
  });
}

export interface BatchStatus {
  manifest_hash: string; revision: number; targets: number; inspected: number;
  semantic_complete: number; pending: number; uncertain: number; source_partial: number;
  coverage: 'partial' | 'full'; audit_limit: string;
  labels: { correction: number; intervention: number; intersection: number; positive_targets: number };
  actor_coverage: { role: SourceSnapshot['input']['role']; targets: number; submitted: number;
    sufficient: number; pending: number; uncertain: number; partial_sources: number; submitted_coverage: number | null }[];
}

export async function batchStatus(root: string, batchId: string): Promise<BatchStatus> {
  const context = await loadBatchReadContext(root, batchId);
  return batchStatusFromContext(context, await readLedger(root, context));
}

export function batchStatusFromContext(context: BatchReadContext, ledgerInput: unknown): BatchStatus {
  const manifest = context.manifest;
  const ledger = validateLedger(ledgerInput, context);
  const current = currentJudgments(ledger);
  const complete = [...current.values()].filter(item => item.judgment !== 'uncertain' && item.evidence_status === 'sufficient' && item.unresolved_evidence_ids.length === 0).length;
  const positives = [...current.values()].filter(item => item.judgment === 'positive');
  const labelPairs = positives.map(item => 'labels' in item ? item.labels : {
    correction: item.classification === 'correction', intervention: item.classification === 'intervention',
  });
  const labelCounts = { correction: labelPairs.filter(item => item.correction).length,
    intervention: labelPairs.filter(item => item.intervention).length,
    intersection: labelPairs.filter(item => item.correction && item.intervention).length, positive_targets: positives.length };
  const partial = manifest.sources.filter(source => source.coverage !== 'full').length;
  const actorCoverage = (['direct', 'automation', 'subagent', 'guardian', 'unknown'] as const).map(role => {
    const sources = manifest.sources.filter(source => source.input.role === role);
    const ids = new Set(sources.map(source => source.source_id));
    const targets = manifest.targets.filter(target => ids.has(target.source_id));
    const submitted = targets.flatMap(target => {
      const judgment = current.get(target.target_id);
      return judgment === undefined ? [] : [judgment];
    });
    const sufficient = submitted.filter(item => item.judgment !== 'uncertain' && item.evidence_status === 'sufficient' && item.unresolved_evidence_ids.length === 0).length;
    return { role, targets: targets.length, submitted: submitted.length, sufficient, pending: targets.length - submitted.length,
      uncertain: submitted.filter(item => item.judgment === 'uncertain').length, partial_sources: sources.filter(source => source.coverage === 'partial').length,
      submitted_coverage: targets.length === 0 ? null : sufficient / targets.length };
  });
  return { manifest_hash: context.manifest_hash, revision: ledger.revision, targets: manifest.targets.length,
    inspected: current.size, semantic_complete: complete, pending: manifest.targets.length - current.size,
    uncertain: [...current.values()].filter(item => item.judgment === 'uncertain').length,
    source_partial: partial, coverage: complete === manifest.targets.length && partial === 0 ? 'full' : 'partial',
    actor_coverage: actorCoverage, labels: labelCounts,
    audit_limit: 'Coverage validates submitted claims, not actual model reading; source roles and parent identities require independent verification. No candidate decisions are changed.' };
}
