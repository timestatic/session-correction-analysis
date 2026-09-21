import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

import type { Candidate, Publication, PublicationAttempt } from '../domain/candidates.js';
import type { CandidatesDocument } from '../domain/documents.js';
import { ScaError } from '../domain/errors.js';
import { sha256Hex, sha256Tag } from '../domain/hash.js';
import { contentVersionHash } from '../review/decide.js';
import { atomicWriteText, sha256File } from '../store/atomic.js';
import { withAdvisoryLock } from '../store/lock.js';
import type { RecordRepository } from '../store/repository.js';
import { applyRule } from './harness.js';
import {
  deleteReceipt,
  markTargetWritten,
  writeReceipt,
  type PublishReceipt,
} from './receipt.js';
import { assertPublishGate, loadPreview, previewExpired, readTargetText, type PreviewRecord } from './preview.js';
import { resolveTarget } from './targets.js';

/**
 * Publish execution (design 26.2 steps 1-5). One session-lock transaction
 * also takes the per-target advisory lock, then: re-validates approval +
 * content hash + whitelist + target hash, writes a durable receipt before
 * touching the target (T14), writes atomically, and only marks the candidate
 * `published` after the read-back hash matches the preview. Any crash leaves
 * a receipt that reconcileReceipts converges.
 */

export type PublishCrashPoint = 'before_target' | 'after_target' | 'after_state';
let crashHook: ((point: PublishCrashPoint) => void | Promise<void>) | undefined;

/** Test/evaluation seam: abort the process at a publish boundary (real kill in integration tests). */
export function setPublishCrashHook(hook: ((point: PublishCrashPoint) => void | Promise<void>) | undefined): void {
  crashHook = hook;
}

async function fireCrashHook(point: PublishCrashPoint): Promise<void> {
  if (crashHook !== undefined) {
    await crashHook(point);
  }
}

export const publishRequestSchema = z
  .object({
    candidate_id: z.string().regex(/^learning-\d{3,}$/),
    preview_id: z.string().regex(/^preview-[0-9a-f]{8}$/),
    expected_revision: z.number().int().positive(),
  })
  .strict();
export type PublishRequest = z.infer<typeof publishRequestSchema>;

export type PublishPhase = 'published' | 'unchanged' | 'failed' | 'needs_reconciliation';

export interface PublishOutcome {
  phase: PublishPhase;
  candidate: Candidate;
  revision: number;
  publication_id?: string;
  /** True when an already-published candidate replayed its existing receipt. */
  already_published?: boolean;
}

function targetLockName(realpath: string): string {
  return `target-${sha256Hex(realpath).slice(0, 16)}`;
}

function replaceCandidate(doc: CandidatesDocument, next: Candidate): CandidatesDocument {
  return { ...doc, candidates: doc.candidates.map((c) => (c.id === next.id ? next : c)) };
}

function rebuildPublication(
  previous: Publication,
  now: string,
  fields: Pick<Publication, 'published' | 'result'> & {
    publication_id?: string;
    published_at?: string;
    error?: Publication['error'];
    attempt: PublicationAttempt;
  },
): Publication {
  const { attempt, ...top } = fields;
  return {
    ...top,
    attempted_at: now,
    ...(previous.output_at !== undefined ? { output_at: previous.output_at } : {}),
    attempts: [...previous.attempts, attempt],
  };
}

export async function publishCandidate(
  repo: RecordRepository,
  recordId: string,
  rawRequest: unknown,
  opts: { now?: Date } = {},
): Promise<PublishOutcome> {
  const parsed = publishRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join('; ').slice(0, 300);
    throw new ScaError('schema_invalid', `publish request rejected — ${detail}`);
  }
  const request = parsed.data;
  const preview: PreviewRecord = await loadPreview(repo.paths, request.preview_id);
  if (preview.record_id !== recordId || preview.candidate_id !== request.candidate_id) {
    throw new ScaError('schema_invalid', 'this preview belongs to a different record or candidate');
  }
  if (previewExpired(preview, opts.now)) {
    throw new ScaError('preview_expired', `preview ${preview.preview_id} passed ${preview.expires_at}`);
  }
  // The whitelist can change between preview and publish; re-resolve, never trust the pinned path alone.
  const entry = await resolveTarget(repo.paths, { targetId: preview.target_id });
  if (entry.realpath !== preview.realpath) {
    throw new ScaError('target_changed', 'the whitelisted entry for this target id now points elsewhere');
  }

  const { result } = await repo.transactCandidates(
    recordId,
    async (doc: CandidatesDocument): Promise<
      { write: false; result: PublishOutcome } | { write: true; doc: CandidatesDocument; result: PublishOutcome }
    > => {
    const candidate = doc.candidates.find((c) => c.id === request.candidate_id);
    if (candidate === undefined) {
      throw new ScaError('schema_invalid', `no candidate ${request.candidate_id} in this record`);
    }
    if (candidate.rule_ref !== undefined) throw new ScaError('unsupported_operation', 'linked rules require the rule-version publication flow; legacy candidate publish is disabled');
    if (candidate.status === 'published' && candidate.publication.published) {
      // Idempotent repeat: return the existing record, never re-insert the rule.
      return {
        write: false,
        result: {
          phase: 'published' as const,
          candidate,
          revision: doc.revision,
          ...(candidate.publication.publication_id !== undefined
            ? { publication_id: candidate.publication.publication_id }
            : {}),
          already_published: true,
        },
      };
    }
    if (doc.revision !== request.expected_revision) {
      throw new ScaError(
        'revision_conflict',
        `candidates revision is ${doc.revision}, the caller read ${request.expected_revision}`,
      );
    }
    assertPublishGate(candidate);
    if (contentVersionHash(candidate) !== preview.candidate_content_hash) {
      throw new ScaError(
        'approval_missing',
        'content, target or scope changed after the preview; approve the new version and re-preview',
      );
    }

    return withAdvisoryLock(repo.paths, targetLockName(entry.realpath), async () => {
      const now = (opts.now ?? new Date()).toISOString();
      const before = await readTargetText(entry.realpath);
      const hashBefore = sha256Tag(before);
      if (hashBefore !== preview.hash_before) {
        throw new ScaError('target_changed', 'target changed after preview; re-preview to see the new diff');
      }
      const { after, duplicate } = applyRule(before, preview.rule_block);
      if (duplicate) {
        // Rule text already lives in the managed region: no write, no state change.
        return { write: false, result: { phase: 'unchanged' as const, candidate, revision: doc.revision } };
      }
      const publicationId = `pub-${crypto.randomBytes(3).toString('hex')}`;
      const receipt: PublishReceipt = {
        schema: 'session-correction-analysis/publish-receipt/v1',
        publication_id: publicationId,
        record_id: recordId,
        candidate_id: candidate.id,
        preview_id: preview.preview_id,
        target_id: entry.target_id,
        display_path: entry.display_path,
        realpath: entry.realpath,
        candidate_content_hash: preview.candidate_content_hash,
        hash_before: hashBefore,
        hash_after_expected: preview.hash_after,
        rule_block: preview.rule_block,
        created_at: now,
        target_written: false,
      };
      // Durable intent BEFORE touching the target (design 15 step 8).
      await writeReceipt(repo.paths, receipt);
      const attemptBase = {
        publication_id: publicationId,
        candidate_hash: preview.candidate_content_hash,
        preview_id: preview.preview_id,
        started_at: now,
        finished_at: now,
      };
      await fireCrashHook('before_target');
      let written: string;
      try {
        written = (await atomicWriteText(path.dirname(entry.realpath), path.basename(entry.realpath), after)).fileHash;
      } catch (err) {
        await deleteReceipt(repo.paths, publicationId).catch(() => undefined);
        if (err instanceof ScaError) {
          throw err;
        }
        const failed = {
          ...candidate,
          status: 'publish_failed' as const,
          updated_at: now,
          publication: rebuildPublication(candidate.publication, now, {
            published: false,
            result: 'failed',
            error: new ScaError('internal_error', 'target write failed before it completed').toPayload(),
            attempt: {
              ...attemptBase,
              phase: 'failed' as const,
              targets: [
                {
                  target_id: entry.target_id,
                  display_path: entry.display_path,
                  status: 'failed' as const,
                  hash_before: hashBefore,
                  hash_after_expected: preview.hash_after,
                },
              ],
            },
          }),
        };
        return {
          write: true,
          doc: replaceCandidate(doc, failed),
          result: { phase: 'failed' as const, candidate: failed, revision: doc.revision + 1, publication_id: publicationId },
        };
      }
      await markTargetWritten(repo.paths, publicationId);
      await fireCrashHook('after_target');
      const actual = await sha256File(entry.realpath);
      if (actual !== preview.hash_after || written !== preview.hash_after) {
        // The file is in a state we cannot prove; the receipt stays for
        // reconcileReceipts, and the candidate records the doubt.
        const dirty = {
          ...candidate,
          status: 'publish_failed' as const,
          updated_at: now,
          publication: rebuildPublication(candidate.publication, now, {
            published: false,
            result: 'failed',
            error: new ScaError('publication_in_doubt', 'target after-hash mismatch').toPayload(),
            attempt: {
              ...attemptBase,
              phase: 'needs_reconciliation' as const,
              targets: [
                {
                  target_id: entry.target_id,
                  display_path: entry.display_path,
                  status: 'needs_reconciliation' as const,
                  hash_before: hashBefore,
                  hash_after_expected: preview.hash_after,
                  hash_after_actual: actual,
                },
              ],
            },
          }),
        };
        return {
          write: true,
          doc: replaceCandidate(doc, dirty),
          result: {
            phase: 'needs_reconciliation' as const,
            candidate: dirty,
            revision: doc.revision + 1,
            publication_id: publicationId,
          },
        };
      }
      const published = {
        ...candidate,
        status: 'published' as const,
        updated_at: now,
        publication: rebuildPublication(candidate.publication, now, {
          published: true,
          publication_id: publicationId,
          published_at: now,
          result: 'success',
          attempt: {
            ...attemptBase,
            phase: 'done' as const,
            targets: [
              {
                target_id: entry.target_id,
                display_path: entry.display_path,
                status: 'verified' as const,
                hash_before: hashBefore,
                hash_after_expected: preview.hash_after,
                hash_after_actual: actual,
              },
            ],
          },
        }),
      };
      return {
        write: true,
        doc: replaceCandidate(doc, published),
        result: {
          phase: 'published' as const,
          candidate: published,
          revision: doc.revision + 1,
          publication_id: publicationId,
        },
      };
    });
  });
  if (result.phase === 'published') {
    await fireCrashHook('after_state');
    // State is committed and authoritative; the receipt (if any) is residue.
    await deleteReceipt(repo.paths, result.publication_id ?? '').catch(() => undefined);
  }
  return result;
}
