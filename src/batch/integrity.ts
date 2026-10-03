import { createHash } from 'node:crypto';

import { BatchReadContext } from './runtime.js';
import { validateReworkClaim } from './rework-validation.js';
import { ScaError } from '../domain/errors.js';
import { sha256Tag, stableHash } from '../domain/hash.js';
import { ledgerSchema, manifestSchema, type BatchManifest, type BatchLedger } from './schema.js';

function reject(detail: string): never {
  throw new ScaError('schema_invalid', `batch snapshot integrity: ${detail}`);
}

/** Structural validation alone cannot establish target coverage or frozen-byte consistency. */
export function validateManifest(input: unknown): BatchManifest {
  const manifest = manifestSchema.parse(input);
  const sources = new Set<string>();
  const evidence = new Map<string, { text: string; target: boolean; source: string }>();
  const expectedTargets = new Map<string, { source: string; evidence: string }>();
  for (const source of manifest.sources) {
    if (sources.has(source.source_id)) reject('duplicate source id');
    sources.add(source.source_id);
    const bytes = Buffer.from(source.frozen_bytes_base64, 'base64');
    if (bytes.toString('base64') !== source.frozen_bytes_base64) reject('noncanonical frozen bytes');
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.length !== source.byte_length || hash !== source.source_hash) reject('frozen bytes mismatch');
    if (source.source_id !== `src-${stableHash({ input: source.input, sourceHash: hash }).slice(7)}`) reject('source identity mismatch');
    const created = Date.parse(source.input.created_at);
    if (created < Date.parse(manifest.scope.start) || created >= Date.parse(manifest.scope.end)) reject('source outside scope');
    if (source.parent_status !== (source.input.parent_session_id === undefined ? 'not_declared' : 'unverified')) reject('parent status mismatch');
    if (source.coverage === 'full' && (source.excluded_sidechain_records !== 0 || source.compacted_records !== 0)) reject('full source contains excluded records');
    for (const [index, indexed] of source.events.entries()) {
      const text = indexed.event.text ?? '';
      if (indexed.body_hash !== sha256Tag(text)) reject('body hash mismatch');
      const id = `ev-${stableHash([source.source_id, index, indexed.event]).slice(7)}`;
      if (indexed.evidence_id !== id || evidence.has(id)) reject('evidence identity mismatch');
      if (indexed.reading_reuse_of !== undefined) {
        const prior = evidence.get(indexed.reading_reuse_of);
        if (prior === undefined || prior.text !== text) reject('reading reuse is not an exact prior match');
      }
      const target = indexed.event.kind === 'user_message';
      evidence.set(id, { text, target, source: source.source_id });
      if (target) expectedTargets.set(`target-${stableHash(id).slice(7)}`, { source: source.source_id, evidence: id });
    }
  }
  const seenTargets = new Set<string>();
  for (const target of manifest.targets) {
    const expected = expectedTargets.get(target.target_id);
    if (expected === undefined || expected.source !== target.source_id || expected.evidence !== target.evidence_id || seenTargets.has(target.target_id)) reject('target identity mismatch');
    if (target.reuse_candidate_of !== undefined && !seenTargets.has(target.reuse_candidate_of)) reject('reuse candidate must be a prior target');
    seenTargets.add(target.target_id);
  }
  if (seenTargets.size !== expectedTargets.size) reject('target coverage is incomplete');
  return manifest;
}

export function validateLedger(input: unknown, snapshot: BatchManifest | BatchReadContext): BatchLedger {
  const manifest = snapshot instanceof BatchReadContext ? snapshot.manifest : snapshot;
  const manifestHash = snapshot instanceof BatchReadContext ? snapshot.manifest_hash : stableHash(manifest);
  const ledger = ledgerSchema.parse(input);
  if (ledger.manifest_hash !== manifestHash || ledger.revision !== ledger.history.length) reject('ledger revision or snapshot mismatch');
  const requests = new Set<string>();
  const versions = new Map<string, number>();
  const targets = new Map(manifest.targets.map(target => [target.target_id, target]));
  const evidence = new Map(manifest.sources.flatMap(source => source.events.map(item => [item.evidence_id, item] as const)));
  for (const entry of ledger.history) {
    if (requests.has(entry.request_id) || entry.judgments.length === 0) reject('duplicate request or empty transaction');
    requests.add(entry.request_id);
    if (entry.request_hash !== stableHash({ schema: entry.submission_schema ?? 'session-correction-analysis/batch-submission/v1',
      manifest_hash: ledger.manifest_hash, request_id: entry.request_id, judgments: entry.judgments })) reject('request payload mismatch');
    const seen = new Set<string>();
    for (const judgment of entry.judgments) {
      if ((entry.submission_schema === 'session-correction-analysis/batch-submission/v2') !== ('labels' in judgment)) reject('judgment label protocol mismatch');
      validateReworkClaim(manifest, judgment);
      const target = targets.get(judgment.target_id);
      const version = versions.get(judgment.target_id) ?? 0;
      if (target === undefined || seen.has(judgment.target_id) || judgment.expected_version !== version) reject('invalid target revision chain');
      seen.add(judgment.target_id);
      versions.set(judgment.target_id, version + 1);
      if (judgment.reading !== 'inspected' || judgment.reuse_target_id !== undefined) reject('unsupported semantic reuse');
      if (!judgment.inspected_evidence_ids.includes(target.evidence_id) || judgment.inspected_evidence_ids.some(id => !evidence.has(id)) || judgment.unresolved_evidence_ids.some(id => !evidence.has(id))) reject('unknown inspection evidence');
      if (judgment.judgment !== 'uncertain' && (judgment.evidence_status !== 'sufficient' || judgment.unresolved_evidence_ids.length !== 0)) reject('unresolved evidence with definitive judgment');
      if ((judgment.judgment === 'positive') !== ['correction', 'intervention'].includes(judgment.classification) || ((judgment.judgment === 'uncertain') !== (judgment.classification === 'unresolved'))) reject('invalid classification');
      if (judgment.judgment === 'positive' && !judgment.citations.some(citation => citation.evidence_id === target.evidence_id)) reject('positive without target citation');
      for (const citation of judgment.citations) {
        if (!judgment.inspected_evidence_ids.includes(citation.evidence_id) || !(evidence.get(citation.evidence_id)?.event.text ?? '').includes(citation.quote)) reject('invalid citation');
      }
    }
  }
  return ledger;
}
