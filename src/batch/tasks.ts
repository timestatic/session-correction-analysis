import { z } from 'zod';

import { ScaError } from '../domain/errors.js';
import { stableHash } from '../domain/hash.js';
import { loadBatchReadContext, readLedger } from './index.js';
import { validateLedger } from './integrity.js';
import { BatchReadContext } from './runtime.js';
import { WORKER_GUIDANCE, type BatchManifest, type BatchLedger, type Judgment } from './schema.js';

export const taskPlanOptionsSchema = z.object({
  evidence_budget_bytes: z.number().int().min(1024).max(16 * 1024 * 1024),
  max_targets: z.number().int().min(1).max(100),
  context_events: z.number().int().min(0).max(4),
  context_mode: z.enum(['adjacent', 'turn']).optional(),
}).strict();
export const analysisTaskSchema = z.object({
  task_id: z.string().min(1), manifest_hash: z.string().min(1), guidance: z.string(),
  targets: z.array(z.object({ target_id: z.string().min(1), evidence_id: z.string().min(1),
    expected_version: z.number().int().nonnegative(), unresolved_evidence_ids: z.array(z.string()) }).strict()).min(1),
  evidence_ids: z.array(z.string()), estimated_evidence_bytes: z.number().int().nonnegative(), requires_paging: z.boolean(),
}).strict();
export interface AnalysisTask {
  task_id: string;
  manifest_hash: string;
  guidance: string;
  targets: { target_id: string; evidence_id: string; expected_version: number;
    unresolved_evidence_ids: string[] }[];
  evidence_ids: string[];
  estimated_evidence_bytes: number;
  requires_paging: boolean;
}
export interface TaskPlan {
  schema: string;
  manifest_hash: string;
  ledger_revision: number;
  skipped_sufficient_targets: number;
  tasks: AnalysisTask[];
}

/** No text summaries or semantic labels are generated; all evidence is retrieved through page/expand. */
export function planTasks(input: BatchManifest | BatchReadContext, ledgerInput: BatchLedger, optionsInput: unknown): TaskPlan {
  const context = input instanceof BatchReadContext ? input : BatchReadContext.create(input);
  const manifest = context.manifest;
  const ledger = validateLedger(ledgerInput, context);
  const options = taskPlanOptionsSchema.parse(optionsInput);
  const hash = context.manifest_hash;
  const current = new Map<string, Judgment>();
  const versions = new Map<string, number>();
  for (const transaction of ledger.history) for (const judgment of transaction.judgments) {
    current.set(judgment.target_id, judgment);
    versions.set(judgment.target_id, (versions.get(judgment.target_id) ?? 0) + 1);
  }
  const tasks: AnalysisTask[] = [];
  let targets: AnalysisTask['targets'] = [];
  let evidence = new Set<string>();
  let skipped = 0;
  const bytes = (ids: Set<string>): number => [...ids].reduce((sum, id) => sum + context.evidenceCost(id), 0);
  const flush = (): void => {
    if (targets.length === 0) return;
    const evidenceIds = [...evidence];
    const estimated = bytes(evidence);
    tasks.push({ task_id: `task-${stableHash({ hash, targets, evidenceIds, options }).slice(7)}`,
      manifest_hash: hash, guidance: WORKER_GUIDANCE, targets, evidence_ids: evidenceIds,
      estimated_evidence_bytes: estimated, requires_paging: estimated > options.evidence_budget_bytes });
    targets = []; evidence = new Set();
  };
  for (const target of manifest.targets) {
    const prior = current.get(target.target_id);
    if (prior !== undefined && prior.judgment !== 'uncertain' && prior.evidence_status === 'sufficient' && prior.unresolved_evidence_ids.length === 0) { skipped += 1; continue; }
    const position = context.position(target.evidence_id);
    if (position === undefined) throw new ScaError('schema_invalid', 'task target evidence missing');
    const ids = position.source.events.slice(Math.max(0, position.event_index - options.context_events), position.event_index + options.context_events + 1).map(event => event.evidence_id);
    if (options.context_mode === 'turn') ids.push(...turnEvidence(position.source.events, position.event_index));
    ids.push(...(prior?.unresolved_evidence_ids ?? []));
    const merged = new Set([...evidence, ...ids]);
    if (targets.length > 0 && (targets.length >= options.max_targets || bytes(merged) > options.evidence_budget_bytes)) flush();
    for (const id of ids) evidence.add(id);
    targets.push({ target_id: target.target_id, evidence_id: target.evidence_id,
      expected_version: versions.get(target.target_id) ?? 0, unresolved_evidence_ids: prior?.unresolved_evidence_ids ?? [] });
    if (bytes(evidence) > options.evidence_budget_bytes) flush();
  }
  flush();
  return { schema: 'session-correction-analysis/batch-task-plan/v1', manifest_hash: hash,
    ledger_revision: ledger.revision, skipped_sufficient_targets: skipped, tasks };
}

export async function batchTaskPlan(root: string, id: string, options: unknown): Promise<TaskPlan> {
  const context = await loadBatchReadContext(root, id);
  return planTasks(context, await readLedger(root, context), options);
}

function turnEvidence(events: BatchManifest['sources'][number]['events'], index: number): string[] {
  const turn = events[index]?.event.turn_id;
  if (turn === undefined) return [];
  let start = index;
  let end = index + 1;
  while (start > 0 && (events[start - 1]?.event.turn_id === turn || events[start - 1]?.event.turn_id === undefined)) start -= 1;
  while (end < events.length && (events[end]?.event.turn_id === turn || events[end]?.event.turn_id === undefined)) end += 1;
  const previous = events[start - 1]?.event.turn_id;
  if (previous !== undefined) {
    start -= 1;
    while (start > 0 && (events[start - 1]?.event.turn_id === previous || events[start - 1]?.event.turn_id === undefined)) start -= 1;
  }
  return events.slice(start, end).map(event => event.evidence_id);
}
