import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  candidateSchema,
  candidateSubmissionSchema,
  type Candidate,
  type CandidateSubmission,
} from '../domain/candidates.js';
import type { AnalyzeDocument, AnalyzeFacts, CandidatesDocument } from '../domain/documents.js';
import { ScaError } from '../domain/errors.js';
import {
  episodeCommittedSchema,
  episodeSubmissionSchema,
  evidenceItemSchema,
  processedUserSchema,
  type EpisodeCommitted,
  type EpisodeSubmission,
  type EvidenceItem,
} from '../domain/episodes.js';
import { sha256HashSchema } from '../domain/hash.js';
import { computeCandidateFingerprint, computeEpisodeId, nextCandidateId, type CandidateId } from '../domain/ids.js';
import { DEFAULT_LEASE_TTL_MS, INGEST_MAX_CORRECTIVE_RESUBMISSIONS, PENDING_COMMIT_MAX_BYTES } from '../domain/limits.js';
import { assertTextBudget } from '../store/bounded.js';
import { runRecordSchema, snapshotSchema, type Snapshot } from '../domain/snapshot.js';
import type { RunFence } from '../store/commit.js';
import { isLeaseExpired } from '../store/commit.js';
import type { LoadedFile, RecordRepository } from '../store/repository.js';
import { PREPARE_SCHEMA, packetInputHash, type PreparePacket, type UserCoverageEntry } from './prepare.js';
import type { EditSignal } from './rework.js';
import { assertTranscriptIdentity } from '../hosts/index.js';

/** Root of what the host agent may submit; zod stays the runtime authority (design 22.3). */
export const submissionRootSchema = z
  .object({
    episodes: z.array(episodeSubmissionSchema),
    candidates: z.array(candidateSubmissionSchema),
    processed_users: z.array(processedUserSchema).optional(),
  })
  .strict();
export type SubmissionRoot = z.infer<typeof submissionRootSchema>;

/** Defensive re-check of the advisory signals prepare derived deterministically. */
export const editSignalSchema = z
  .object({
    evidence_id: z.string().min(1),
    event_id: z.string().min(1),
    line: z.number().int().nonnegative(),
    role: z.enum(['change', 'result']),
    call_id: z.string().min(1).optional(),
    paths: z.array(z.string()),
    region_keys: z.array(z.string()),
    success: z.boolean().optional(),
  })
  .strict();

export interface IngestManifest {
  record_id: string;
  analysis_id: string;
  run_id: string;
  duplicate: boolean;
  episode_ids: string[];
  new_candidate_ids: string[];
  duplicate_candidates_skipped: number;
}

interface PacketBundle {
  packet: PreparePacket;
  evidence: Map<string, EvidenceItem>;
  userAnchorByEvidence: Map<string, string>;
  attemptsPath: string;
}

function packetPathFor(repo: RecordRepository, recordId: string, runId: string): string {
  return path.join(repo.paths.runtimeDir, 'packets', recordId, `${runId}.json`);
}

function assertSafeRunId(runId: string): void {
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..') || runId.length === 0) {
    throw new ScaError('schema_invalid', 'run id contains unsafe path characters');
  }
}

function isPacketShaped(value: Record<string, unknown>): boolean {
  return (
    value['schema'] === PREPARE_SCHEMA &&
    typeof value['record_id'] === 'string' &&
    typeof value['run_id'] === 'string' &&
    typeof value['analysis_id'] === 'string' &&
    typeof value['prepared_at'] === 'string' &&
    typeof value['lease_generation'] === 'number' &&
    Number.isInteger(value['lease_generation']) &&
    typeof value['snapshot'] === 'object' &&
    Array.isArray(value['evidence']) &&
    Array.isArray(value['user_coverage']) &&
    Array.isArray(value['blocks']) &&
    typeof value['input_hash'] === 'string'
  );
}

/** Loads and deep-validates the frozen packet an earlier prepare wrote for this run. */
export async function loadPacket(repo: RecordRepository, recordId: string, runId: string): Promise<PacketBundle> {
  assertSafeRunId(runId);
  const filePath = packetPathFor(repo, recordId, runId);
  const raw = await fs.readFile(filePath, 'utf8').catch(() => undefined);
  if (raw === undefined) {
    throw new ScaError('schema_invalid', `no prepare packet for run ${runId}; run prepare first`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScaError('schema_invalid', `prepare packet for run ${runId} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || !isPacketShaped(parsed as Record<string, unknown>)) {
    throw new ScaError('schema_invalid', `prepare packet for run ${runId} failed its shape check; prepare again`);
  }
  const value = parsed as Record<string, unknown>;
  if (!sha256HashSchema.safeParse(value['input_hash']).success) {
    throw new ScaError('schema_invalid', `prepare packet for run ${runId} carries a malformed input_hash`);
  }
  const evidenceList = (value['evidence'] as unknown[]).map((item) => evidenceItemSchema.parse(item));
  const snapshot = snapshotSchema.parse(value['snapshot']);
  const userCoverage = (value['user_coverage'] as unknown[]).map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new ScaError('schema_invalid', 'user_coverage entry is not an object');
    }
    const entry: Record<string, unknown> = item as Record<string, unknown>;
    if (typeof entry['event_id'] !== 'string' || typeof entry['evidence_id'] !== 'string') {
      throw new ScaError('schema_invalid', 'user_coverage entries need string event_id and evidence_id');
    }
    return {
      event_id: entry['event_id'],
      evidence_id: entry['evidence_id'],
      primary_block: typeof entry['primary_block'] === 'number' ? entry['primary_block'] : 0,
    } satisfies UserCoverageEntry;
  });
  const rawSignals = value['edit_signals'];
  let editSignals: EditSignal[] | undefined;
  const signalList = Array.isArray(rawSignals) ? (rawSignals as unknown[]) : [];
  if (signalList.length > 0) {
    const parsedSignals = z.array(editSignalSchema).safeParse(signalList);
    if (!parsedSignals.success) {
      throw new ScaError('schema_invalid', `prepare packet for run ${runId} carries malformed edit_signals; prepare again`);
    }
    editSignals = parsedSignals.data;
  }
  const packet: PreparePacket = {
    schema: PREPARE_SCHEMA,
    record_id: value['record_id'] as string,
    run_id: value['run_id'] as string,
    analysis_id: value['analysis_id'] as string,
    input_hash: value['input_hash'] as string,
    snapshot,
    rule_version: typeof value['rule_version'] === 'string' ? value['rule_version'] : '',
    prompt_hash: value['prompt_hash'] as string,
    prepared_at: value['prepared_at'] as string,
    evidence: evidenceList,
    user_coverage: userCoverage,
    blocks: value['blocks'] as PreparePacket['blocks'],
    existing_candidates: [],
    submission_schema: value['submission_schema'],
    lease_generation: value['lease_generation'] as number,
    ...(editSignals !== undefined ? { edit_signals: editSignals } : {}),
  };
  if (packet.record_id !== recordId || packet.run_id !== runId) {
    throw new ScaError('schema_invalid', 'prepare packet identity does not match the requested record/run');
  }
  if (packetInputHash(packet) !== packet.input_hash) {
    throw new ScaError('schema_invalid', 'prepare packet integrity mismatch; discard it and prepare a new run');
  }
  const evidence = new Map(evidenceList.map((item) => [item.id, item]));
  const userAnchorByEvidence = new Map(userCoverage.map((entry) => [entry.evidence_id, entry.event_id]));
  return {
    packet,
    evidence,
    userAnchorByEvidence,
    attemptsPath: `${filePath}.attempts.json`,
  };
}

async function readSchemaRejections(attemptsPath: string): Promise<number> {
  const raw = await fs.readFile(attemptsPath, 'utf8').catch(() => undefined);
  if (raw === undefined) {
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>)['schema_rejections'] === 'number') {
      return (parsed as Record<string, number>)['schema_rejections'] ?? 0;
    }
  } catch {
    return 0;
  }
  return 0;
}

/**
 * Schema-class failures get exactly INGEST_MAX_CORRECTIVE_RESUBMISSIONS bounded
 * retries per run (design 22.3); fact/evidence errors are rejected outright and
 * never consume this budget.
 */
async function rejectSchema(detail: string, attemptsPath: string): Promise<never> {
  const used = await readSchemaRejections(attemptsPath);
  await fs.writeFile(attemptsPath, JSON.stringify({ schema_rejections: used + 1 }), 'utf8');
  if (used >= INGEST_MAX_CORRECTIVE_RESUBMISSIONS) {
    throw new ScaError(
      'schema_invalid',
      `${detail} | corrective resubmission budget (${String(INGEST_MAX_CORRECTIVE_RESUBMISSIONS)} per run) exhausted; prepare a fresh run`,
    );
  }
  throw new ScaError(
    'schema_invalid',
    `${detail} | ${String(INGEST_MAX_CORRECTIVE_RESUBMISSIONS - used)} corrective resubmission(s) left for this run`,
  );
}

async function assertBudgetOpen(attemptsPath: string): Promise<void> {
  const used = await readSchemaRejections(attemptsPath);
  if (used > INGEST_MAX_CORRECTIVE_RESUBMISSIONS) {
    throw new ScaError(
      'schema_invalid',
      `corrective resubmission budget (${String(INGEST_MAX_CORRECTIVE_RESUBMISSIONS)} per run) exhausted; prepare a fresh run`,
    );
  }
}

function requireEvidence(
  label: string,
  ids: readonly string[],
  evidence: Map<string, EvidenceItem>,
  cited: Set<string>,
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const id of ids) {
    const item = evidence.get(id);
    if (item === undefined) {
      throw new ScaError('evidence_not_found', `${label}: evidence id ${id} is not part of the frozen packet`);
    }
    cited.add(id);
    items.push(item);
  }
  return items;
}

function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const REWORK_CLAIMS = new Set(['undone', 'replaced', 'fixed']);

function checkCitations(index: number, episode: EpisodeSubmission, evidence: Map<string, EvidenceItem>): void {
  for (const [c, citation] of episode.citations.entries()) {
    const item = evidence.get(citation.evidence_id);
    if (item === undefined) {
      throw new ScaError(
        'evidence_not_found',
        `episode ${String(index)} citation ${String(c)}: unknown evidence id ${citation.evidence_id}`,
      );
    }
    if (!normalizeQuote(item.excerpt).includes(normalizeQuote(citation.quote))) {
      throw new ScaError(
        'citation_mismatch',
        `episode ${String(index)} citation ${String(c)}: quote does not match evidence ${citation.evidence_id}`,
      );
    }
  }
}

function checkEpisodeOrdering(
  index: number,
  episode: EpisodeSubmission,
  anchor: EvidenceItem,
  evidence: Map<string, EvidenceItem>,
): void {
  const anchorLine = anchor.source_ref.line;
  if (anchorLine === undefined) {
    return;
  }
  const linesFor = (ids: readonly string[]): number[] =>
    ids
      .map((id) => evidence.get(id)?.source_ref.line)
      .filter((line): line is number => typeof line === 'number');
  const prior = linesFor(episode.correction.prior_agent_behavior);
  const after = linesFor(episode.correction.agent_behavior_after);
  if (prior.some((line) => line >= anchorLine) || after.some((line) => line <= anchorLine)) {
    throw new ScaError(
      'schema_invalid',
      `episode ${String(index)}: prior/after agent behavior crosses the anchor user message (design 22.3 ordering)`,
    );
  }
}

function checkReworkClaim(index: number, episode: EpisodeSubmission, evidence: Map<string, EvidenceItem>): void {
  const rework = episode.correction.rework;
  if (rework === undefined || !REWORK_CLAIMS.has(rework.outcome)) {
    return;
  }
  const items = rework.evidence.map((id) => evidence.get(id)).filter((item) => item !== undefined);
  const hasConcreteChange = items.some((item) => item !== undefined && (item.kind === 'file_edit' || item.kind === 'tool_result'));
  if (!hasConcreteChange) {
    throw new ScaError(
      'schema_invalid',
      `episode ${String(index)}: rework outcome "${rework.outcome}" needs file_edit/tool_result evidence; no successful tool result, no claim (design 22.3)`,
    );
  }
}

/**
 * Corroborate a rework claim against the deterministic edit signals (design 23.3).
 * A completed rework requires paired successful changes. Hosts without edit
 * evidence can still submit the correction, with rework unknown or omitted.
 */
function corroborateRework(
  index: number,
  episode: EpisodeSubmission,
  anchorLine: number | undefined,
  signals: readonly EditSignal[],
): void {
  const rework = episode.correction.rework;
  if (rework === undefined || !REWORK_CLAIMS.has(rework.outcome)) {
    return;
  }
  const changes = signals.filter((signal) => signal.role === 'change');
  if (changes.length === 0) {
    throw new ScaError('schema_invalid', 'completed rework needs successful edit evidence on both sides; use unknown when edits are unavailable');
  }
  const cited = new Set(rework.evidence);
  if (!changes.some((signal) => cited.has(signal.evidence_id))) {
    throw new ScaError(
      'schema_invalid',
      `episode ${String(index)}: rework claim cites no edit signal, but the frozen packet contains edit evidence (design 23.3)`,
    );
  }
  if (anchorLine === undefined) {
    return;
  }
  const valid = changes.filter((signal) => signal.success === true);
  const before = valid.filter((signal) => signal.line < anchorLine);
  const after = valid.filter((signal) => signal.line > anchorLine);
  if (before.length === 0 || after.length === 0) {
    throw new ScaError(
      'schema_invalid',
      `episode ${String(index)}: rework outcome "${rework.outcome}" needs a successful edit on both sides of the anchor correction`,
    );
  }
  const beforePaths = new Set(before.flatMap((signal) => signal.paths));
  const afterPaths = new Set(after.flatMap((signal) => signal.paths));
  const overlaps = [...beforePaths].some((target) => afterPaths.has(target));
  if (beforePaths.size > 0 && afterPaths.size > 0 && !overlaps) {
    throw new ScaError(
      'schema_invalid',
      `episode ${String(index)}: edits before and after the anchor touch disjoint paths; this is not the same reworked artifact (design 23.3)`,
    );
  }
}

function commitEpisodes(
  recordId: string,
  packet: PreparePacket,
  episodes: readonly EpisodeSubmission[],
  evidence: Map<string, EvidenceItem>,
  userAnchorByEvidence: Map<string, string>,
  cited: Set<string>,
): { committed: EpisodeCommitted[]; anchorToEpisodeId: Map<string, string> } {
  const committed: EpisodeCommitted[] = [];
  const anchorToEpisodeId = new Map<string, string>();
  const now = new Date().toISOString();
  for (const [index, episode] of episodes.entries()) {
    const anchor = evidence.get(episode.anchor_event_id);
    if (anchor === undefined) {
      throw new ScaError('evidence_not_found', `episode ${String(index)}: anchor ${episode.anchor_event_id} is not in the frozen packet`);
    }
    const anchorEventId = userAnchorByEvidence.get(episode.anchor_event_id);
    if (anchorEventId === undefined) {
      throw new ScaError(
        'schema_invalid',
        `episode ${String(index)}: anchor must reference a user-message evidence id from the packet coverage list`,
      );
    }
    cited.add(episode.anchor_event_id);
    requireEvidence(`episode ${String(index)} prior`, episode.correction.prior_agent_behavior, evidence, cited);
    requireEvidence(`episode ${String(index)} after`, episode.correction.agent_behavior_after, evidence, cited);
    requireEvidence(`episode ${String(index)} intervention`, episode.intervention.evidence, evidence, cited);
    if (episode.correction.rework !== undefined) {
      requireEvidence(`episode ${String(index)} rework`, episode.correction.rework.evidence, evidence, cited);
    }
    for (const citation of episode.citations) {
      cited.add(citation.evidence_id);
    }
    checkCitations(index, episode, evidence);
    checkEpisodeOrdering(index, episode, anchor, evidence);
    checkReworkClaim(index, episode, evidence);
    corroborateRework(index, episode, anchor.source_ref.line, packet.edit_signals ?? []);
    const id = computeEpisodeId(recordId, anchorEventId, episode.issue_anchor);
    if (committed.some((existing) => existing.id === id)) {
      throw new ScaError('schema_invalid', `episode ${String(index)}: duplicate episode id ${id} in one submission`);
    }
    anchorToEpisodeId.set(JSON.stringify([episode.anchor_event_id, episode.issue_anchor]), id);
    // A legacy message-only anchor remains usable only when it names one issue.
    anchorToEpisodeId.set(episode.anchor_event_id, anchorToEpisodeId.has(episode.anchor_event_id) ? '' : id);
    committed.push(
      episodeCommittedSchema.parse({
        ...episode,
        id,
        run_id: packet.run_id,
        recorded_at: now,
      }),
    );
  }
  return { committed, anchorToEpisodeId };
}

/**
 * Marks existing candidates whose cited evidence fell outside the freshly frozen
 * packet (e.g. a shrinking partial range). Human decisions are never touched —
 * only a `needs_review` flag is added so review UIs can dim and prompt re-checks
 * (design 23.3 / 24.4: re-running an analysis must preserve manual decisions).
 */
async function flagStaleCandidates(
  repo: RecordRepository,
  recordId: string,
  candidates: LoadedFile<CandidatesDocument>,
  packet: PreparePacket,
): Promise<LoadedFile<CandidatesDocument>> {
  const known = new Set(packet.evidence.map((item) => item.id));
  const isStale = (candidate: Candidate): boolean =>
    candidate.needs_review === undefined && candidate.evidence.some((id) => !known.has(id));
  if (!candidates.doc.candidates.some(isStale)) {
    return candidates;
  }
  const now = new Date().toISOString();
  return repo.updateCandidates(recordId, candidates, (file) => ({
    ...file,
    candidates: file.candidates.map((candidate) =>
      isStale(candidate)
        ? {
            ...candidate,
            needs_review: {
              reason: 'cited evidence is absent from the latest frozen packet; re-verify before trusting this candidate',
              flagged_at: now,
            },
            updated_at: now,
          }
        : candidate,
    ),
  }));
}

function planCandidates(
  candidates: readonly CandidateSubmission[],
  existing: CandidatesDocument,
  anchorToEpisodeId: Map<string, string>,
  evidence: Map<string, EvidenceItem>,
  cited: Set<string>,
): { planned: Candidate[]; skipped: number } {
  const existingFingerprints = new Set(existing.candidates.map((candidate) => candidate.fingerprint));
  const existingIds = existing.candidates.map((candidate) => candidate.id);
  const seen = new Set<string>();
  const assigned: CandidateId[] = [];
  const planned: Candidate[] = [];
  let skipped = 0;
  const now = new Date().toISOString();
  for (const [index, submission] of candidates.entries()) {
    requireEvidence(`candidate ${String(index)}`, submission.evidence, evidence, cited);
    const key = submission.source_issue_anchor === undefined ? submission.source_episode_anchor
      : JSON.stringify([submission.source_episode_anchor, submission.source_issue_anchor]);
    const episodeId = anchorToEpisodeId.get(key);
    if (episodeId === undefined || episodeId === '') {
      throw new ScaError(
        'schema_invalid',
        `candidate ${String(index)}: source_episode_anchor must name one submitted episode; multiple issues require source_issue_anchor`,
      );
    }
    // Routing metadata must not duplicate an otherwise identical legacy candidate.
    const fingerprint = computeCandidateFingerprint({ ...submission, source_issue_anchor: undefined });
    if (existingFingerprints.has(fingerprint) || seen.has(fingerprint)) {
      skipped += 1;
      continue;
    }
    seen.add(fingerprint);
    const id = nextCandidateId([...existingIds, ...assigned]);
    assigned.push(id);
    planned.push(
      candidateSchema.parse({
        id,
        fingerprint,
        category: submission.category,
        title: submission.title,
        confidence: submission.confidence,
        status: 'proposed',
        maturity: 'single_session',
        // Routing refinement (harness path / memory scope) is a review-stage concern; T13 re-targets.
        target: { kind: 'harness' },
        evidence: submission.evidence,
        source_episodes: [episodeId],
        proposed_content: submission.proposed_content,
        ...(submission.applicable_scope !== undefined ? { applicable_scope: submission.applicable_scope } : {}),
        ...(submission.trigger_condition !== undefined ? { trigger_condition: submission.trigger_condition } : {}),
        ...(submission.exceptions !== undefined ? { exceptions: submission.exceptions } : {}),
        ...(submission.not_applicable !== undefined ? { not_applicable: submission.not_applicable } : {}),
        created_at: now,
        updated_at: now,
      }),
    );
  }
  return { planned, skipped };
}

async function ensureRunLease(
  repo: RecordRepository,
  recordId: string,
  doc: AnalyzeDocument,
  packet: PreparePacket,
  owner: string,
): Promise<RunFence> {
  const generation = packet.lease_generation ?? -1;
  const lease = doc.lease;
  if (
    lease !== null &&
    lease !== undefined &&
    lease.run_id === packet.run_id &&
    lease.generation === generation &&
    !isLeaseExpired(lease)
  ) {
    return { runId: packet.run_id, generation };
  }
  if (lease !== null && lease !== undefined && lease.run_id !== packet.run_id) {
    throw new ScaError(
      'lease_expired',
      'another run holds or has superseded the lease on this record; this packet is stale and its result is rejected',
    );
  }
  const renewed = await repo.acquireLease(recordId, {
    runId: packet.run_id,
    owner,
    ttlMs: DEFAULT_LEASE_TTL_MS,
  });
  if (renewed.generation !== generation) {
    throw new ScaError(
      'lease_expired',
      'this packet was prepared under an older lease generation; its runner is stale and its result is rejected',
    );
  }
  return { runId: packet.run_id, generation: renewed.generation };
}

function buildFacts(packet: PreparePacket, doc: AnalyzeDocument, episodes: EpisodeCommitted[], cited: Set<string>,
  existing: readonly Candidate[], planned: readonly Candidate[], processed: SubmissionRoot['processed_users']): AnalyzeFacts {
  const snapshot: Snapshot = processed === undefined ? { ...packet.snapshot, coverage: 'partial' } : packet.snapshot;
  const runs = doc.facts?.runs ?? [];
  const sources = new Map((doc.facts?.candidate_sources ?? []).map((source) => [source.candidate_id, source]));
  const preserve = (candidate: Candidate, pool: readonly EpisodeCommitted[], evidence: readonly EvidenceItem[]): void => {
    if (sources.has(candidate.id)) return;
    const related = pool.filter((episode) => candidate.source_episodes.includes(episode.id));
    const ids = new Set(candidate.evidence);
    for (const episode of related) {
      for (const id of [episode.anchor_event_id, ...episode.correction.prior_agent_behavior,
        ...episode.correction.agent_behavior_after, ...(episode.correction.rework?.evidence ?? []),
        ...episode.intervention.evidence, ...episode.citations.map((citation) => citation.evidence_id)]) ids.add(id);
    }
    sources.set(candidate.id, { candidate_id: candidate.id, episodes: related, evidence: evidence.filter((item) => ids.has(item.id)) });
  };
  for (const candidate of existing) preserve(candidate, doc.facts?.episodes ?? [], doc.facts?.evidence ?? []);
  for (const candidate of planned) preserve(candidate, episodes, packet.evidence);
  return {
    snapshot,
    episodes,
    evidence: packet.evidence.filter((item) => cited.has(item.id)),
    candidate_sources: [...sources.values()],
    processed_users: processed ?? [],
    parse_errors: [],
    runs: runs.concat(
      runRecordSchema.parse({
        run_id: packet.run_id,
        input_hash: packet.input_hash,
        status: 'ingested',
        started_at: packet.prepared_at,
        finished_at: new Date().toISOString(),
      }),
    ),
  };
}

/**
 * CLI/Skill `ingest` (design 21.1 step 4): re-validate the model submission
 * against the frozen packet — evidence existence, quote fidelity, ordering,
 * rework claims, authority fields — then run the two-file commit under the
 * prepare-time lease fence.
 */
export async function ingestSubmission(
  repo: RecordRepository,
  recordId: string,
  runId: string,
  rawSubmission: string,
  owner = 'ingest',
): Promise<IngestManifest> {
  assertTextBudget(rawSubmission, PENDING_COMMIT_MAX_BYTES);
  const bundle = await loadPacket(repo, recordId, runId);
  const { packet, evidence, userAnchorByEvidence, attemptsPath } = bundle;

  await assertBudgetOpen(attemptsPath);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawSubmission);
  } catch {
    return rejectSchema('submission is not valid JSON', attemptsPath);
  }
  const rootResult = submissionRootSchema.safeParse(parsedJson);
  if (!rootResult.success) {
    const detail = rootResult.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return rejectSchema(`submission failed the schema (${detail})`, attemptsPath);
  }
  const root: SubmissionRoot = rootResult.data;
  if (root.processed_users !== undefined) {
    const expected = new Set(packet.user_coverage.map((entry) => entry.evidence_id));
    const seen = new Set<string>();
    for (const unit of root.processed_users) {
      if (!expected.has(unit.evidence_id) || seen.has(unit.evidence_id)) {
        throw new ScaError('schema_invalid', 'processed_users contains an unknown or duplicate user evidence id');
      }
      seen.add(unit.evidence_id);
    }
    if (seen.size !== expected.size) {
      throw new ScaError('schema_invalid', 'processed_users must cover every user message; omissions are not abstentions');
    }
  }

  const { analyze, candidates } = await repo.loadRecord(recordId);
  const doc = analyze.doc;
  await assertTranscriptIdentity(packet.snapshot, { host: doc.source, sessionId: doc.session_id });
  const pinnedHash = doc.lease?.run_id === packet.run_id ? doc.lease.input_hash
    : doc.facts?.runs.find((run) => run.run_id === packet.run_id)?.input_hash;
  if (doc.analysis_id === packet.analysis_id && doc.analysis_status === 'completed') {
    if (pinnedHash !== packet.input_hash) throw new ScaError('schema_invalid', 'completed run input digest mismatch');
    return {
      record_id: recordId,
      analysis_id: packet.analysis_id,
      run_id: packet.run_id,
      duplicate: true,
      episode_ids: [],
      new_candidate_ids: [],
      duplicate_candidates_skipped: 0,
    };
  }

  const fence = await ensureRunLease(repo, recordId, doc, packet, owner);
  if (pinnedHash !== packet.input_hash) {
    throw new ScaError('schema_invalid', 'prepare packet does not match the input digest pinned in the record');
  }
  const cited = new Set<string>();
  const { committed, anchorToEpisodeId } = commitEpisodes(
    recordId,
    packet,
    root.episodes,
    evidence,
    userAnchorByEvidence,
    cited,
  );
  const candidatesView = await flagStaleCandidates(repo, recordId, candidates, packet);
  const { planned, skipped } = planCandidates(root.candidates, candidatesView.doc, anchorToEpisodeId, evidence, cited);
  const facts = buildFacts(packet, doc, committed, cited, candidatesView.doc.candidates, planned, root.processed_users);

  await repo.beginCommit(recordId, fence, {
    analysisId: packet.analysis_id,
    inputDigest: packet.input_hash,
    facts,
    candidates: planned,
  });
  await repo.applyCommit(recordId, fence);

  return {
    record_id: recordId,
    analysis_id: packet.analysis_id,
    run_id: packet.run_id,
    duplicate: false,
    episode_ids: committed.map((episode) => episode.id),
    new_candidate_ids: planned.map((candidate) => candidate.id),
    duplicate_candidates_skipped: skipped,
  };
}
