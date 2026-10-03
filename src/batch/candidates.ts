import { z } from 'zod';
import { ScaError } from '../domain/errors.js';
import { stableHash, sha256HashSchema } from '../domain/hash.js';
import { loadBatch, readLedger } from './index.js';
import type { Judgment } from './schema.js';

export interface CandidateReference {
  candidate_id: string; target_id: string; target_version: number;
  kind: 'memory' | 'harness'; content_hash: string; evidence_ids: string[];
  review_status: 'unreviewed';
}
export async function batchCandidates(root: string, id: string): Promise<{
  manifest_hash: string; ledger_revision: number; candidates: CandidateReference[];
}> {
  const manifest = await loadBatch(root, id);
  const ledger = await readLedger(root, manifest);
  const current = new Map<string, { judgment: Judgment; version: number }>();
  for (const transaction of ledger.history) for (const judgment of transaction.judgments) {
    current.set(judgment.target_id, { judgment, version: (current.get(judgment.target_id)?.version ?? 0) + 1 });
  }
  const manifestHash = stableHash(manifest);
  const candidates: CandidateReference[] = [];
  for (const target of manifest.targets) {
    const entry = current.get(target.target_id);
    if (entry === undefined || !('candidates' in entry.judgment)) continue;
    for (const candidate of entry.judgment.candidates ?? []) {
      candidates.push({ candidate_id: `candidate-${stableHash([manifestHash, target.target_id, entry.version, candidate]).slice(7)}`,
        target_id: target.target_id, target_version: entry.version, kind: candidate.kind,
        content_hash: stableHash(candidate.content), evidence_ids: candidate.evidence_ids, review_status: 'unreviewed' });
    }
  }
  return { manifest_hash: manifestHash, ledger_revision: ledger.revision, candidates };
}

export const candidateDetailSchema = z.object({ candidate_id: z.string().min(1), expected_content_hash: sha256HashSchema }).strict();
export async function batchCandidateDetail(root: string, id: string, input: unknown): Promise<CandidateReference & { content: string; ledger_revision: number }> {
  const request = candidateDetailSchema.parse(input);
  const manifest = await loadBatch(root, id);
  const ledger = await readLedger(root, manifest);
  const hash = stableHash(manifest);
  const current = new Map<string, { judgment: Judgment; version: number }>();
  for (const transaction of ledger.history) for (const judgment of transaction.judgments) current.set(judgment.target_id,
    { judgment, version: (current.get(judgment.target_id)?.version ?? 0) + 1 });
  for (const [target, entry] of current) {
    if (!('candidates' in entry.judgment)) continue;
    for (const candidate of entry.judgment.candidates ?? []) {
      const candidateId = `candidate-${stableHash([hash, target, entry.version, candidate]).slice(7)}`;
      if (candidateId !== request.candidate_id) continue;
      const contentHash = stableHash(candidate.content);
      if (contentHash !== request.expected_content_hash) throw new ScaError('revision_conflict', 'candidate content hash mismatch');
      return { candidate_id: candidateId, target_id: target, target_version: entry.version, kind: candidate.kind,
        content_hash: contentHash, evidence_ids: candidate.evidence_ids, review_status: 'unreviewed',
        content: candidate.content, ledger_revision: ledger.revision };
    }
  }
  throw new ScaError('revision_conflict', 'candidate is no longer current; refresh the candidate list');
}
