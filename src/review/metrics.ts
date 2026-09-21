import type { Candidate } from '../domain/candidates.js';
import { hasCurrentApproval } from './decide.js';

/**
 * User-approval metrics (design 29.4): only the CURRENT content version's
 * explicit decision counts. Failed harness publication does not revoke an
 * approval; copy/export never changes any state. Zero denominators are null
 * (N/A), never 0% or 100%.
 */
export interface ApprovalMetrics {
  /** A — effective: current version approved and not revoked/rejected/superseded. */
  effective: number;
  /** P — proposed awaiting review, including revoked-pending as a subset. */
  pending_review: number;
  /** Revoked-after-approval items awaiting re-decision — listed inside P, not double-counted. */
  revoked_pending: number;
  /** J — current version rejected. */
  rejected: number;
  /** Excluded from every rate and reported separately. */
  superseded: number;
  /** A/(A+J) — pending items never enter this denominator. */
  approval_rate: number | null;
  /** (A+J)/(A+J+P) */
  review_coverage: number | null;
  /** A with target_kind=memory; copies/exports do not increase this. */
  effective_memory: number;

}

export function approvalMetrics(candidates: readonly Candidate[]): ApprovalMetrics {
  let effective = 0;
  let pendingReview = 0;
  let revokedPending = 0;
  let rejected = 0;
  let superseded = 0;
  let effectiveMemory = 0;
  for (const candidate of candidates) {
    switch (candidate.status) {
      case 'approved':
      case 'publish_failed':
        if (hasCurrentApproval(candidate)) {
          effective += 1;
          if (candidate.target.kind === 'memory') {
            effectiveMemory += 1;
          }
        } else {
          pendingReview += 1;
        }
        break;
      case 'published':
        break;
      case 'proposed':
        pendingReview += 1;
        break;
      case 'rejected':
        rejected += 1;
        break;
      case 'superseded':
        superseded += 1;
        break;
    }
  }
  const lastWasRevoke = (candidate: Candidate): boolean =>
    candidate.decision_history[candidate.decision_history.length - 1]?.action === 'revoke';
  revokedPending = candidates.filter((c) => c.status === 'proposed' && lastWasRevoke(c)).length;
  return {
    effective,
    pending_review: pendingReview,
    revoked_pending: revokedPending,
    rejected,
    superseded,
    approval_rate: effective + rejected === 0 ? null : effective / (effective + rejected),
    review_coverage: effective + rejected + pendingReview === 0 ? null : (effective + rejected) / (effective + rejected + pendingReview),
    effective_memory: effectiveMemory,
  };
}
