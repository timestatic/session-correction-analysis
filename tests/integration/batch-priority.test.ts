import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli.js';

import { createEvidencePager, loadBatchReadContext, readLedger, saveBatch } from '../../src/batch/index.js';
import { planTasks } from '../../src/batch/tasks.js';
import { runBatchLoop, runBatchWorker } from '../../src/batch/worker.js';
import { claimTask, heartbeatTask, queueStatus, requestTaskContext, submitTask } from '../../src/batch/queue.js';
import type { WorkerContext } from '../../src/batch/worker.js';

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-priority-'));
  const file = path.join(root, 'input.jsonl');
  await fs.writeFile(file, [
    { type: 'meta', host: 'codex', source_session_id: 's' },
    { type: 'event', kind: 'user_message', id: 'u1', turn_id: 't1', text: 'first request' },
    { type: 'event', kind: 'assistant_message', id: 'a1', turn_id: 't1', text: 'prior decision' },
    ...Array.from({ length: 6 }, (_, i) => ({ type: 'event', kind: 'tool_result', id: `r${String(i)}`, turn_id: 't1', text: 'synthetic result' })),
    { type: 'event', kind: 'user_message', id: 'u2', turn_id: 't2', text: 'please correct that decision' },
    { type: 'event', kind: 'assistant_message', id: 'a2', turn_id: 't2', text: 'x'.repeat(12000) },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'priority',
    scope: { time_zone: 'UTC', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'synthetic' },
    sources: [{ path: file, host: 'codex', session_id: 's', created_at: '2026-09-02T00:00:00Z', role: 'direct', role_basis: 'user_declared' }] });
  return root;
}
const claim = { owner: 'reader', worker_ready: true, ttl_ms: 60000, max_concurrency: 1,
  plan: { evidence_budget_bytes: 32768, max_targets: 1, context_events: 0 } };

function negative(context: WorkerContext, count = context.task.targets.length): unknown {
  return { schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: context.task.manifest_hash,
    request_id: `result-${context.task.task_id.slice(-20)}`, judgments: context.task.targets.slice(0, count).map(t => ({
      target_id: t.target_id, expected_version: t.expected_version, reading: 'inspected', judgment: 'negative',
      classification: 'ordinary_task', labels: { correction: false, intervention: false }, evidence_status: 'sufficient',
      inspected_evidence_ids: [t.evidence_id], unresolved_evidence_ids: [], citations: [],
    })) };
}

test('turn context reaches the prior decision beyond neighboring tool results and keeps the snapshot immutable', async () => {
  const root = await fixture();
  try {
    const context = await loadBatchReadContext(root, 'priority');
    const ledger = await readLedger(root, context);
    const options = { ...claim.plan, context_mode: 'turn' };
    const planned = planTasks(context, ledger, options);
    const second = planned.tasks[1]; assert.ok(second);
    const prior = context.manifest.sources[0]?.events.find(e => e.event.id === 'a1'); assert.ok(prior);
    assert.ok(second.evidence_ids.includes(prior.evidence_id));
    assert.throws(() => { context.manifest.targets.splice(0); });
    assert.equal(context.manifest.targets.length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('loop drains remaining targets, reuses one read context and reports full only from current coverage', async () => {
  const root = await fixture();
  try {
    const result = await runBatchLoop(root, 'priority', { claim, max_tasks: 10 }, context => {
      for (const target of context.task.targets) context.page({ max_bytes: 4096, evidence_id: target.evidence_id });
      return Promise.resolve(negative(context));
    });
    assert.equal(result.outcome, 'complete');
    assert.equal(result.processed_tasks, 2);
    assert.equal(result.read_context_loads, 1);
    assert.equal(result.status.semantic_complete, 2);
    assert.equal(result.status.pending, 0);
    assert.equal((await queueStatus(root, 'priority')).submitted, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('partial submission is retained, released and replanned instead of repeated', async () => {
  const root = await fixture();
  try {
    let calls = 0;
    const result = await runBatchLoop(root, 'priority', { claim: { ...claim, plan: { ...claim.plan, max_targets: 2 } }, max_tasks: 5 }, context => {
      calls += 1;
      return Promise.resolve(negative(context, 1));
    });
    assert.equal(result.outcome, 'complete');
    assert.equal(calls, 2);
    assert.equal(result.status.semantic_complete, 2);
    assert.equal((await queueStatus(root, 'priority')).running, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('loop stops on an uncertain result with no progress and does not mark the task complete', async () => {
  const root = await fixture();
  try {
    let calls = 0;
    const result = await runBatchLoop(root, 'priority', { claim, max_tasks: 10 }, context => {
      calls += 1;
      const target = context.task.targets[0]; assert.ok(target);
      return Promise.resolve({ schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: context.task.manifest_hash,
        request_id: 'uncertain', judgments: [{ target_id: target.target_id, expected_version: target.expected_version,
          reading: 'inspected', judgment: 'uncertain', classification: 'unresolved', labels: { correction: false, intervention: false },
          evidence_status: 'incomplete', inspected_evidence_ids: [target.evidence_id], unresolved_evidence_ids: [target.evidence_id], citations: [] }] });
    });
    assert.equal(result.outcome, 'no_progress');
    assert.equal(calls, 1);
    assert.equal(result.status.uncertain, 1);
    assert.equal((await queueStatus(root, 'priority')).running, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('worker persists paging checkpoint and same-source context expansion under its lease', async () => {
  const root = await fixture();
  try {
    const context = await loadBatchReadContext(root, 'priority');
    const long = context.manifest.sources[0]?.events.find(e => e.event.id === 'a2'); assert.ok(long);
    await runBatchWorker(root, 'priority', { ...claim, plan: { ...claim.plan, max_targets: 2 } }, async worker => {
      const target = worker.task.targets[1]; assert.ok(target);
      const expanded = await worker.requestContext({ target_id: target.target_id, before: 2, after: 1 });
      assert.ok(expanded.includes(long.evidence_id));
      const first = worker.page({ max_bytes: 4096, evidence_id: long.evidence_id });
      assert.ok(first.next_cursor);
      await worker.checkpoint(first.next_cursor);
      const stored = (await queueStatus(root, 'priority')).tasks.find(t => t.status === 'running'); assert.ok(stored);
      assert.equal(stored.cursor?.text_offset, first.next_cursor.text_offset);
      assert.ok(stored.task?.evidence_ids.includes(long.evidence_id));
      assert.ok(stored.completed_evidence_ids?.includes(long.evidence_id) !== true);
      let page = first;
      while (page.next_cursor !== null) page = worker.page({ max_bytes: 4096, cursor: page.next_cursor });
      await worker.checkpoint();
      assert.ok((await queueStatus(root, 'priority')).tasks.find(t => t.status === 'running')?.completed_evidence_ids?.includes(long.evidence_id));
      return negative(worker);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('context and checkpoints reject stale owners and out-of-task evidence', async () => {
  const root = await fixture();
  try {
    const leased = await claimTask(root, 'priority', claim); assert.ok(leased.task && leased.generation);
    const target = leased.task.targets[0]; assert.ok(target);
    await assert.rejects(requestTaskContext(root, 'priority', { task_id: leased.task.task_id, generation: leased.generation,
      owner: 'wrong', target_id: target.target_id, before: 1, after: 1 }));
    await assert.rejects(heartbeatTask(root, 'priority', { task_id: leased.task.task_id, generation: leased.generation,
      owner: claim.owner, ttl_ms: claim.ttl_ms, completed_evidence_ids: ['not-in-snapshot'] }));
    const snapshot = await loadBatchReadContext(root, 'priority');
    const other = snapshot.manifest.targets[1]; assert.ok(other);
    await assert.rejects(requestTaskContext(root, 'priority', { task_id: leased.task.task_id, generation: leased.generation,
      owner: claim.owner, target_id: other.target_id, before: 1, after: 1 }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('CLI exposes turn planning and fenced context requests without transcript output', async () => {
  const root = await fixture();
  try {
    const lines: string[] = [];
    const errors: string[] = [];
    const io = { env: {}, stdout: (line: string): void => { lines.push(line); }, stderr: (line: string): void => { errors.push(line); } };
    assert.equal(await runCli(['batch', '--action', 'tasks', '--batch', 'priority', '--data-root', root, '--context-mode', 'turn'], io), 0);
    assert.ok(!lines.join('').includes('prior decision'));
    const leased = await claimTask(root, 'priority', claim); assert.ok(leased.task && leased.generation);
    const target = leased.task.targets[0]; assert.ok(target);
    const input = path.join(root, 'context.json');
    await fs.writeFile(input, JSON.stringify({ task_id: leased.task.task_id, owner: claim.owner, generation: leased.generation,
      target_id: target.target_id, before: 0, after: 2 }));
    assert.equal(await runCli(['batch', '--action', 'task-context', '--batch', 'priority', '--data-root', root, '--input', input], io), 0);
    assert.ok(lines.at(-1)?.includes('evidence_ids'));
    assert.ok(!lines.join('').includes('prior decision'));
    assert.deepEqual(errors, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed reader resumes its persisted page and expanded evidence in a new generation', async () => {
  const root = await fixture();
  try {
    const options = { ...claim, plan: { ...claim.plan, max_targets: 2 } };
    let offset = 0;
    await assert.rejects(runBatchWorker(root, 'priority', options, async context => {
      const target = context.task.targets[1]; assert.ok(target);
      const ids = await context.requestContext({ target_id: target.target_id, before: 0, after: 1 });
      const snapshot = await loadBatchReadContext(root, 'priority');
      const long = snapshot.manifest.sources[0]?.events.find(e => e.event.id === 'a2'); assert.ok(long);
      assert.ok(ids.includes(long.evidence_id));
      const page = context.page({ max_bytes: 4096, evidence_id: long.evidence_id }); assert.ok(page.next_cursor);
      offset = page.next_cursor.text_offset;
      await context.checkpoint();
      throw new Error('SYNTHETIC_PRIVATE_ERROR');
    }), error => error instanceof Error && !error.message.includes('SYNTHETIC_PRIVATE_ERROR'));
    await runBatchWorker(root, 'priority', options, async context => {
      assert.equal(context.lease.generation, 2);
      assert.equal(context.cursor?.text_offset, offset);
      assert.ok(context.cursor);
      const page = context.page({ max_bytes: 4096, cursor: context.cursor });
      assert.equal(page.items[0]?.text_offset, offset);
      await context.checkpoint();
      return negative(context);
    });
    assert.equal((await queueStatus(root, 'priority')).submitted, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reusable pager keeps byte limits and does not trust later input mutation', async () => {
  const root = await fixture();
  try {
    const context = await loadBatchReadContext(root, 'priority');
    const long = context.manifest.sources[0]?.events.find(e => e.event.id === 'a2'); assert.ok(long);
    const page = createEvidencePager(context)({ evidence_id: long.evidence_id, max_bytes: 4096 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    page.items[0]!.text = 'mutated output';
    assert.ok(createEvidencePager(context)({ evidence_id: long.evidence_id, max_bytes: 4096 }).items[0]?.text.startsWith('xxx'));
    await fs.writeFile(path.join(root, 'batches', 'priority', 'ledger.json'), '{"invalid":true}');
    await assert.rejects(readLedger(root, context));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('loop bounds work and budget checks do not dispatch a worker with missing usage', async () => {
  const root = await fixture();
  try {
    const limited = await runBatchLoop(root, 'priority', { claim, max_tasks: 1 }, context => Promise.resolve(negative(context)));
    assert.equal(limited.outcome, 'task_limit');
    assert.equal(limited.status.pending, 1);
    const blocked = await runBatchLoop(root, 'priority', { claim, max_tasks: 5 }, () => {
      assert.fail('budget must prevent worker dispatch');
    }, undefined, () => Promise.resolve({ schema: 'session-correction-analysis/batch-budget-input/v1',
      usage: { schema: 'session-correction-analysis/batch-usage-input/v1', expected_agents: ['reader'], entries: [] },
      limits: { output_tokens: 100 }, warning_fraction: 0.8 }));
    assert.equal(blocked.outcome, 'budget_blocked');
    assert.equal(blocked.processed_tasks, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('loop resumes its own active lease after restart rather than allocating a duplicate task', async () => {
  const root = await fixture();
  try {
    const options = { ...claim, plan: { ...claim.plan, max_targets: 2, context_mode: 'turn' } };
    const leased = await claimTask(root, 'priority', { ...options, request_id: 'loop-prior' }); assert.ok(leased.task && leased.generation);
    const snapshot = await loadBatchReadContext(root, 'priority');
    const long = snapshot.manifest.sources[0]?.events.find(e => e.event.id === 'a2'); assert.ok(long);
    const first = createEvidencePager(snapshot)({ max_bytes: 4096, evidence_id: long.evidence_id }); assert.ok(first.next_cursor);
    await heartbeatTask(root, 'priority', { task_id: leased.task.task_id, owner: options.owner, generation: leased.generation,
      ttl_ms: options.ttl_ms, cursor: first.next_cursor });
    const result = await runBatchLoop(root, 'priority', { claim: options, max_tasks: 2 }, context => {
      assert.equal(context.lease.generation, leased.generation);
      assert.equal(context.cursor?.text_offset, first.next_cursor?.text_offset);
      return Promise.resolve(negative(context));
    });
    assert.equal(result.outcome, 'complete');
    assert.equal((await queueStatus(root, 'priority')).tasks.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('loop repairs a lost post-submit receipt without invoking the worker again', async () => {
  const root = await fixture();
  try {
    const options = { ...claim, plan: { ...claim.plan, max_targets: 2, context_mode: 'turn' } };
    const leased = await claimTask(root, 'priority', { ...options, request_id: 'lost-receipt' }); assert.ok(leased.task && leased.generation);
    await submitTask(root, 'priority', { task_id: leased.task.task_id, owner: options.owner, generation: leased.generation,
      submission: { schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: leased.task.manifest_hash,
        request_id: 'persisted-result', judgments: leased.task.targets.map(target => ({ target_id: target.target_id,
          expected_version: target.expected_version, reading: 'inspected', judgment: 'negative', classification: 'ordinary_task',
          labels: { correction: false, intervention: false }, evidence_status: 'sufficient',
          inspected_evidence_ids: [target.evidence_id], unresolved_evidence_ids: [], citations: [] })) } });
    const result = await runBatchLoop(root, 'priority', { claim: options, max_tasks: 3 }, () => assert.fail('committed work must not repeat'));
    assert.equal(result.outcome, 'complete');
    assert.equal(result.processed_tasks, 0);
    assert.equal((await queueStatus(root, 'priority')).running, 0);
    assert.equal((await queueStatus(root, 'priority')).submitted, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('parsed targets completed in a partial source never become full coverage', async () => {
  const root = await fixture();
  try {
    const snapshot = await loadBatchReadContext(root, 'priority');
    const source = snapshot.manifest.sources[0]; assert.ok(source);
    await fs.appendFile(source.input.path, '{"unfinished":');
    await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'partial-source',
      scope: snapshot.manifest.scope, sources: [source.input] });
    const result = await runBatchLoop(root, 'partial-source', { claim, max_tasks: 5 }, context => Promise.resolve(negative(context)));
    assert.equal(result.outcome, 'parsed_complete');
    assert.equal(result.status.pending, 0);
    assert.equal(result.status.source_partial, 1);
    assert.equal(result.status.coverage, 'partial');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
