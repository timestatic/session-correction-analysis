import type { Candidate } from '../domain/candidates.js';
import type { EpisodeCommitted, EvidenceItem } from '../domain/episodes.js';
import { ScaError } from '../domain/errors.js';
import { allowedActions, type CandidateAction } from '../domain/states.js';
import type { RecordRepository } from '../store/repository.js';

export interface CandidateDetail {
  revision: number;
  candidate: Candidate;
  allowed_actions: readonly CandidateAction[];
  provenance: {
    status: 'available' | 'incomplete' | 'unavailable';
    episodes: EpisodeCommitted[];
    evidence: Pick<EvidenceItem, 'id' | 'kind' | 'excerpt'>[];
    missing_ids: string[];
  };
}

export async function candidateDetail(repo: RecordRepository, recordId: string, candidateId: string): Promise<CandidateDetail> {
  const { analyze, candidates } = await repo.loadRecord(recordId);
  const candidate = candidates.doc.candidates.find(item => item.id === candidateId);
  if (candidate === undefined) throw new ScaError('schema_invalid', 'candidate does not exist in this record');
  const source = analyze.doc.facts?.candidate_sources.find(item => item.candidate_id === candidateId);
  // Current-run facts cannot prove the provenance of a retained historical candidate.
  const episodes = source?.episodes.filter(item => candidate.source_episodes.includes(item.id)) ?? [];
  const evidence = source?.evidence ?? [];
  const missing = [
    ...candidate.source_episodes.filter(id => !episodes.some(item => item.id === id)),
    ...candidate.evidence.filter(id => !evidence.some(item => item.id === id)),
  ];
  return {
    revision: candidates.doc.revision, candidate, allowed_actions: allowedActions(candidate),
    provenance: {
      status: source === undefined ? 'unavailable' : missing.length > 0 ? 'incomplete' : 'available',
      episodes, evidence: evidence.map(({ id, kind, excerpt }) => ({ id, kind, excerpt })), missing_ids: missing,
    },
  };
}
