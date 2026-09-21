import fs from 'node:fs/promises';
import path from 'node:path';

import { computeRecordId, type Host } from '../domain/ids.js';
import {
  analyzeDocumentSchema,
  candidatesDocumentSchema,
  pendingCommitSchema,
  SCHEMA_ID,
  type AnalyzeDocument,
  type CandidatesDocument,
  type PendingCommit,
} from '../domain/documents.js';
import { ScaError } from '../domain/errors.js';
import { sha256Tag, type Sha256Hash } from '../domain/hash.js';
import type { Lease } from '../domain/snapshot.js';
import {
  assertFence,
  assertPendingWithinLimit,
  emptyCandidates,
  isLeaseExpired,
  mergePendingCandidates,
  nextGeneration,
  type PendingPayload,
  type RunFence,
} from './commit.js';
import { atomicWriteText } from './atomic.js';
import { parseMarkdownDoc, renderDocument, splitFrontmatter, validateSchema } from './frontmatter.js';
import { assertSingleNotesSection, composeBody, splitBody } from './notes.js';
import { recordDir, resolvePaths, stripTrailingSep, type ScaPaths } from './paths.js';
import { renderAnalyzeProjection, renderCandidatesProjection } from './render.js';
import { withSessionLock } from './lock.js';

export const ANALYZE_FILE = 'analyze.md';
export const CANDIDATES_FILE = 'learning_candidates.md';

export interface LoadedFile<T> {
  doc: T;
  fileHash: Sha256Hash;
}

/** The exact file state a caller baselines its mutation on. */
export type ExpectedState = LoadedFile<{ revision: number }>;

export interface RegisterInput {
  host: Host;
  /** Already canonicalized via canonicalWorkspace(); raw paths are rejected by identity checks. */
  canonicalWorkspace: string;
  sessionId: string;
  transcriptPath: string;
  analyzerVersion: string;
  title?: string;
  projectName?: string;
  trigger: AnalyzeDocument['trigger'];
  fingerprint?: Sha256Hash;
}

export interface RegisterResult {
  recordId: string;
  created: boolean;
  analyze: LoadedFile<AnalyzeDocument>;
  candidates: LoadedFile<CandidatesDocument>;
}

export class RecordRepository {
  readonly paths: ScaPaths;

  constructor(rootDir?: string) {
    this.paths = resolvePaths(rootDir);
  }

  analyzePath(recordId: string): string {
    return path.join(recordDir(this.paths, recordId), ANALYZE_FILE);
  }

  candidatesPath(recordId: string): string {
    return path.join(recordDir(this.paths, recordId), CANDIDATES_FILE);
  }

  async loadAnalyze(recordId: string): Promise<LoadedFile<AnalyzeDocument>> {
    const filePath = this.analyzePath(recordId);
    const text = await this.readOrFail(filePath, recordId);
    const doc = parseMarkdownDoc(text, analyzeDocumentSchema);
    assertAnalyzeIdentity(recordId, doc);
    return { doc, fileHash: sha256Tag(text) };
  }

  async loadCandidates(recordId: string): Promise<LoadedFile<CandidatesDocument>> {
    const filePath = this.candidatesPath(recordId);
    const text = await this.readOrFail(filePath, recordId);
    const doc = parseMarkdownDoc(text, candidatesDocumentSchema);
    assertDerivedCounts(doc);
    return { doc, fileHash: sha256Tag(text) };
  }

  private async readOrFail(filePath: string, recordId: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      throw new ScaError(
        'session_locator_unavailable',
        `record ${recordId} has no ${path.basename(filePath)}; register the session first`,
      );
    }
  }

  /**
   * Creates `records/<record_id>/` with both skeleton files under the session
   * lock. Idempotent: re-registering the same identity (even with a new title)
   * returns the existing record untouched (design 10.1 / 24.4).
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    const workspace = stripTrailingSep(input.canonicalWorkspace);
    const recordId = computeRecordId(input.host, workspace, input.sessionId);
    const dir = recordDir(this.paths, recordId);
    return withSessionLock(this.paths, recordId, async () => {
      await fs.mkdir(dir, { recursive: true });
      const analyzeExists = await exists(this.analyzePath(recordId));
      const candidatesExists = await exists(this.candidatesPath(recordId));
      if (analyzeExists && candidatesExists) {
        await this.recoverUnderLock(recordId);
        return {
          recordId,
          created: false,
          analyze: await this.loadAnalyze(recordId),
          candidates: await this.loadCandidates(recordId),
        };
      }
      const now = new Date().toISOString();
      const analyzeDoc: AnalyzeDocument = {
        schema: SCHEMA_ID,
        session_id: input.sessionId,
        source: input.host,
        trigger: input.trigger,
        analysis_status: 'pending',
        analyzer_version: input.analyzerVersion,
        revision: 1,
        created_at: now,
        transcript_path: input.transcriptPath,
        ...(input.title !== undefined ? { session_title: input.title } : {}),
        ...(input.projectName !== undefined ? { project_name: input.projectName } : {}),
        workspace,
        ...(input.fingerprint !== undefined ? { transcript_fingerprint: input.fingerprint } : {}),
      };
      const candidatesDoc: CandidatesDocument = {
        schema: SCHEMA_ID,
        session_id: input.sessionId,
        revision: 1,
        candidate_count: 0,
        published_count: 0,
        updated_at: now,
        candidates: [],
        request_log: [],
      };
      await this.writeAnalyzeSkeleton(recordId, analyzeDoc, analyzeExists);
      await this.writeCandidatesSkeleton(recordId, candidatesDoc, candidatesExists);
      return {
        recordId,
        created: true,
        analyze: await this.loadAnalyze(recordId),
        candidates: await this.loadCandidates(recordId),
      };
    });
  }

  async updateAnalyze(
    recordId: string,
    expected: ExpectedState,
    mutate: (doc: AnalyzeDocument) => AnalyzeDocument,
  ): Promise<LoadedFile<AnalyzeDocument>> {
    return withSessionLock(this.paths, recordId, async () => {
      await this.recoverUnderLock(recordId);
      const current = await this.loadAnalyze(recordId);
      assertExpected(current, expected);
      const next = validateSchema(analyzeDocumentSchema, {
        ...mutate(current.doc),
        revision: expected.doc.revision + 1,
      });
      await this.writeAnalyzeLocked(recordId, next);
      return this.loadAnalyze(recordId);
    });
  }

  async updateCandidates(
    recordId: string,
    expected: ExpectedState,
    mutate: (doc: CandidatesDocument) => CandidatesDocument,
  ): Promise<LoadedFile<CandidatesDocument>> {
    return withSessionLock(this.paths, recordId, async () => {
      await this.recoverUnderLock(recordId);
      const current = await this.loadCandidates(recordId);
      assertExpected(current, expected);
      const draft = mutate(current.doc);
      const next = validateSchema(candidatesDocumentSchema, {
        ...draft,
        revision: expected.doc.revision + 1,
        updated_at: new Date().toISOString(),
        candidate_count: draft.candidates.length,
        published_count: draft.candidates.filter((c) => c.status === 'published').length,
      });
      await this.writeCandidatesLocked(recordId, next);
      return this.loadCandidates(recordId);
    });
  }

  // ---------------------------------------------------------------------------
  // Lease + two-file commit protocol (design 24.2–24.4)
  // ---------------------------------------------------------------------------

  /**
   * One-lock read-modify-write over learning_candidates.md where the decision
   * whether to write at all happens inside the critical section: idempotent
   * receipt replay (design 26.2) must return the original result without
   * bumping the revision.
   */
  async transactCandidates<T>(
    recordId: string,
    fn: (
      doc: CandidatesDocument,
    ) =>
      | { write: false; result: T }
      | { write: true; doc: CandidatesDocument; result: T }
      | Promise<{ write: false; result: T } | { write: true; doc: CandidatesDocument; result: T }>,
  ): Promise<{ result: T; file: LoadedFile<CandidatesDocument> }> {
    return withSessionLock(this.paths, recordId, async () => {
      await this.recoverUnderLock(recordId);
      const current = await this.loadCandidates(recordId);
      const outcome = await fn(current.doc);
      if (!outcome.write) {
        return { result: outcome.result, file: current };
      }
      const draft = outcome.doc;
      const next = validateSchema(candidatesDocumentSchema, {
        ...draft,
        revision: current.doc.revision + 1,
        updated_at: new Date().toISOString(),
        candidate_count: draft.candidates.length,
        published_count: draft.candidates.filter((c) => c.status === 'published').length,
      });
      await this.writeCandidatesLocked(recordId, next);
      return { result: outcome.result, file: await this.loadCandidates(recordId) };
    });
  }

  /** Acquire or renew the run lease; expired leases are taken over with generation+1. */
  async acquireLease(recordId: string, opts: { runId: string; owner: string; ttlMs: number; inputHash?: string }): Promise<Lease> {
    return withSessionLock(this.paths, recordId, async () => {
      await this.recoverUnderLock(recordId);
      const { doc } = await this.loadAnalyze(recordId);
      const existing = doc.lease ?? null;
      const live = existing !== null && !isLeaseExpired(existing);
      const renewing = live && existing !== null && existing.run_id === opts.runId;
      if (live && !renewing) {
        throw new ScaError('lease_active', `run ${existing?.run_id ?? '?'} still holds the lease`);
      }
      const generation = nextGeneration(existing, renewing);
      if (renewing && existing?.input_hash !== undefined && opts.inputHash !== undefined && existing.input_hash !== opts.inputHash) {
        throw new ScaError('schema_invalid', 'a prepared run cannot be rebound to a different input; use a new run id');
      }
      const now = Date.now();
      const lease: Lease = {
        run_id: opts.runId,
        owner: opts.owner,
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + opts.ttlMs).toISOString(),
        generation,
        ...((opts.inputHash ?? (renewing ? existing?.input_hash : undefined)) !== undefined
          ? { input_hash: opts.inputHash ?? existing?.input_hash } : {}),
      };
      const extensions: Record<string, unknown> = { ...(doc.extensions ?? {}) };
      if (existing !== null && !renewing) {
        const raw: unknown = extensions['lease_history'];
        const history: unknown[] = Array.isArray(raw) ? raw : [];
        extensions['lease_history'] = [
          ...history,
          { from_run_id: existing.run_id, to_run_id: opts.runId, generation, at: lease.acquired_at },
        ];
      }
      const next = validateSchema(analyzeDocumentSchema, {
        ...doc,
        lease,
        extensions,
        revision: doc.revision + 1,
      });
      await this.writeAnalyzeLocked(recordId, next);
      return lease;
    });
  }

  /** Commit step 1: freeze the model result into analyze.md as pending_commit. */
  async beginCommit(recordId: string, fence: RunFence, payload: PendingPayload): Promise<PendingCommit> {
    return withSessionLock(this.paths, recordId, async () => {
      const { doc } = await this.loadAnalyze(recordId);
      assertFence(doc.lease, fence);
      if (doc.pending_commit !== null && doc.pending_commit !== undefined) {
        throw new ScaError('revision_conflict', 'a pending commit already exists; recover it first');
      }
      const pending = validateSchema(pendingCommitSchema, {
        analysis_id: payload.analysisId,
        input_digest: payload.inputDigest,
        created_at: new Date().toISOString(),
        facts: payload.facts,
        candidates: payload.candidates,
      });
      assertPendingWithinLimit(pending);
      const next = validateSchema(analyzeDocumentSchema, {
        ...doc,
        pending_commit: pending,
        analysis_status: 'running',
        revision: doc.revision + 1,
      });
      await this.writeAnalyzeLocked(recordId, next);
      return pending;
    });
  }

  /** Commit step 2 (exposed separately so crash points stay testable). */
  async stageCandidates(recordId: string, fence: RunFence): Promise<void> {
    return withSessionLock(this.paths, recordId, async () => {
      const { doc } = await this.loadAnalyze(recordId);
      assertFence(doc.lease, fence);
      await this.stageFromPending(recordId, doc, requirePending(doc));
    });
  }

  /** Commit step 3: promote pending facts to the committed view and clear pending_commit. */
  async finalizeCommit(recordId: string, fence: RunFence): Promise<string> {
    return withSessionLock(this.paths, recordId, async () => {
      const { doc } = await this.loadAnalyze(recordId);
      assertFence(doc.lease, fence);
      const pending = requirePending(doc);
      await this.finalizeFromPending(recordId, doc, pending, fence.runId);
      return pending.analysis_id;
    });
  }

  /** Steps 2+3 in one lock section. */
  async applyCommit(recordId: string, fence: RunFence): Promise<string> {
    return withSessionLock(this.paths, recordId, async () => {
      const { doc } = await this.loadAnalyze(recordId);
      assertFence(doc.lease, fence);
      const pending = requirePending(doc);
      await this.stageFromPending(recordId, doc, pending);
      await this.finalizeFromPending(recordId, doc, pending, fence.runId);
      return pending.analysis_id;
    });
  }

  /** Combined read for UI/drain: always resolves unfinished commits first (design 24.4). */
  async loadRecord(recordId: string): Promise<{
    analyze: LoadedFile<AnalyzeDocument>;
    candidates: LoadedFile<CandidatesDocument>;
  }> {
    return withSessionLock(this.paths, recordId, async () => {
      await this.recoverUnderLock(recordId);
      return {
        analyze: await this.loadAnalyze(recordId),
        candidates: await this.loadCandidates(recordId),
      };
    });
  }

  async recoverPending(recordId: string): Promise<boolean> {
    return withSessionLock(this.paths, recordId, () => this.recoverUnderLock(recordId));
  }

  private async recoverUnderLock(recordId: string): Promise<boolean> {
    const { doc } = await this.loadAnalyze(recordId);
    const pending = doc.pending_commit;
    if (pending === null || pending === undefined) {
      return false;
    }
    try {
      await this.stageFromPending(recordId, doc, pending);
      await this.finalizeFromPending(recordId, doc, pending, undefined);
    } catch (err) {
      if (err instanceof ScaError && err.code === 'pending_commit_recovery_failed') {
        throw err;
      }
      throw new ScaError(
        'pending_commit_recovery_failed',
        `interrupted commit ${pending.analysis_id} cannot be replayed; both files are kept as-is`,
      );
    }
    return true;
  }

  private async stageFromPending(recordId: string, analyzeDoc: AnalyzeDocument, pending: PendingCommit): Promise<void> {
    let current: CandidatesDocument;
    try {
      current = (await this.loadCandidates(recordId)).doc;
    } catch (err) {
      if (!(err instanceof ScaError) || err.code !== 'session_locator_unavailable') {
        throw err;
      }
      current = emptyCandidates(analyzeDoc.session_id, pending);
    }
    const merged = validateSchema(
      candidatesDocumentSchema,
      mergePendingCandidates(current, pending, analyzeDoc.revision + 1),
    );
    await this.writeCandidatesLocked(recordId, merged);
  }

  private async finalizeFromPending(
    recordId: string,
    doc: AnalyzeDocument,
    pending: PendingCommit,
    owningRunId: string | undefined,
  ): Promise<void> {
    const next = validateSchema(analyzeDocumentSchema, {
      ...doc,
      facts: pending.facts,
      analysis_id: pending.analysis_id,
      analysis_status: 'completed',
      analyzed_at: new Date().toISOString(),
      transcript_fingerprint: pending.facts.snapshot.source_fingerprint ?? doc.transcript_fingerprint,
      pending_commit: null,
      lease: doc.lease !== undefined && doc.lease !== null && doc.lease.run_id === owningRunId ? null : doc.lease,
      revision: doc.revision + 1,
    });
    await this.writeAnalyzeLocked(recordId, next);
  }

  /** Never clobbers an existing half-skeleton file (design 24.4). */
  private async writeAnalyzeSkeleton(recordId: string, doc: AnalyzeDocument, existsAlready: boolean): Promise<void> {
    if (existsAlready) {
      return;
    }
    const filePath = this.analyzePath(recordId);
    await atomicWriteText(
      path.dirname(filePath),
      ANALYZE_FILE,
      renderDocument(doc, composeBody(renderAnalyzeProjection(doc), '')),
    );
  }

  private async writeCandidatesSkeleton(
    recordId: string,
    doc: CandidatesDocument,
    existsAlready: boolean,
  ): Promise<void> {
    if (existsAlready) {
      return;
    }
    const filePath = this.candidatesPath(recordId);
    await atomicWriteText(
      path.dirname(filePath),
      CANDIDATES_FILE,
      renderDocument(doc, composeBody(renderCandidatesProjection(doc), '')),
    );
  }

  private async writeAnalyzeLocked(recordId: string, doc: AnalyzeDocument): Promise<void> {
    const filePath = this.analyzePath(recordId);
    const body = await this.currentBody(filePath, renderAnalyzeProjection(doc));
    await atomicWriteText(path.dirname(filePath), ANALYZE_FILE, renderDocument(doc, body));
  }

  private async writeCandidatesLocked(recordId: string, doc: CandidatesDocument): Promise<void> {
    const filePath = this.candidatesPath(recordId);
    const body = await this.currentBody(filePath, renderCandidatesProjection(doc));
    await atomicWriteText(path.dirname(filePath), CANDIDATES_FILE, renderDocument(doc, body));
  }

  /** Regenerates the projection but always carries the User Notes region forward. */
  private async currentBody(filePath: string, projection: string): Promise<string> {
    const existing = await fs.readFile(filePath, 'utf8').catch(() => undefined);
    if (existing === undefined) {
      return composeBody(projection, '');
    }
    const body = splitFrontmatter(existing).body;
    assertSingleNotesSection(body);
    const { userNotes } = splitBody(body);
    return composeBody(projection, userNotes);
  }
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function requirePending(doc: AnalyzeDocument): PendingCommit {
  const pending = doc.pending_commit;
  if (pending === null || pending === undefined) {
    throw new ScaError('revision_conflict', 'no pending commit exists for this record');
  }
  return pending;
}

function assertExpected(current: ExpectedState, expected: ExpectedState): void {
  if (current.doc.revision !== expected.doc.revision || current.fileHash !== expected.fileHash) {
    throw new ScaError(
      'revision_conflict',
      'the record changed after it was read (external edit or concurrent writer); reload and retry',
    );
  }
}

export function assertAnalyzeIdentity(recordId: string, doc: AnalyzeDocument): void {
  if (doc.workspace === undefined) {
    return;
  }
  const expected = computeRecordId(doc.source, stripTrailingSep(doc.workspace), doc.session_id);
  if (expected !== recordId) {
    throw new ScaError(
      'record_identity_mismatch',
      `directory id ${recordId.slice(0, 12)}… does not match stored host/workspace/session identity`,
    );
  }
}

export function assertDerivedCounts(doc: CandidatesDocument): void {
  const candidates = doc.candidates;
  if (doc.candidate_count !== candidates.length) {
    throw new ScaError(
      'schema_invalid',
      'candidate_count contradicts the candidates list; derived fields must not be edited independently',
    );
  }
  const published = candidates.filter((c) => c.status === 'published').length;
  if (doc.published_count !== published) {
    throw new ScaError(
      'schema_invalid',
      'published_count contradicts the candidates list; derived fields must not be edited independently',
    );
  }
}
