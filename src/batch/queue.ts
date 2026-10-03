import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { ScaError } from '../domain/errors.js';
import { stableHash, stableStringify } from '../domain/hash.js';
import { atomicWriteText } from '../store/atomic.js';
import { withAdvisoryLock } from '../store/lock.js';
import { resolvePaths } from '../store/paths.js';
import { loadBatch, loadBatchReadContext, readLedger, submitBatch } from './index.js';
import { batchSubmissionSchema, batchIdSchema, pageCursorSchema, type BatchManifest } from './schema.js';
import { evidencePage } from './index.js';
import { planTasks, taskPlanOptionsSchema, analysisTaskSchema, type AnalysisTask } from './tasks.js';

const taskEntrySchema = z.object({
  task_id: z.string().min(1), target_ids: z.array(z.string().min(1)).min(1).refine(ids => new Set(ids).size === ids.length, 'duplicate task target'),
  status: z.enum(['running', 'submitted', 'failed', 'cancelled']),
  owner: batchIdSchema, generation: z.number().int().positive(),
  expires_at: z.number().int().nonnegative(), attempts: z.number().int().positive(),
  failure: z.enum(['worker_error', 'budget_exceeded', 'cancelled', 'partial_result']).optional(),
  cursor: pageCursorSchema.optional(),
  completed_evidence_ids: z.array(z.string().min(1)).optional(),
  claim_request_id: batchIdSchema.optional(),
  claim_request_hash: z.string().optional(),
  task: analysisTaskSchema.optional(),
}).strict();
const queueSchema = z.object({
  schema: z.literal('session-correction-analysis/batch-queue/v1'),
  manifest_hash: z.string(), revision: z.number().int().nonnegative(),
  tasks: z.array(taskEntrySchema),
  claim_log: z.array(z.object({ request_id: batchIdSchema, request_hash: z.string(), task_id: z.string(), generation: z.number().int().positive() }).strict()).optional(),
}).strict();
type Queue = z.infer<typeof queueSchema>;
export const claimSchema = z.object({
  request_id: batchIdSchema.optional(),
  owner: batchIdSchema, worker_ready: z.literal(true),
  ttl_ms: z.number().int().min(1000).max(3_600_000),
  max_concurrency: z.number().int().min(1).max(4),
  plan: taskPlanOptionsSchema,
}).strict();
export const taskReceiptSchema = z.object({
  task_id: z.string().min(1), owner: batchIdSchema,
  generation: z.number().int().positive(),
  outcome: z.enum(['submitted', 'failed', 'cancelled']),
  failure: z.enum(['worker_error', 'budget_exceeded', 'cancelled', 'partial_result']).optional(),
}).strict();

function queuePath(root: string, id: string): string {
  return path.join(resolvePaths(root).root, 'batches', batchIdSchema.parse(id), 'queue.json');
}
async function loadQueue(root: string, id: string, manifest: BatchManifest): Promise<Queue> {
  const hash = stableHash(manifest);
  const targets = new Map(manifest.targets.map(target => [target.target_id, target]));
  const evidence = new Set(manifest.sources.flatMap(source => source.events.map(event => event.evidence_id)));
  try {
    const queue = queueSchema.parse(JSON.parse(await fs.readFile(queuePath(root, id), 'utf8')) as unknown);
    if (queue.manifest_hash !== hash || queue.tasks.some(task => task.cursor !== undefined && task.cursor.manifest_hash !== hash) || new Set(queue.tasks.map(task => task.task_id)).size !== queue.tasks.length) throw new ScaError('schema_invalid', 'queue identity mismatch');
    if (new Set(queue.claim_log?.map(entry => entry.request_id) ?? []).size !== (queue.claim_log?.length ?? 0)) throw new ScaError('schema_invalid', 'duplicate claim request history');
    for (const logged of queue.claim_log ?? []) {
      const entry = queue.tasks.find(task => task.task_id === logged.task_id);
      if (entry === undefined || logged.generation > entry.generation) throw new ScaError('schema_invalid', 'claim history generation mismatch');
    }
    for (const entry of queue.tasks) {
      if (entry.target_ids.some(id => !targets.has(id))) throw new ScaError('schema_invalid', 'queue target not in snapshot');
      if (entry.completed_evidence_ids?.some(id => !entry.task?.evidence_ids.includes(id))) throw new ScaError('schema_invalid', 'checkpoint evidence is outside task');
      if (entry.cursor !== undefined) evidencePage(manifest, { max_bytes: 1_048_576, cursor: entry.cursor });
      if (entry.task !== undefined && (entry.task.evidence_ids.some(id => !evidence.has(id)) || entry.task.targets.some(target => targets.get(target.target_id)?.evidence_id !== target.evidence_id || target.unresolved_evidence_ids.some(id => !evidence.has(id))))) throw new ScaError('schema_invalid', 'queue task evidence mismatch');
      if ((entry.claim_request_id === undefined) !== (entry.claim_request_hash === undefined)) throw new ScaError('schema_invalid', 'incomplete claim identity');
      if (entry.claim_request_id !== undefined && !queue.claim_log?.some(logged => logged.request_id === entry.claim_request_id && logged.task_id === entry.task_id && logged.generation === entry.generation && logged.request_hash === entry.claim_request_hash)) throw new ScaError('schema_invalid', 'claim receipt history mismatch');
      if (entry.task !== undefined && (entry.task.manifest_hash !== hash || entry.task.task_id !== entry.task_id || stableStringify(entry.task.targets.map(target => target.target_id).sort()) !== stableStringify([...entry.target_ids].sort()))) throw new ScaError('schema_invalid', 'queue task target identity mismatch');
    }
    return queue;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new ScaError('schema_invalid', 'batch queue is malformed; preserve private state and inspect the protocol');
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return { schema: 'session-correction-analysis/batch-queue/v1', manifest_hash: hash, revision: 0, tasks: [] };
  }
}
export const taskSubmissionSchema = z.object({
  task_id: z.string().min(1), owner: batchIdSchema, generation: z.number().int().positive(),
  submission: batchSubmissionSchema,
}).strict();

export async function submitTask(root: string, id: string, input: unknown, now?: number): Promise<{ duplicate: boolean; revision: number }> {
  const request = taskSubmissionSchema.parse(input);
  return withAdvisoryLock(resolvePaths(root), `batch-${batchIdSchema.parse(id)}`, async () => {
    const operationNow = now ?? Date.now();
    const manifest = await loadBatch(root, id);
    const queue = await loadQueue(root, id, manifest);
    const task = queue.tasks.find(entry => entry.task_id === request.task_id);
    const ledger = await readLedger(root, manifest);
    const replay = ledger.history.find(transaction => transaction.request_id === request.submission.request_id);
    if (replay !== undefined) {
      if (task === undefined || task.owner !== request.owner || task.generation !== request.generation || request.submission.judgments.some(judgment => !task.target_ids.includes(judgment.target_id))) throw new ScaError('revision_conflict', 'stale task replay fence');
      if (replay.request_hash !== stableHash(request.submission)) throw new ScaError('schema_invalid', 'submission request payload conflict');
      return { duplicate: true, revision: ledger.revision };
    }
    if (task === undefined || task.owner !== request.owner || task.generation !== request.generation || task.status !== 'running') throw new ScaError('revision_conflict', 'stale task submission fence');
    if (task.expires_at <= operationNow) throw new ScaError('lease_expired');
    if (request.submission.judgments.some(judgment => !task.target_ids.includes(judgment.target_id))) throw new ScaError('schema_invalid', 'submission target is outside claimed task');
    return submitBatch(root, id, request.submission);
  });
}

export const heartbeatSchema = z.object({
  task_id: z.string().min(1), owner: batchIdSchema, generation: z.number().int().positive(),
  ttl_ms: z.number().int().min(1000).max(3_600_000),
  cursor: pageCursorSchema.optional(),
  completed_evidence_ids: z.array(z.string().min(1)).optional(),
  clear_cursor: z.boolean().optional(),
}).strict();

export async function heartbeatTask(root: string, id: string, input: unknown, now?: number): Promise<{ expires_at: number }> {
  const request = heartbeatSchema.parse(input);
  return withAdvisoryLock(resolvePaths(root), `batch-${batchIdSchema.parse(id)}`, async () => {
    const operationNow = now ?? Date.now();
    const manifest = await loadBatch(root, id);
    const queue = await loadQueue(root, id, manifest);
    const task = queue.tasks.find(entry => entry.task_id === request.task_id);
    if (task === undefined || task.owner !== request.owner || task.generation !== request.generation || task.status !== 'running') throw new ScaError('revision_conflict', 'stale heartbeat fence');
    if (task.expires_at <= operationNow) throw new ScaError('lease_expired');
    if (request.clear_cursor === true && request.cursor !== undefined) throw new ScaError('schema_invalid', 'use cursor or clear_cursor');
    if (request.clear_cursor === true) delete task.cursor;
    if (request.cursor !== undefined) {
      const evidence = manifest.sources[request.cursor.source_index]?.events[request.cursor.event_index]?.evidence_id;
      if (request.completed_evidence_ids !== undefined && (request.cursor.expand !== true || evidence === undefined || !task.task?.evidence_ids.includes(evidence))) throw new ScaError('schema_invalid', 'checkpoint cursor is outside task');
      evidencePage(manifest, { max_bytes: 1_048_576, cursor: request.cursor });
      task.cursor = request.cursor;
    }
    if (request.completed_evidence_ids !== undefined) {
      if (request.completed_evidence_ids.some(id => !task.task?.evidence_ids.includes(id))) throw new ScaError('schema_invalid', 'checkpoint evidence is outside task');
      task.completed_evidence_ids = [...new Set([...(task.completed_evidence_ids ?? []), ...request.completed_evidence_ids])];
    }
    task.expires_at = Math.max(task.expires_at, operationNow + request.ttl_ms);
    await saveQueue(root, id, queue);
    return { expires_at: task.expires_at };
  });
}

export async function queueStatus(root: string, id: string, now = Date.now()): Promise<{
  revision: number; running: number; expired: number; submitted: number; failed: number; cancelled: number;
  tasks: Queue['tasks'];
}> {
  const manifest = await loadBatch(root, id);
  const queue = await loadQueue(root, id, manifest);
  const operationNow = now;
  return { revision: queue.revision, running: queue.tasks.filter(task => task.status === 'running' && task.expires_at > operationNow).length,
    expired: queue.tasks.filter(task => task.status === 'running' && task.expires_at <= operationNow).length,
    submitted: queue.tasks.filter(task => task.status === 'submitted').length,
    failed: queue.tasks.filter(task => task.status === 'failed').length,
    cancelled: queue.tasks.filter(task => task.status === 'cancelled').length, tasks: queue.tasks };
}

async function saveQueue(root: string, id: string, queue: Queue): Promise<void> {
  const file = queuePath(root, id);
  await atomicWriteText(path.dirname(file), path.basename(file), stableStringify(queueSchema.parse({ ...queue, revision: queue.revision + 1 })), 0o600);
}

export async function claimTask(root: string, id: string, input: unknown, now?: number): Promise<{
  task: AnalysisTask | null; generation: number | null; expires_at: number | null; active: number;
  cursor?: z.infer<typeof pageCursorSchema>;
  completed_evidence_ids?: string[];
}> {
  const request = claimSchema.parse(input);
  return withAdvisoryLock(resolvePaths(root), `batch-${batchIdSchema.parse(id)}`, async () => {
    const context = await loadBatchReadContext(root, id);
    const plan = planTasks(context, await readLedger(root, context), request.plan);
    const queue = await loadQueue(root, id, context.manifest);
    const operationNow = now ?? Date.now();
    const active = queue.tasks.filter(task => task.status === 'running' && task.expires_at > operationNow);
    if (request.request_id !== undefined) {
      const logged = queue.claim_log?.find(entry => entry.request_id === request.request_id);
      const replay = queue.tasks.find(entry => entry.claim_request_id === request.request_id);
      if (logged !== undefined && (logged.request_hash !== stableHash(request) || replay === undefined || logged.generation !== replay.generation)) throw new ScaError('revision_conflict', 'claim request belongs to a prior generation or different payload');
      if (replay !== undefined) {
        if (replay.claim_request_hash !== stableHash(request)) throw new ScaError('schema_invalid', 'claim request payload conflict');
        if (replay.status !== 'running' || replay.expires_at <= operationNow) throw new ScaError('lease_expired', 'claim request is terminal or expired; use a new request id');
        if (replay.task === undefined) throw new ScaError('schema_invalid', 'claim replay task unavailable');
        return { task: replay.task, generation: replay.generation, expires_at: replay.expires_at, active: active.length,
          ...(replay.cursor === undefined ? {} : { cursor: replay.cursor }),
          ...(replay.completed_evidence_ids === undefined ? {} : { completed_evidence_ids: replay.completed_evidence_ids }) };
      }
    }
    const eligible = (task: AnalysisTask): boolean => !active.some(entry => entry.target_ids.some(target => task.targets.some(item => item.target_id === target)));
    if (active.length >= request.max_concurrency) return { task: null, generation: null, expires_at: null, active: active.length };
    const task = plan.tasks.find(eligible);
    if (task === undefined) return { task: null, generation: null, expires_at: null, active: active.length };
    const previous = queue.tasks.find(entry => entry.task_id === task.task_id);
    const generation = (previous?.generation ?? 0) + 1;
    const claimedTask = previous?.task ?? task;
    const replacement = { task_id: task.task_id, target_ids: task.targets.map(item => item.target_id),
      status: 'running' as const, owner: request.owner, generation, expires_at: operationNow + request.ttl_ms,
      attempts: (previous?.attempts ?? 0) + 1, task: claimedTask,
      ...(request.request_id === undefined ? {} : { claim_request_id: request.request_id, claim_request_hash: stableHash(request) }),
      ...(previous?.cursor === undefined ? {} : { cursor: previous.cursor }),
      ...(previous?.completed_evidence_ids === undefined ? {} : { completed_evidence_ids: previous.completed_evidence_ids }) };
    queue.tasks = [...queue.tasks.filter(entry => entry.task_id !== task.task_id), replacement];
    if (request.request_id !== undefined) queue.claim_log = [...(queue.claim_log ?? []), {
      request_id: request.request_id, request_hash: stableHash(request), task_id: task.task_id, generation,
    }];
    await saveQueue(root, id, queue);
    return { task: claimedTask, generation, expires_at: replacement.expires_at, active: active.length + 1,
      ...(replacement.cursor === undefined ? {} : { cursor: replacement.cursor }),
      ...(replacement.completed_evidence_ids === undefined ? {} : { completed_evidence_ids: replacement.completed_evidence_ids }) };
  });
}

export async function finishTask(root: string, id: string, input: unknown, now?: number): Promise<{ duplicate: boolean }> {
  const receipt = taskReceiptSchema.parse(input);
  return withAdvisoryLock(resolvePaths(root), `batch-${batchIdSchema.parse(id)}`, async () => {
    const operationNow = now ?? Date.now();
    const manifest = await loadBatch(root, id);
    const queue = await loadQueue(root, id, manifest);
    const entry = queue.tasks.find(task => task.task_id === receipt.task_id);
    if (entry === undefined || entry.owner !== receipt.owner || entry.generation !== receipt.generation) throw new ScaError('revision_conflict', 'stale task fence');
    if (entry.status !== 'running') {
      if (entry.status === receipt.outcome && entry.failure === receipt.failure) return { duplicate: true };
      throw new ScaError('revision_conflict', 'task receipt outcome conflict');
    }
    if (entry.expires_at <= operationNow) throw new ScaError('lease_expired');
    if (receipt.outcome === 'submitted') {
      if (receipt.failure !== undefined) throw new ScaError('schema_invalid', 'submitted receipt cannot contain failure');
      const ledger = await readLedger(root, manifest);
      const sufficient = new Map<string, boolean>();
      for (const transaction of ledger.history) for (const judgment of transaction.judgments) sufficient.set(judgment.target_id,
        judgment.judgment !== 'uncertain' && judgment.evidence_status === 'sufficient' && judgment.unresolved_evidence_ids.length === 0);
      if (!entry.target_ids.every(target => sufficient.get(target) === true)) throw new ScaError('coverage_incomplete', 'task targets do not all have sufficient submitted judgments');
    } else if (receipt.failure === undefined) throw new ScaError('schema_invalid', 'failure or cancellation requires classified reason');
    entry.status = receipt.outcome;
    if (receipt.failure !== undefined) entry.failure = receipt.failure;
    await saveQueue(root, id, queue);
    return { duplicate: false };
  });
}

export const contextRequestSchema = z.object({
  task_id: z.string().min(1), owner: batchIdSchema, generation: z.number().int().positive(),
  target_id: z.string().min(1), before: z.number().int().min(0).max(32), after: z.number().int().min(0).max(32),
}).strict();

export async function requestTaskContext(root: string, id: string, input: unknown, now?: number): Promise<string[]> {
  const request = contextRequestSchema.parse(input);
  return withAdvisoryLock(resolvePaths(root), `batch-${batchIdSchema.parse(id)}`, async () => {
    const context = await loadBatchReadContext(root, id);
    const queue = await loadQueue(root, id, context.manifest);
    const task = queue.tasks.find(entry => entry.task_id === request.task_id);
    if (task === undefined || task.task === undefined || task.owner !== request.owner || task.generation !== request.generation || task.status !== 'running') throw new ScaError('revision_conflict', 'stale context request fence');
    if (task.expires_at <= (now ?? Date.now())) throw new ScaError('lease_expired');
    const target = task.task.targets.find(target => target.target_id === request.target_id);
    if (target === undefined) throw new ScaError('schema_invalid', 'context target is outside task');
    const position = context.position(target.evidence_id);
    if (position === undefined) throw new ScaError('evidence_not_found');
    const extra = position.source.events.slice(Math.max(0, position.event_index - request.before), position.event_index + request.after + 1).map(event => event.evidence_id);
    const ids = [...new Set([...task.task.evidence_ids, ...extra])];
    const bytes = ids.reduce((sum, evidence) => sum + context.evidenceCost(evidence), 0);
    if (ids.length > 512 || bytes > 16 * 1024 * 1024) throw new ScaError('payload_too_large', 'context request exceeds task evidence limit');
    task.task.evidence_ids = ids;
    task.task.estimated_evidence_bytes = bytes;
    task.task.requires_paging = true;
    await saveQueue(root, id, queue);
    return ids;
  });
}
