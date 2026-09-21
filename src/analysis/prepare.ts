import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Candidate } from '../domain/candidates.js';
import { eventSchema, type Event } from '../domain/events.js';
import { ScaError } from '../domain/errors.js';
import { evidenceItemSchema, type EvidenceItem, type EvidenceKind } from '../domain/episodes.js';
import { sha256Hex, stableHash, stableStringify, type Sha256Hash } from '../domain/hash.js';
import {
  DEFAULT_LEASE_TTL_MS,
  PREPARE_EVENT_MAX_TEXT_CHARS,
  PREPARE_PACKET_MAX_BYTES,
} from '../domain/limits.js';
import { snapshotSchema, type Lease, type Snapshot } from '../domain/snapshot.js';
import { assertTranscriptIdentity, detectFormat } from '../hosts/index.js';
import { adaptClaude } from '../hosts/claude.js';
import { adaptCodex } from '../hosts/codex.js';
import { adaptNormalized } from '../hosts/normalized.js';
import type { NormalizedTranscript } from '../hosts/types.js';
import { atomicWriteText } from '../store/atomic.js';
import type { RunFence } from '../store/commit.js';
import type { RecordRepository } from '../store/repository.js';
import { computeEditSignals, type EditSignal, type ReworkHint } from './rework.js';
import { submissionJsonSchema } from './submission-schema.js';

export const PREPARE_SCHEMA = 'session-correction-analysis/prepare/v2';
export const RULE_VERSION = '0.1.0';

/** Trailing events of the previous turn repeated into the next window (design 23.3). */
const CONTEXT_TAIL_EVENTS = 2;

export interface UserCoverageEntry {
  event_id: string;
  evidence_id: string;
  primary_block: number;
}

export interface PrepareBlock {
  index: number;
  /** User messages owned by this block; every user message appears in exactly one block. */
  primary_user_event_ids: string[];
  evidence_ids: string[];
  /** True when a turn was split across the block boundary; evidence is never dropped. */
  truncated: boolean;
}

export interface ExistingCandidateDigest {
  id: string;
  fingerprint: Sha256Hash;
  title: string;
  status: Candidate['status'];
  maturity: Candidate['maturity'];
}

export interface PreparePacket {
  schema: string;
  record_id: string;
  run_id: string;
  analysis_id: string;
  input_hash: Sha256Hash;
  snapshot: Snapshot;
  rule_version: string;
  prompt_hash: Sha256Hash;
  prepared_at: string;
  evidence: EvidenceItem[];
  user_coverage: UserCoverageEntry[];
  blocks: PrepareBlock[];
  existing_candidates: ExistingCandidateDigest[];
  submission_schema: unknown;
  /** Written by prepareRecord once the lease is held; ingest must refuse packets without it. */
  lease_generation?: number;
  /** Deterministic corroboration signals, included in the v2 integrity digest. */
  edit_signals?: EditSignal[];
  /** Pairing hints between successful changes on the same path; suggestions only, never conclusions. */
  rework_hints?: ReworkHint[];
}

export interface PrepareOptions {
  owner: string;
  runId?: string;
  analysisId?: string;
  ruleVersion?: string;
  hostVersion?: string;
  model?: string;
  ttlMs?: number;
}

/** Hash every field used for evidence validation; exclude only run/time/presentation metadata. */
export function packetInputHash(packet: Pick<PreparePacket, 'record_id' | 'snapshot' | 'evidence' | 'blocks' | 'user_coverage' | 'edit_signals' | 'rule_version' | 'prompt_hash' | 'submission_schema'>): Sha256Hash {
  return stableHash({
    record_id: packet.record_id,
    snapshot: { ...packet.snapshot, captured_at: undefined },
    evidence: packet.evidence,
    blocks: packet.blocks,
    user_coverage: packet.user_coverage,
    edit_signals: packet.edit_signals ?? [],
    rule_version: packet.rule_version,
    prompt_hash: packet.prompt_hash,
    submission_schema: packet.submission_schema,
  });
}

export interface PrepareOutcome {
  packet: PreparePacket;
  packetPath: string;
  fence: RunFence;
  lease: Lease;
  /** The stored fingerprint differs from the freshly frozen one. */
  changed_since_last_analysis: boolean;
}

function newRunId(): string {
  return `run-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function evidenceIdFor(recordId: string, event: Event): string {
  return `ev-${sha256Hex(JSON.stringify([recordId, event.id, event.source_ref.line ?? -1])).slice(0, 16)}`;
}

function evidenceKindFor(event: Event): EvidenceKind {
  switch (event.kind) {
    case 'user_message':
      return 'user_text';
    case 'assistant_message':
      return 'assistant_text';
    case 'tool_call':
      return 'tool_call';
    case 'tool_result':
      return 'tool_result';
    case 'file_edit':
      return 'file_edit';
    case 'interrupt':
      return 'interrupt';
    case 'approval':
      return 'approval';
  }
  return 'other';
}

function excerptFor(event: Event): { excerpt: string; truncated: boolean } {
  const text = event.text ?? '(no text)';
  if (text.length > PREPARE_EVENT_MAX_TEXT_CHARS) {
    return { excerpt: `${text.slice(0, PREPARE_EVENT_MAX_TEXT_CHARS)}…[TRUNCATED]`, truncated: true };
  }
  return { excerpt: text, truncated: false };
}

function buildEvidence(recordId: string, events: readonly Event[]): EvidenceItem[] {
  return events.map((event) => {
    const { excerpt, truncated } = excerptFor(event);
    return evidenceItemSchema.parse({
      id: evidenceIdFor(recordId, event),
      kind: evidenceKindFor(event),
      excerpt,
      source_ref: event.source_ref,
      truncated,
    });
  });
}

interface TurnWindow {
  events: Event[];
}

function buildWindows(events: readonly Event[]): TurnWindow[] {
  const ordered = [...events].sort((a, b) => a.ordinal - b.ordinal);
  const windows: TurnWindow[] = [];
  let preamble: Event[] = [];
  let current: TurnWindow | null = null;
  for (const event of ordered) {
    if (event.kind === 'user_message') {
      current = { events: [...preamble, event] };
      preamble = [];
      windows.push(current);
    } else if (current === null) {
      preamble.push(event);
    } else {
      current.events.push(event);
    }
  }
  if (current === null && preamble.length > 0) {
    windows.push({ events: preamble });
  }
  return windows;
}

function itemCost(item: EvidenceItem): number {
  return Buffer.byteLength(stableStringify(item), 'utf8') + 1;
}

interface Layout {
  blocks: PrepareBlock[];
  coverage: UserCoverageEntry[];
}

function packBlocks(evidence: readonly EvidenceItem[], events: readonly Event[]): Layout {
  const itemByEventId = new Map<string, EvidenceItem>();
  events.forEach((event, position) => {
    const item = evidence[position];
    if (item !== undefined) {
      itemByEventId.set(event.id, item);
    }
  });
  const windows = buildWindows(events);
  const blocks: PrepareBlock[] = [];
  const coverage: UserCoverageEntry[] = [];
  const ownedUsers = new Set<string>();
  let ids: string[] = [];
  let cost = 0;
  let primaries: string[] = [];
  let startedMidTurn = false;

  const flush = (truncated: boolean): void => {
    if (ids.length === 0) {
      return;
    }
    blocks.push({ index: blocks.length, primary_user_event_ids: primaries, evidence_ids: ids, truncated });
    ids = [];
    cost = 0;
    primaries = [];
    startedMidTurn = false;
  };

  for (let w = 0; w < windows.length; w += 1) {
    const window = windows[w] as TurnWindow;
    const previousTail = w > 0 ? ((windows[w - 1] as TurnWindow).events.slice(-CONTEXT_TAIL_EVENTS) ?? []) : [];
    const seen = new Set<string>();
    const referenced: { event: Event; item: EvidenceItem }[] = [];
    for (const event of [...previousTail, ...window.events]) {
      const item = itemByEventId.get(event.id);
      if (item === undefined || seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      referenced.push({ event, item });
    }
    for (const { event, item } of referenced) {
      const c = itemCost(item);
      if (ids.length > 0 && cost + c > PREPARE_PACKET_MAX_BYTES) {
        flush(true);
        startedMidTurn = true;
      }
      if (!ids.includes(item.id)) {
        ids.push(item.id);
        cost += c;
      }
      if (event.kind === 'user_message' && !ownedUsers.has(event.id)) {
        ownedUsers.add(event.id);
        primaries.push(event.id);
        coverage.push({ event_id: event.id, evidence_id: item.id, primary_block: blocks.length });
      }
    }
  }
  flush(startedMidTurn);
  if (blocks.length === 0) {
    blocks.push({ index: 0, primary_user_event_ids: [], evidence_ids: [], truncated: false });
  }
  return { blocks, coverage };
}

async function hashFrozenRange(
  filePath: string,
  byteLength: number,
): Promise<{ fingerprint: Sha256Hash; completeLines: number }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    let completeLines = 0;
    let remaining = byteLength;
    const buffer = Buffer.alloc(64 * 1024);
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) {
        break;
      }
      const slice = buffer.subarray(0, bytesRead);
      for (const byte of slice) {
        if (byte === 0x0a) {
          completeLines += 1;
        }
      }
      hash.update(slice);
      remaining -= bytesRead;
    }
    return { fingerprint: `sha256:${hash.digest('hex')}`, completeLines };
  } finally {
    await handle.close();
  }
}

async function adaptAs(format: 'codex' | 'claude' | 'normalized', filePath: string): Promise<NormalizedTranscript> {
  switch (format) {
    case 'codex':
      return adaptCodex(filePath);
    case 'claude':
      return adaptClaude(filePath);
    case 'normalized':
      return adaptNormalized(filePath);
  }
}

export interface BuildPacketInput {
  expectedIdentity?: Parameters<typeof assertTranscriptIdentity>[1];
  recordId: string;
  runId: string;
  analysisId: string;
  transcriptPath: string;
  ruleVersion: string;
  hostVersion?: string;
  model?: string;
}

/** Freeze the input range and build the ordered packet; takes no lock, mutates no record. */
export async function buildPacket(input: BuildPacketInput): Promise<PreparePacket> {
  const sizeBefore = (await fs.stat(input.transcriptPath)).size;
  const { fingerprint, completeLines } = await hashFrozenRange(input.transcriptPath, sizeBefore);
  const format = await detectFormat(input.transcriptPath);
  const transcript = await adaptAs(format, input.transcriptPath);
  if (input.expectedIdentity !== undefined) {
    await assertTranscriptIdentity(transcript, input.expectedIdentity);
  }
  const sizeAfter = (await fs.stat(input.transcriptPath)).size;
  const afterRead = await hashFrozenRange(input.transcriptPath, sizeBefore);
  if (afterRead.fingerprint !== fingerprint) {
    throw new ScaError('coverage_incomplete', 'transcript frozen prefix changed during prepare; retry with a stable transcript');
  }

  const frozen = transcript.events.filter((event) => (event.source_ref.line ?? 0) <= completeLines);
  const droppedTailEvents = sizeAfter !== sizeBefore || frozen.length < transcript.events.length;
  const ordered = [...frozen].sort((a, b) => a.ordinal - b.ordinal);
  for (const event of ordered) {
    eventSchema.parse(event);
  }

  const evidence = buildEvidence(input.recordId, ordered);
  const coverage = transcript.coverage === 'full' && !droppedTailEvents && !evidence.some((item) => item.truncated)
    ? 'full' : 'partial';
  const layout = packBlocks(evidence, ordered);
  const { signals: editSignals, hints: reworkHints } = computeEditSignals(evidence, ordered);
  const last = ordered[ordered.length - 1];
  const promptHash = stableHash(submissionJsonSchema);
  const snapshotBase = snapshotSchema.parse({
    source_kind:
      format === 'codex' ? 'codex_transcript' : format === 'claude' ? 'claude_transcript' : 'normalized_transcript',
    host: transcript.host,
    source_session_id: transcript.source_session_id,
    coverage,
    cutoff_event_id: last?.id ?? 'empty',
    cutoff_byte_offset: sizeBefore,
    source_fingerprint: fingerprint,
    parser_version: transcript.parser_version,
    rule_version: input.ruleVersion,
    prompt_hash: promptHash,
    ...(input.hostVersion !== undefined ? { host_version: input.hostVersion } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  const inputHash = packetInputHash({
    record_id: input.recordId,
    snapshot: snapshotBase,
    evidence,
    blocks: layout.blocks,
    user_coverage: layout.coverage,
    edit_signals: editSignals,
    rule_version: input.ruleVersion,
    prompt_hash: promptHash,
    submission_schema: submissionJsonSchema,
  });
  // captured_at is presentation metadata; it must never enter input_hash or runs are not comparable.
  const snapshot: Snapshot = { ...snapshotBase, captured_at: new Date().toISOString() };

  return {
    schema: PREPARE_SCHEMA,
    record_id: input.recordId,
    run_id: input.runId,
    analysis_id: input.analysisId,
    input_hash: inputHash,
    snapshot,
    rule_version: input.ruleVersion,
    prompt_hash: promptHash,
    prepared_at: new Date().toISOString(),
    evidence,
    user_coverage: layout.coverage,
    blocks: layout.blocks,
    existing_candidates: [],
    submission_schema: submissionJsonSchema,
    ...(editSignals.length > 0 ? { edit_signals: editSignals } : {}),
    ...(reworkHints.length > 0 ? { rework_hints: reworkHints } : {}),
  };
}

/**
 * CLI/Skill `prepare`: recover, validate/freeze input, bind its digest to the lease,
 * and drop the packet into deletable runtime storage
 * instead of dumping the transcript into tool output.
 */
export async function prepareRecord(
  repo: RecordRepository,
  recordId: string,
  opts: PrepareOptions,
): Promise<PrepareOutcome> {
  const { analyze, candidates } = await repo.loadRecord(recordId);
  const transcriptPath = analyze.doc.transcript_path;
  if (transcriptPath === undefined) {
    throw new ScaError('session_locator_unavailable', `record ${recordId} has no transcript path`);
  }
  const runId = opts.runId ?? newRunId();
  const analysisId = opts.analysisId ?? `analysis-${runId.slice(4)}`;
  const packet = await buildPacket({
    expectedIdentity: { host: analyze.doc.source, sessionId: analyze.doc.session_id,
      ...(analyze.doc.workspace !== undefined ? { workspace: analyze.doc.workspace } : {}) },
    recordId,
    runId,
    analysisId,
    transcriptPath,
    ruleVersion: opts.ruleVersion ?? RULE_VERSION,
    ...(opts.hostVersion !== undefined ? { hostVersion: opts.hostVersion } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });
  const lease = await repo.acquireLease(recordId, {
    runId,
    inputHash: packet.input_hash,
    owner: opts.owner,
    ttlMs: opts.ttlMs ?? DEFAULT_LEASE_TTL_MS,
  });
  const finalPacket: PreparePacket = {
    ...packet,
    lease_generation: lease.generation,
    existing_candidates: candidates.doc.candidates.map((candidate) => ({
      id: candidate.id,
      fingerprint: candidate.fingerprint,
      title: candidate.title,
      status: candidate.status,
      maturity: candidate.maturity,
    })),
  };
  const dir = path.join(repo.paths.runtimeDir, 'packets', recordId);
  await fs.mkdir(dir, { recursive: true });
  const packetPath = path.join(dir, `${runId}.json`);
  await atomicWriteText(dir, `${runId}.json`, JSON.stringify(finalPacket, null, 2));
  return {
    packet: finalPacket,
    packetPath,
    fence: { runId, generation: lease.generation },
    lease,
    changed_since_last_analysis:
      analyze.doc.transcript_fingerprint !== undefined &&
      analyze.doc.transcript_fingerprint !== finalPacket.snapshot.source_fingerprint,
  };
}
