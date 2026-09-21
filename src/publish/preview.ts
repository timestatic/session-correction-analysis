import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { Candidate } from '../domain/candidates.js';
import { ScaError } from '../domain/errors.js';
import { sha256HashSchema, sha256Hex, sha256Tag } from '../domain/hash.js';
import { isoDateTimeSchema } from '../domain/ids.js';
import { PUBLISH_PREVIEW_TTL_MS, TARGET_FILE_MAX_BYTES } from '../domain/limits.js';
import { allowedActions } from '../domain/states.js';
import { hasCurrentApproval, contentVersionHash } from '../review/decide.js';
import { validateSchema } from '../store/frontmatter.js';
import type { ScaPaths } from '../store/paths.js';
import type { RecordRepository } from '../store/repository.js';
import { applyRule, lineDiff, ruleBlock } from './harness.js';
import { resolveTarget, type TargetEntry } from './targets.js';

/**
 * Publish preview (design 26.2): a preview pins candidate content hash and
 * document revision, the whitelisted target realpath, and the before/after
 * hashes plus the exact diff, with a hard expiry. Publishing only consumes a
 * preview; any content/target edit or external target change since then makes
 * the checks in publish.ts fail closed rather than re-planning the write.
 */

export const PREVIEW_SCHEMA_ID = 'session-correction-analysis/preview/v1';

export const previewIdSchema = z.string().regex(/^preview-[0-9a-f]{8}$/);
export type PreviewId = string;

export const previewRecordSchema = z
  .object({
    schema: z.literal(PREVIEW_SCHEMA_ID),
    preview_id: previewIdSchema,
    record_id: z.string().regex(/^[0-9a-f]{64}$/),
    candidate_id: z.string().regex(/^learning-\d{3,}$/),
    candidate_revision: z.number().int().positive(),
    candidate_content_hash: sha256HashSchema,
    target_id: z.string().min(1),
    display_path: z.string().min(1),
    realpath: z.string().regex(/^\//),
    hash_before: sha256HashSchema,
    hash_after: sha256HashSchema,
    diff: z.string(),
    rule_block: z.string().min(1),
    publish_mode: z.literal('deterministic'),
    created_at: isoDateTimeSchema,
    expires_at: isoDateTimeSchema,
  })
  .strict();
export type PreviewRecord = z.infer<typeof previewRecordSchema>;

export function previewsDir(paths: ScaPaths): string {
  return path.join(paths.runtimeDir, 'previews');
}

export function previewPath(paths: ScaPaths, previewId: string): string {
  if (!previewIdSchema.safeParse(previewId).success) {
    throw new ScaError('schema_invalid', `preview id ${previewId} is not a safe token`);
  }
  return path.join(previewsDir(paths), `${previewId}.json`);
}

export async function loadPreview(paths: ScaPaths, previewId: string): Promise<PreviewRecord> {
  const file = previewPath(paths, previewId);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new ScaError('preview_expired', `preview ${previewId} does not exist`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScaError('preview_expired', `preview ${previewId} is unreadable`);
  }
  return validateSchema(previewRecordSchema, parsed as Record<string, unknown>);
}

export function previewExpired(preview: PreviewRecord, now = new Date()): boolean {
  return Date.parse(preview.expires_at) <= now.getTime();
}

export interface PreviewOutcome {
  readonly preview: PreviewRecord;
  /** True when the rule text is already present: publishing would be a no-op. */
  readonly duplicate: boolean;
}

/** Gate shared by preview and publish; answers the catalogued error, never undefined. */
export function assertPublishGate(candidate: Candidate): void {
  if (candidate.target.kind !== 'harness') {
    throw new ScaError(
      'unsupported_operation',
      'memory candidates never enter the publish protocol; approve them and use copy/export content instead',
    );
  }
  if (!allowedActions(candidate).includes('publish_preview')) {
    throw new ScaError(
      'approval_missing',
      `candidate ${candidate.id} in status ${candidate.status} has no current approval for the publish flow`,
    );
  }
  if (!hasCurrentApproval(candidate)) {
    throw new ScaError(
      'approval_missing',
      `candidate ${candidate.id} was approved for a different content version; re-approve before publishing`,
    );
  }
}

export async function createPreview(
  repo: RecordRepository,
  recordId: string,
  opts: { candidateId: string; targetId?: string; ttlMs?: number; now?: Date },
): Promise<PreviewOutcome> {
  const now = opts.now ?? new Date();
  const { doc } = await repo.loadCandidates(recordId);
  const candidate = doc.candidates.find((c) => c.id === opts.candidateId);
  if (candidate === undefined) {
    throw new ScaError('schema_invalid', `no candidate ${opts.candidateId} in this record`);
  }
  if (candidate.rule_ref !== undefined) throw new ScaError('unsupported_operation', 'linked rules require the rule-version publication flow; legacy candidate preview is disabled');
  assertPublishGate(candidate);
  const selector: { targetId?: string; path?: string } = {};
  if (opts.targetId !== undefined) {
    selector.targetId = opts.targetId;
  } else if (candidate.target.kind === 'harness' && candidate.target.path !== undefined) {
    selector.path = candidate.target.path;
  }
  const entry: TargetEntry = await resolveTarget(repo.paths, selector);
  const before = await readTargetText(entry.realpath);
  const block = ruleBlock(candidate);
  const { after, duplicate } = applyRule(before, block);
  const previewId = `preview-${sha256Hex(
    JSON.stringify([recordId, candidate.id, contentVersionHash(candidate), entry.target_id, sha256Tag(before)]),
  ).slice(0, 8)}`;
  const preview = validateSchema(previewRecordSchema, {
    schema: PREVIEW_SCHEMA_ID,
    preview_id: previewId,
    record_id: recordId,
    candidate_id: candidate.id,
    candidate_revision: doc.revision,
    candidate_content_hash: contentVersionHash(candidate),
    target_id: entry.target_id,
    display_path: entry.display_path,
    realpath: entry.realpath,
    hash_before: sha256Tag(before),
    hash_after: sha256Tag(after),
    diff: duplicate ? '' : lineDiff(before, after),
    rule_block: block,
    publish_mode: 'deterministic',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (opts.ttlMs ?? PUBLISH_PREVIEW_TTL_MS)).toISOString(),
  });
  await fs.mkdir(previewsDir(repo.paths), { recursive: true });
  await fs.writeFile(previewPath(repo.paths, previewId), `${JSON.stringify(preview, null, 2)}\n`, 'utf8');
  return { preview, duplicate };
}

export async function readTargetText(realpath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(realpath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Whitelisted-but-not-yet-created files publish as new files.
      return '';
    }
    throw err;
  }
  if (Buffer.byteLength(raw, 'utf8') > TARGET_FILE_MAX_BYTES) {
    throw new ScaError(
      'payload_too_large',
      `target ${realpath} exceeds ${TARGET_FILE_MAX_BYTES} bytes; publishing refuses to touch oversized files`,
    );
  }
  return raw;
}
