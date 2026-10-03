import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { ScaError } from '../domain/errors.js';
import { stableHash, stableStringify } from '../domain/hash.js';
import { atomicWriteText } from '../store/atomic.js';
import { withAdvisoryLock } from '../store/lock.js';
import { resolvePaths } from '../store/paths.js';
import { sourceDifferences, sourceDifferenceSchema } from './diff.js';
import { buildBatch, loadBatch, persistBatch } from './index.js';
import { batchIdSchema, sourceInputSchema, type BatchManifest } from './schema.js';

export const appendInputSchema = z.object({
  schema: z.literal('session-correction-analysis/batch-append/v1'),
  batch_id: batchIdSchema,
  sources: z.array(sourceInputSchema).min(1),
}).strict();
export const lineageSchema = z.object({
  schema: z.literal('session-correction-analysis/batch-lineage/v1'),
  parent_batch_id: batchIdSchema,
  parent_manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  retained_source_ids: z.array(z.string()),
  appended_source_ids: z.array(z.string()),
  added_target_ids: z.array(z.string()),
  semantics_inherited: z.literal(false),
  source_differences: z.array(sourceDifferenceSchema).optional(),
}).strict();
export type BatchLineage = z.infer<typeof lineageSchema>;

export async function appendBatch(root: string, parentId: string, input: unknown): Promise<BatchLineage> {
  const request = appendInputSchema.parse(input);
  if (request.batch_id === parentId) throw new ScaError('schema_invalid', 'append requires a new immutable batch id');
  const parent = await loadBatch(root, parentId);
  const addition = await buildBatch({ schema: 'session-correction-analysis/batch-input/v1',
    batch_id: request.batch_id, scope: parent.scope, sources: request.sources });
  const retained = new Set(parent.sources.map(source => source.source_id));
  const addedSources = addition.sources.filter(source => !retained.has(source.source_id));
  if (addedSources.length === 0) throw new ScaError('schema_invalid', 'append contains no new source snapshot');
  const addedIds = new Set(addedSources.map(source => source.source_id));
  const evidenceIds = new Set([...parent.sources, ...addedSources].flatMap(source => source.events.map(item => item.evidence_id)));
  for (const source of addedSources) for (const item of source.events) {
    if (item.reading_reuse_of !== undefined && !evidenceIds.has(item.reading_reuse_of)) delete item.reading_reuse_of;
  }
  const bodies = new Map<string, string>();
  for (const source of parent.sources) for (const item of source.events) {
    if (!bodies.has(item.event.text ?? '')) bodies.set(item.event.text ?? '', item.evidence_id);
  }
  for (const source of addedSources) for (const item of source.events) {
    const text = item.event.text ?? '';
    const prior = bodies.get(text);
    if (prior !== undefined) item.reading_reuse_of = prior;
    else bodies.set(text, item.evidence_id);
  }
  const targets = addition.targets.filter(target => addedIds.has(target.source_id)).map(target => {
    const { reuse_candidate_of: _candidate, ...independent } = target;
    return independent;
  });
  const manifest: BatchManifest = { ...parent, batch_id: request.batch_id,
    sources: [...parent.sources, ...addedSources], targets: [...parent.targets, ...targets] };
  const lineage = lineageSchema.parse({ schema: 'session-correction-analysis/batch-lineage/v1',
    parent_batch_id: parentId, parent_manifest_hash: stableHash(parent), manifest_hash: stableHash(manifest),
    retained_source_ids: parent.sources.map(source => source.source_id),
    appended_source_ids: addedSources.map(source => source.source_id),
    added_target_ids: targets.map(target => target.target_id), semantics_inherited: false,
    source_differences: sourceDifferences(manifest).filter(diff => addedIds.has(diff.left_source_id) || addedIds.has(diff.right_source_id)) });
  // One outer lock makes creation plus lineage repair retryable without replacing the parent.
  return withAdvisoryLock(resolvePaths(root), `batch-${request.batch_id}`, async () => {
    await persistBatch(root, manifest);
    const dir = path.join(resolvePaths(root).root, 'batches', request.batch_id);
    const file = path.join(dir, 'lineage.json');
    try {
      const existing = lineageSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')) as unknown);
      const comparable = existing.source_differences === undefined
        ? { ...lineage, source_differences: undefined } : lineage;
      if (stableHash(existing) !== stableHash(comparable)) throw new ScaError('schema_invalid', 'batch lineage conflict');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await atomicWriteText(dir, 'lineage.json', stableStringify(lineage), 0o600);
    }
    return lineage;
  });
}
