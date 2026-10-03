import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { checkBudget, budgetInputSchema } from './budget.js';
import type { BudgetReport } from './budget.js';
import { ScaError } from '../domain/errors.js';
import { loadBatchReadContext, createEvidencePager, readLedger, batchStatusFromContext } from './index.js';
import { claimSchema, claimTask, heartbeatTask, submitTask, finishTask, requestTaskContext, queueStatus } from './queue.js';
import { pageRequestSchema, batchSubmissionSchema } from './schema.js';
import type { PageCursor } from './schema.js';
import type { BatchStatus } from './index.js';
import type { BatchReadContext } from './runtime.js';
import type { AnalysisTask } from './tasks.js';

export interface WorkerContext {
  signal: AbortSignal | undefined;
  lease: Readonly<{ task_id: string; owner: string; generation: number }>;
  task: AnalysisTask;
  cursor: PageCursor | undefined;
  page: (input: unknown) => ReturnType<ReturnType<typeof createEvidencePager>>;
  heartbeat: (cursor?: PageCursor) => Promise<{ expires_at: number }>;
  checkpoint: (cursor?: PageCursor) => Promise<{ expires_at: number }>;
  requestContext: (input: { target_id: string; before: number; after: number }) => Promise<string[]>;
  completed_evidence_ids: readonly string[];
}
export type BatchWorker = (context: WorkerContext) => Promise<unknown>;

export async function runBatchWorker(root: string, id: string, input: unknown, worker: BatchWorker, signal?: AbortSignal, budgetInput?: unknown, readContext?: BatchReadContext): Promise<{
  outcome: 'idle' | 'submitted' | 'cancelled' | 'partial' | 'budget_blocked'; revision?: number; budget?: BudgetReport;
}> {
  const request = claimSchema.parse(input);
  const isCancelled = (): boolean => signal?.aborted === true;
  if (isCancelled()) return { outcome: 'cancelled' };
  if (budgetInput !== undefined) {
    const parsedBudget = budgetInputSchema.safeParse(budgetInput);
    if (!parsedBudget.success) throw new ScaError('schema_invalid', 'worker budget input is invalid; inspect the budget protocol');
    const budget = checkBudget(parsedBudget.data);
    if (budget.status === 'exceeded' || budget.status === 'indeterminate') return { outcome: 'budget_blocked', budget };
  }
  const claim = await claimTask(root, id, request);
  if (claim.task === null || claim.generation === null) return { outcome: 'idle' };
  const fence = { task_id: claim.task.task_id, owner: request.owner, generation: claim.generation };
  const context = readContext ?? await loadBatchReadContext(root, id);
  if (context.manifest.batch_id !== id || context.manifest_hash !== claim.task.manifest_hash) throw new ScaError('revision_conflict', 'worker snapshot mismatch');
  const manifest = context.manifest;
  const allowed = new Set(claim.task.evidence_ids);
  const pager = createEvidencePager(context);
  const completed = new Set(claim.completed_evidence_ids ?? []);
  const ranges = new Map<string, number>();
  let lastCursor = claim.cursor;
  if (claim.cursor !== undefined) {
    const event = manifest.sources[claim.cursor.source_index]?.events[claim.cursor.event_index];
    if (event !== undefined && allowed.has(event.evidence_id)) ranges.set(event.evidence_id, claim.cursor.text_offset);
  }
  let active = true;
  let expiresAt = claim.expires_at ?? 0;
  const checkActive = (): void => {
    if (isCancelled() || !active) throw new ScaError('revision_conflict', 'worker callback has closed');
    if (Date.now() >= expiresAt) throw new ScaError('lease_expired');
  };
  const checkCursor = (cursor: PageCursor): void => {
    const evidence = manifest.sources[cursor.source_index]?.events[cursor.event_index]?.evidence_id;
    if (cursor.expand !== true || evidence === undefined || !allowed.has(evidence)) throw new ScaError('schema_invalid', 'worker cursor must expand evidence from the claimed task');
  };
  let result: unknown;
  try {
    checkActive();
    result = await worker({ signal, lease: Object.freeze({ ...fence }), task: structuredClone(claim.task), cursor: claim.cursor, completed_evidence_ids: [...completed],
      page: input => {
        checkActive();
        const page = pageRequestSchema.parse(input);
        if (page.cursor !== undefined) checkCursor(page.cursor);
        else if (page.evidence_id === undefined || !allowed.has(page.evidence_id)) throw new ScaError('schema_invalid', 'worker pages require an evidence id from the claimed task');
        const output = pager(page);
        for (const item of output.items) {
          const prefix = ranges.get(item.evidence_id) ?? 0;
          if (item.text_offset <= prefix && item.reading_reuse_of === undefined) {
            ranges.set(item.evidence_id, Math.max(prefix, item.text_offset + item.text.length));
            if (item.complete) completed.add(item.evidence_id);
          }
        }
        lastCursor = output.next_cursor ?? undefined;
        return output;
      },
      heartbeat: async cursor => {
        checkActive();
        if (cursor !== undefined) checkCursor(cursor);
        const receipt = await heartbeatTask(root, id, { ...fence, ttl_ms: request.ttl_ms, ...(cursor === undefined ? {} : { cursor }) });
        expiresAt = receipt.expires_at;
        return receipt;
      },
      checkpoint: async cursor => {
        checkActive();
        const checkpoint = cursor ?? lastCursor;
        if (checkpoint !== undefined) checkCursor(checkpoint);
        const receipt = await heartbeatTask(root, id, { ...fence, ttl_ms: request.ttl_ms,
          completed_evidence_ids: [...completed], ...(checkpoint === undefined ? { clear_cursor: true } : { cursor: checkpoint }) });
        expiresAt = receipt.expires_at;
        return receipt;
      },
      requestContext: async input => {
        checkActive();
        const ids = await requestTaskContext(root, id, { ...input, ...fence });
        checkActive();
        for (const evidence of ids) allowed.add(evidence);
        return ids;
      },
    });
  } catch {
    active = false;
    if (isCancelled()) {
      await finishTask(root, id, { ...fence, outcome: 'cancelled', failure: 'cancelled' });
      return { outcome: 'cancelled' };
    }
    await finishTask(root, id, { ...fence, outcome: 'failed', failure: 'worker_error' });
    throw new ScaError('schema_invalid', 'worker execution failed; inspect private worker diagnostics without transcript logging');
  }
  active = false;
  if (isCancelled()) {
    await finishTask(root, id, { ...fence, outcome: 'cancelled', failure: 'cancelled' });
    return { outcome: 'cancelled' };
  }
  const parsed = batchSubmissionSchema.safeParse(result);
  if (!parsed.success) throw new ScaError('schema_invalid', 'worker submission is invalid; inspect the batch protocol and private result without transcript logging');
  const submission = parsed.data;
  const receipt = await submitTask(root, id, { ...fence, submission });
  const ledger = await readLedger(root, context);
  const sufficient = new Map<string, boolean>();
  for (const transaction of ledger.history) for (const judgment of transaction.judgments) sufficient.set(judgment.target_id,
    judgment.judgment !== 'uncertain' && judgment.evidence_status === 'sufficient' && judgment.unresolved_evidence_ids.length === 0);
  if (!claim.task.targets.every(target => sufficient.get(target.target_id) === true)) return { outcome: 'partial', revision: receipt.revision };
  await finishTask(root, id, { ...fence, outcome: 'submitted' });
  return { outcome: 'submitted', revision: receipt.revision };
}

const loopOptionsSchema = z.object({
  claim: claimSchema, max_tasks: z.number().int().min(1).max(10000),
}).strict();
export interface BatchLoopResult {
  outcome: 'complete' | 'parsed_complete' | 'idle' | 'task_limit' | 'no_progress' | 'cancelled' | 'budget_blocked';
  processed_tasks: number;
  read_context_loads: number;
  status: BatchStatus;
}

export async function runBatchLoop(root: string, id: string, input: unknown, worker: BatchWorker, signal?: AbortSignal,
  budget?: () => Promise<unknown>): Promise<BatchLoopResult> {
  const options = loopOptionsSchema.parse(input);
  const context = await loadBatchReadContext(root, id);
  let status = batchStatusFromContext(context, await readLedger(root, context));
  let processed = 0;
  const report = (outcome: BatchLoopResult['outcome']): BatchLoopResult => ({ outcome, processed_tasks: processed, read_context_loads: 1, status });
  while (processed < options.max_tasks) {
    if (signal?.aborted === true) return report('cancelled');
    const before = status.semantic_complete;
    const queue = await queueStatus(root, id);
    const own = queue.tasks.find(task => task.owner === options.claim.owner && task.status === 'running' && task.expires_at > Date.now());
    const requestId = own?.claim_request_id ?? `loop-${randomUUID()}`;
    if (own?.task !== undefined) {
      const ledger = await readLedger(root, context);
      const versions = new Map<string, number>();
      const sufficient = new Set<string>();
      for (const transaction of ledger.history) for (const judgment of transaction.judgments) {
        versions.set(judgment.target_id, (versions.get(judgment.target_id) ?? 0) + 1);
        if (judgment.judgment !== 'uncertain' && judgment.evidence_status === 'sufficient') sufficient.add(judgment.target_id);
        else sufficient.delete(judgment.target_id);
      }
      if (own.task.targets.some(target => (versions.get(target.target_id) ?? 0) !== target.expected_version)) {
        const all = own.target_ids.every(target => sufficient.has(target));
        await finishTask(root, id, { task_id: own.task_id, owner: own.owner, generation: own.generation,
          outcome: all ? 'submitted' : 'failed', ...(all ? {} : { failure: 'partial_result' }) });
        continue;
      }
    }
    if (status.semantic_complete === status.targets) return report(status.coverage === 'full' ? 'complete' : 'parsed_complete');
    const current: { lease?: WorkerContext['lease'] } = {};
    const result = await runBatchWorker(root, id, { ...options.claim,
      request_id: requestId, plan: { ...options.claim.plan, context_mode: options.claim.plan.context_mode ?? 'turn' } },
    context => { current.lease = context.lease; return worker(context); }, signal, budget === undefined ? undefined : await budget(), context);
    status = batchStatusFromContext(context, await readLedger(root, context));
    if (result.outcome === 'idle' || result.outcome === 'cancelled' || result.outcome === 'budget_blocked') return report(result.outcome);
    processed += 1;
    if (result.outcome === 'partial' && current.lease !== undefined) {
      await finishTask(root, id, { ...current.lease,
        outcome: 'failed', failure: 'partial_result' });
    }
    if (status.semantic_complete <= before) return report('no_progress');
  }
  return report(status.semantic_complete === status.targets ? (status.coverage === 'full' ? 'complete' : 'parsed_complete') : 'task_limit');
}
