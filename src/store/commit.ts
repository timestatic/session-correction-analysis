import type { Candidate } from '../domain/candidates.js';
import type { AnalyzeFacts, CandidatesDocument, PendingCommit } from '../domain/documents.js';
import { SCHEMA_ID } from '../domain/documents.js';
import { PENDING_COMMIT_MAX_BYTES } from '../domain/limits.js';
import { ScaError } from '../domain/errors.js';
import { stableStringify, type Sha256Hash } from '../domain/hash.js';
import type { Lease } from '../domain/snapshot.js';

/** Caller-authorized identity of one analysis run inside its lease (design 24.2 / 24.3). */
export interface RunFence {
  runId: string;
  generation: number;
}

export interface PendingPayload {
  analysisId: string;
  /** Schema-validated sha256 digest of the frozen input range. */
  inputDigest: Sha256Hash;
  facts: AnalyzeFacts;
  /** Planned new candidates; merged additively at apply time so human decisions survive. */
  candidates: Candidate[];
}

export function isLeaseExpired(lease: Lease, now: number = Date.now()): boolean {
  return Date.parse(lease.expires_at) <= now;
}

/** Expired or absent leases fail the fence; late runners must never commit (design 24.3). */
export function assertFence(lease: Lease | null | undefined, fence: RunFence): void {
  if (lease === null || lease === undefined) {
    throw new ScaError('lease_expired', 'no active lease: acquire one before committing');
  }
  if (lease.run_id !== fence.runId || lease.generation !== fence.generation) {
    throw new ScaError(
      'lease_expired',
      'the lease was superseded by a newer run; this runner result is stale and rejected',
    );
  }
  if (isLeaseExpired(lease)) {
    throw new ScaError('lease_expired', 'the lease passed its expiry before commit');
  }
}

export function nextGeneration(existing: Lease | null | undefined, sameRun: boolean): number {
  if (existing === null || existing === undefined) {
    return 0;
  }
  return sameRun ? existing.generation : existing.generation + 1;
}

/** Step 2 merge: append unknown ids/fingerprints only; never rewrite reviewed candidates. */
export function mergePendingCandidates(
  current: CandidatesDocument,
  pending: PendingCommit,
  analysisRevision: number,
): CandidatesDocument {
  const knownIds = new Set(current.candidates.map((c) => c.id));
  const knownFingerprints = new Set(current.candidates.map((c) => c.fingerprint));
  const appended = pending.candidates.filter((c) => !knownIds.has(c.id) && !knownFingerprints.has(c.fingerprint));
  const candidates = [...current.candidates, ...appended];
  return {
    ...current,
    candidates,
    analysis_id: pending.analysis_id,
    analysis_revision: analysisRevision,
    applied_analysis_id: pending.analysis_id,
    revision: current.revision + 1,
    candidate_count: candidates.length,
    published_count: candidates.filter((c) => c.status === 'published').length,
    updated_at: pending.created_at,
  };
}

export function emptyCandidates(sessionId: string, pending: PendingCommit): CandidatesDocument {
  return {
    schema: SCHEMA_ID,
    session_id: sessionId,
    revision: 0,
    candidate_count: 0,
    published_count: 0,
    updated_at: pending.created_at,
    candidates: [],
    request_log: [],
  };
}

/** Measure the compact transaction before writing; never silently truncate evidence. */
export function assertPendingWithinLimit(pending: PendingCommit): void {
  const size = Buffer.byteLength(stableStringify(pending), 'utf8');
  if (size > PENDING_COMMIT_MAX_BYTES) {
    const evidenceBytes = Buffer.byteLength(stableStringify(pending.facts.evidence), 'utf8');
    throw new ScaError(
      'payload_too_large',
      `pending commit is ${String(size)} bytes (limit ${String(PENDING_COMMIT_MAX_BYTES)}); unique cited evidence is ${String(evidenceBytes)} bytes. Do not edit the frozen packet or drop required evidence; report a capacity limit if necessary evidence alone cannot fit`,
    );
  }
}
