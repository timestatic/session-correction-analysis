import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { Candidate } from '../domain/candidates.js';
import type { CandidatesDocument } from '../domain/documents.js';
import { ScaError } from '../domain/errors.js';
import { sha256HashSchema } from '../domain/hash.js';
import { isoDateTimeSchema } from '../domain/ids.js';
import { hasCurrentApproval } from '../review/decide.js';
import { validateSchema } from '../store/frontmatter.js';
import type { ScaPaths } from '../store/paths.js';
import type { RecordRepository } from '../store/repository.js';
import { readTargetText } from './preview.js';
import { atomicWriteText, sha256File } from '../store/atomic.js';

/**
 * Durable publish receipts (design 15 step 8, "可恢复回执"). One small JSON
 * file per in-flight publication under runtime/publications, written before
 * the target is touched and deleted once the candidate state is committed.
 * A crash anywhere leaves exactly one of {receipt, target edit, state edit}
 * observable, and reconcileReceipts converges each combination without ever
 * rewriting the target or publishing behind a revoked approval.
 */

export const RECEIPT_SCHEMA_ID = 'session-correction-analysis/publish-receipt/v1';

export const publishReceiptSchema = z
  .object({
    schema: z.literal(RECEIPT_SCHEMA_ID),
    publication_id: z.string().regex(/^pub-[0-9a-f]{6}$/),
    record_id: z.string().regex(/^[0-9a-f]{64}$/),
    candidate_id: z.string().regex(/^learning-\d{3,}$/),
    preview_id: z.string().regex(/^preview-[0-9a-f]{8}$/),
    target_id: z.string().min(1),
    display_path: z.string().min(1),
    realpath: z.string().regex(/^\//),
    candidate_content_hash: sha256HashSchema,
    hash_before: sha256HashSchema,
    hash_after_expected: sha256HashSchema,
    rule_block: z.string().min(1),
    created_at: isoDateTimeSchema,
    target_written: z.boolean(),
  })
  .strict();
export type PublishReceipt = z.infer<typeof publishReceiptSchema>;

export function receiptsDir(paths: ScaPaths): string {
  return path.join(paths.runtimeDir, 'publications');
}

export function receiptPath(paths: ScaPaths, publicationId: string): string {
  if (!/^pub-[0-9a-f]{6}$/.test(publicationId)) {
    throw new ScaError('schema_invalid', `publication id ${publicationId} is not a safe token`);
  }
  return path.join(receiptsDir(paths), `${publicationId}.json`);
}

export async function writeReceipt(paths: ScaPaths, receipt: PublishReceipt): Promise<void> {
  const dir = receiptsDir(paths);
  await fs.mkdir(dir, { recursive: true });
  // Atomic on purpose: a crash must never leave a half-written receipt, or
  // recovery would read the very record it exists to protect.
  await atomicWriteText(dir, `${receipt.publication_id}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
}

export async function readReceipt(paths: ScaPaths, publicationId: string): Promise<PublishReceipt> {
  const file = receiptPath(paths, publicationId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new ScaError('schema_invalid', `publication receipt ${publicationId} is missing or unreadable`);
  }
  return validateSchema(publishReceiptSchema, parsed as Record<string, unknown>);
}

/** Marks the target write as landed; a crash before this line is what `target_written: false` records. */
export async function markTargetWritten(paths: ScaPaths, publicationId: string): Promise<void> {
  const receipt = await readReceipt(paths, publicationId);
  await writeReceipt(paths, { ...receipt, target_written: true });
}

export async function deleteReceipt(paths: ScaPaths, publicationId: string): Promise<void> {
  await fs.rm(receiptPath(paths, publicationId), { force: true });
}

export async function listReceipts(paths: ScaPaths): Promise<PublishReceipt[]> {
  const entries = await fs.readdir(receiptsDir(paths)).catch(() => [] as string[]);
  const receipts: PublishReceipt[] = [];
  for (const entry of entries.sort()) {
    if (!/^pub-[0-9a-f]{6}\.json$/.test(entry)) {
      continue;
    }
    receipts.push(await readReceipt(paths, entry.slice(0, -'.json'.length)));
  }
  return receipts;
}

export type ReconcileOutcome =
  | 'converged'
  | 'retryable'
  | 'residue_cleared'
  | 'needs_reconciliation'
  | 'needs_review';

export interface ReconcileReport {
  publication_id: string;
  candidate_id: string;
  outcome: ReconcileOutcome;
  detail: string;
  revision: number;
  candidate_status: Candidate['status'];
}

function swapCandidate(doc: CandidatesDocument, next: Candidate): CandidatesDocument {
  return { ...doc, candidates: doc.candidates.map((c) => (c.id === next.id ? next : c)) };
}

export async function reconcileReceipts(repo: RecordRepository, recordId: string): Promise<ReconcileReport[]> {
  const receipts = (await listReceipts(repo.paths)).filter((r) => r.record_id === recordId);
  const reports: ReconcileReport[] = [];
  for (const receipt of receipts) {
    reports.push(await reconcileOne(repo, recordId, receipt));
  }
  return reports;
}

async function reconcileOne(
  repo: RecordRepository,
  recordId: string,
  receipt: PublishReceipt,
): Promise<ReconcileReport> {
  const { result } = await repo.transactCandidates(recordId, async (doc) => {
    const candidate = doc.candidates.find((c) => c.id === receipt.candidate_id);
    if (candidate === undefined) {
      throw new ScaError(
        'schema_invalid',
        `receipt ${receipt.publication_id} points at a candidate that no longer exists; inspect the file and remove it manually`,
      );
    }
    const residue = (outcome: ReconcileOutcome, detail: string): ReconcileReport => ({
      publication_id: receipt.publication_id,
      candidate_id: candidate.id,
      outcome,
      detail,
      revision: doc.revision,
      candidate_status: candidate.status,
    });
    if (candidate.status === 'published' && candidate.publication.published) {
      // The state write committed; only receipt cleanup died. The committed
      // state is authoritative — clear the residue without judging the target.
      await deleteReceipt(repo.paths, receipt.publication_id);
      return { write: false, result: residue('residue_cleared', 'the published state is authoritative') };
    }
    if (candidate.status === 'published') {
      await deleteReceipt(repo.paths, receipt.publication_id);
      return {
        write: false,
        result: residue('residue_cleared', 'candidate carries a published status; receipt cleared as residue'),
      };
    }

    if (!receipt.target_written) {
      // Durable proof that the target was never touched: whatever it holds
      // now is somebody else's business. Drop the intent and let the caller
      // re-preview (a stale preview still fails closed on target_changed).
      await deleteReceipt(repo.paths, receipt.publication_id);
      return {
        write: false,
        result: residue(
          'retryable',
          'the receipt proves the target write never started; re-preview and publish again',
        ),
      };
    }

    const currentHash = await sha256File(receipt.realpath).catch(() => '');
    const targetText = await readTargetText(receipt.realpath);

    if (currentHash === receipt.hash_after_expected) {
      if (!hasCurrentApproval(candidate)) {
        // The rule is in the file but the approval no longer stands — never
        // publish behind the user; they decide between revoke-rollback and re-approve.
        return {
          write: false,
          result: residue(
            'needs_review',
            'the target carries this rule but the current approval is gone; revoke-rollback or re-approve manually',
          ),
        };
      }
      const now = new Date().toISOString();
      const published: Candidate = {
        ...candidate,
        status: 'published',
        updated_at: now,
        publication: {
          ...candidate.publication,
          published: true,
          publication_id: receipt.publication_id,
          published_at: now,
          attempted_at: now,
          result: 'success',
          ...(candidate.publication.output_at !== undefined
            ? { output_at: candidate.publication.output_at }
            : {}),
          error: undefined,
          attempts: [
            ...candidate.publication.attempts,
            {
              publication_id: receipt.publication_id,
              candidate_hash: receipt.candidate_content_hash,
              preview_id: receipt.preview_id,
              started_at: receipt.created_at,
              finished_at: now,
              phase: 'done' as const,
              targets: [
                {
                  target_id: receipt.target_id,
                  display_path: receipt.display_path,
                  status: 'verified' as const,
                  hash_before: receipt.hash_before,
                  hash_after_expected: receipt.hash_after_expected,
                  hash_after_actual: currentHash,
                },
              ],
            },
          ],
        },
      };
      await deleteReceipt(repo.paths, receipt.publication_id);
      return {
        write: true,
        doc: swapCandidate(doc, published),
        result: {
          ...residue('converged', 'the target already carries the exact published content; state committed'),
          revision: doc.revision + 1,
          candidate_status: published.status,
        },
      };
    }

    if (currentHash === receipt.hash_before) {
      // The write never landed (or the user reverted the file themselves).
      await deleteReceipt(repo.paths, receipt.publication_id);
      return {
        write: false,
        result: residue('retryable', 'the target is at its pre-publish hash; the publication can simply be retried'),
      };
    }

    if (targetText.includes(receipt.rule_block.trim())) {
      // The rule landed but the file moved afterwards; provenance is unclear.
      const now = new Date().toISOString();
      const dirty: Candidate = {
        ...candidate,
        status: 'publish_failed',
        updated_at: now,
        publication: {
          ...candidate.publication,
          published: false,
          attempted_at: now,
          result: 'failed' as const,
          ...(candidate.publication.output_at !== undefined
            ? { output_at: candidate.publication.output_at }
            : {}),
          error: new ScaError(
            'publication_in_doubt',
            'the target carries the rule but no longer matches the published hash',
          ).toPayload(),
          attempts: [
            ...candidate.publication.attempts,
            {
              publication_id: receipt.publication_id,
              candidate_hash: receipt.candidate_content_hash,
              preview_id: receipt.preview_id,
              started_at: receipt.created_at,
              finished_at: now,
              phase: 'needs_reconciliation' as const,
              targets: [
                {
                  target_id: receipt.target_id,
                  display_path: receipt.display_path,
                  status: 'needs_reconciliation' as const,
                  hash_before: receipt.hash_before,
                  hash_after_expected: receipt.hash_after_expected,
                  hash_after_actual: currentHash,
                },
              ],
            },
          ],
        },
      };
      return {
        write: true,
        doc: swapCandidate(doc, dirty),
        result: residue(
          'needs_reconciliation',
          'the rule is present but the target was edited afterwards; the file is kept as-is',
        ),
      };
    }

    // Neither expected hash and the block is absent: the write never landed
    // but the target moved on — keep the receipt so nothing is forgotten.
    return {
      write: false,
      result: residue('needs_review', 'the target changed outside this publication and the write cannot be proven; receipt kept'),
    };
  });
  return result;
}
