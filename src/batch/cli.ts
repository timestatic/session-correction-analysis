import { ZodError } from 'zod';

import { ScaError } from '../domain/errors.js';
import { readBoundedFile } from '../store/bounded.js';
import { appendBatch } from './append.js';
import { sourceDifferences } from './diff.js';
import { summarizeUsage } from './usage.js';
import { batchAuditPlan } from './audit.js';
import { checkBudget } from './budget.js';
import { identityInventory } from './identity.js';
import { reworkEvidencePairs } from './rework.js';
import { batchCandidates, batchCandidateDetail } from './candidates.js';
import { stableHash } from '../domain/hash.js';
import { batchTaskPlan } from './tasks.js';
import { claimTask, finishTask, submitTask, heartbeatTask, queueStatus, requestTaskContext } from './queue.js';
import { batchStatus, createEvidencePager, loadBatchReadContext, loadBatch, saveBatch, submitBatch } from './index.js';

async function runBatchCommandUnsafe(
  values: Record<string, string | boolean | string[] | undefined>,
  stdout: (line: string) => void,
): Promise<number> {
  const string = (key: string): string | undefined => typeof values[key] === 'string' ? values[key] : undefined;
  const root = string('data-root');
  if (root === undefined) throw new ScaError('schema_invalid', 'batch requires explicit --data-root for isolated storage');
  const action = string('action');
  const id = string('batch');
  const file = string('input');
  const parseJson = (text: string): unknown => {
    try { return JSON.parse(text) as unknown; }
    catch { throw new ScaError('schema_invalid', 'batch input or cursor is not valid JSON; correct the JSON syntax'); }
  };
  const readInput = async (): Promise<unknown> => {
    if (file === undefined) throw new ScaError('schema_invalid', 'action requires --input JSON file');
    return parseJson(await readBoundedFile(file, 64 * 1024 * 1024));
  };
  if (action === 'budget') {
    stdout(JSON.stringify(checkBudget(await readInput())));
    return 0;
  }
  if (action === 'usage') {
    stdout(JSON.stringify(summarizeUsage(await readInput())));
    return 0;
  }
  if (action === 'create') {
    const manifest = await saveBatch(root, await readInput());
    stdout(JSON.stringify({ ok: true, batch_id: manifest.batch_id, sources: manifest.sources.length,
      targets: manifest.targets.length, next_step: 'batch --action page with --batch and explicit --data-root' }));
    return 0;
  }
  if (id === undefined) throw new ScaError('schema_invalid', 'action requires --batch');
  if (action === 'append') stdout(JSON.stringify(await appendBatch(root, id, await readInput())));
  else if (action === 'diff') {
    const offset = Number(string('offset') ?? '0');
    const limit = Number(string('limit') ?? '20');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ScaError('schema_invalid', 'diff offset must be nonnegative and limit must be 1..100');
    const differences = sourceDifferences(await loadBatch(root, id));
    stdout(JSON.stringify({ total: differences.length, differences: differences.slice(offset, offset + limit),
      next_offset: offset + limit < differences.length ? offset + limit : null }));
  }
  else if (action === 'tasks') {
    const offset = Number(string('offset') ?? '0');
    const limit = Number(string('limit') ?? '20');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ScaError('schema_invalid', 'tasks offset must be nonnegative and limit must be 1..100');
    const plan = await batchTaskPlan(root, id, { evidence_budget_bytes: Number(string('max-bytes') ?? '32768'),
      max_targets: Number(string('max-targets') ?? '20'), context_events: Number(string('context-events') ?? '1'),
      ...(string('context-mode') === undefined ? {} : { context_mode: string('context-mode') }) });
    stdout(JSON.stringify({ ...plan, total_tasks: plan.tasks.length, tasks: plan.tasks.slice(offset, offset + limit),
      next_offset: offset + limit < plan.tasks.length ? offset + limit : null }));
  }
  else if (action === 'candidate-detail') stdout(JSON.stringify(await batchCandidateDetail(root, id, await readInput())));
  else if (action === 'candidates') {
    const offset = Number(string('offset') ?? '0');
    const limit = Number(string('limit') ?? '20');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ScaError('schema_invalid', 'candidates offset must be nonnegative and limit must be 1..100');
    const view = await batchCandidates(root, id);
    stdout(JSON.stringify({ ...view, total_candidates: view.candidates.length, candidates: view.candidates.slice(offset, offset + limit),
      next_offset: offset + limit < view.candidates.length ? offset + limit : null,
      warning: 'Unreviewed isolated suggestions only; content omitted, hashes are not anonymization. No old record decisions or rules changed.' }));
  }
  else if (action === 'rework') {
    const offset = Number(string('offset') ?? '0');
    const limit = Number(string('limit') ?? '20');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ScaError('schema_invalid', 'rework offset must be nonnegative and limit must be 1..100');
    const pairs = reworkEvidencePairs(await loadBatch(root, id));
    stdout(JSON.stringify({ total_pairs: pairs.length, pairs: pairs.slice(offset, offset + limit).map(pair => {
      const { shared_paths, ...references } = pair;
      return { ...references, shared_path_hashes: shared_paths.map(file => stableHash(file)) };
    }), next_offset: offset + limit < pairs.length ? offset + limit : null,
    warning: 'Mechanical edit/result evidence only; not verified rework causality or candidate approval. Path hashes are not anonymization.' }));
  }
  else if (action === 'identity') {
    const offset = Number(string('offset') ?? '0');
    const limit = Number(string('limit') ?? '20');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ScaError('schema_invalid', 'identity offset must be nonnegative and limit must be 1..100');
    const inventory = identityInventory(await loadBatch(root, id));
    stdout(JSON.stringify({ ...inventory, total_issues: inventory.issues.length, issues: inventory.issues.slice(offset, offset + limit),
      next_offset: offset + limit < inventory.issues.length ? offset + limit : null }));
  }
  else if (action === 'audit') {
    const offset = Number(string('offset') ?? '0');
    const limit = Number(string('limit') ?? '20');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ScaError('schema_invalid', 'audit offset must be nonnegative and limit must be 1..100');
    const plan = await batchAuditPlan(root, id, await readInput());
    stdout(JSON.stringify({ ...plan, pending_targets: plan.pending_target_ids.length, pending_target_ids: plan.pending_target_ids.slice(offset, offset + limit),
      total_items: plan.items.length, items: plan.items.slice(offset, offset + limit),
      next_offset: offset + limit < Math.max(plan.items.length, plan.pending_target_ids.length) ? offset + limit : null }));
  }
  else if (action === 'task-context') stdout(JSON.stringify({ evidence_ids: await requestTaskContext(root, id, await readInput()) }));
  else if (action === 'heartbeat') stdout(JSON.stringify(await heartbeatTask(root, id, await readInput())));
  else if (action === 'queue') {
    const offset = Number(string('offset') ?? '0');
    const limit = Number(string('limit') ?? '20');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ScaError('schema_invalid', 'queue offset must be nonnegative and limit must be 1..100');
    const status = await queueStatus(root, id);
    stdout(JSON.stringify({ ...status, total_tasks: status.tasks.length, tasks: status.tasks.slice(offset, offset + limit),
      next_offset: offset + limit < status.tasks.length ? offset + limit : null }));
  }
  else if (action === 'claim') stdout(JSON.stringify(await claimTask(root, id, await readInput())));
  else if (action === 'task-submit') stdout(JSON.stringify(await submitTask(root, id, await readInput())));
  else if (action === 'finish') stdout(JSON.stringify(await finishTask(root, id, await readInput())));
  else if (action === 'status') stdout(JSON.stringify(await batchStatus(root, id)));
  else if (action === 'submit') stdout(JSON.stringify(await submitBatch(root, id, await readInput())));
  else if (action === 'page') {
    const cursorText = string('cursor');
    const evidenceId = string('evidence');
    const maxBytes = Number(string('max-bytes') ?? '32768');
    stdout(JSON.stringify(createEvidencePager(await loadBatchReadContext(root, id))({
      max_bytes: maxBytes,
      ...(cursorText === undefined ? {} : { cursor: parseJson(cursorText) }),
      ...(evidenceId === undefined ? {} : { evidence_id: evidenceId }),
    })));
  } else throw new ScaError('schema_invalid', 'batch --action must be create|append|diff|tasks|claim|task-context|heartbeat|queue|task-submit|finish|page|submit|status|usage|audit|budget|identity|rework|candidates|candidate-detail');
  return 0;
}

export async function runBatchCommand(values: Record<string, string | boolean | string[] | undefined>, stdout: (line: string) => void): Promise<number> {
  try { return await runBatchCommandUnsafe(values, stdout); }
  catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) throw new ScaError('schema_invalid', 'batch input or stored state failed validation; check the documented schema');
    throw error;
  }
}
