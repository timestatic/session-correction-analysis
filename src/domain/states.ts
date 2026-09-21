import type { Candidate, CandidateStatus } from './candidates.js';
import type { EpisodeCommitted } from './episodes.js';
import { isFormalConfidence } from './episodes.js';

const TRANSITIONS: Readonly<Record<CandidateStatus, readonly CandidateStatus[]>> = {
  proposed: ['approved', 'rejected', 'superseded'],
  approved: ['proposed', 'rejected', 'superseded'],
  publish_failed: [],
  published: ['superseded'],
  rejected: ['proposed'],
  superseded: [],
};

export function canTransition(from: CandidateStatus, to: CandidateStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: CandidateStatus): readonly CandidateStatus[] {
  return TRANSITIONS[from];
}

export const CANDIDATE_ACTIONS = [
  'view',
  'edit_content',
  'approve',
  'reject',
  'revoke_approval',
  'copy_content',
  'export_content',
] as const;
export type CandidateAction = (typeof CANDIDATE_ACTIONS)[number];

/**
 * Effective candidates (design 29.4): the current content version carries an
 * unrevoked approval; a failed harness publication does not revoke it.
 */
export function isEffective(candidate: Candidate): boolean {
  return (
    candidate.status === 'approved' ||
    candidate.status === 'published' ||
    candidate.status === 'publish_failed'
  );
}

export function allowedActions(candidate: Candidate): readonly CandidateAction[] {
  switch (candidate.status) {
    case 'proposed':
      return ['view', 'edit_content', 'approve', 'reject'];
    case 'approved':
      return ['view', 'edit_content', 'revoke_approval', 'reject', 'copy_content', 'export_content'];
    case 'publish_failed':
    case 'published':
      return ['view'];
    case 'rejected':
      return ['view', 'edit_content'];
    case 'superseded':
      return ['view'];
    default:
      return ['view'];
  }
}

export function isFormalCorrection(episode: EpisodeCommitted): boolean {
  return episode.correction.detected && isFormalConfidence(episode.correction.confidence);
}

export function isFormalIntervention(episode: EpisodeCommitted): boolean {
  return episode.intervention.detected && isFormalConfidence(episode.intervention.confidence);
}

export function hasReworkEvidence(episode: EpisodeCommitted): boolean {
  const rework = episode.correction.rework;
  return (
    rework !== undefined &&
    rework.outcome !== 'none' &&
    rework.outcome !== 'unknown' &&
    rework.evidence.length > 0
  );
}
