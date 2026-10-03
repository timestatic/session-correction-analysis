import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { saveBatch, submitBatch } from '../../src/batch/index.js';
import { claimTask, finishTask, heartbeatTask, queueStatus, submitTask } from '../../src/batch/queue.js';
import { stableHash } from '../../src/domain/hash.js';

test('claim starts its lease after slow snapshot preparation and reclaims newly expired tasks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-claim-clock-'));
  try {
    const file = path.join(root, 'source.jsonl');
    await fs.writeFile(file, [
      { type: 'meta', host: 'codex', source_session_id: 's' },
      { type: 'event', kind: 'user_message', id: 'u', text: 'synthetic request' },
    ].map(item => JSON.stringify(item)).join('\n') + '\n');
    await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'clock',
      scope: { time_zone: 'UTC', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'synthetic' },
      sources: [{ path: file, host: 'codex', session_id: 's', created_at: '2026-09-02T00:00:00Z', role: 'direct', role_basis: 'user_declared' }] });
    const options = { owner: 'first', worker_ready: true, ttl_ms: 1000, max_concurrency: 1,
      plan: { evidence_budget_bytes: 4096, max_targets: 1, context_events: 1 } };
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const readFile = fs.readFile;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      try { return await readFile(...args); }
      finally { if (args[0] === path.join(root, 'batches', 'clock', 'queue.json')) clock += 2000; }
    });
    const first = await claimTask(root, 'clock', options);
    assert.ok(first.task);
    assert.equal(first.expires_at, clock + options.ttl_ms);
    const second = await claimTask(root, 'clock', { ...options, owner: 'second' });
    assert.equal(second.task?.task_id, first.task.task_id);
    assert.equal(second.generation, 2);
    assert.equal(second.expires_at, clock + options.ttl_ms);
    t.mock.restoreAll();
    assert.deepEqual(await heartbeatTask(root, 'clock', { task_id: first.task.task_id, owner: 'second', generation: 2, ttl_ms: 1000 }, clock),
      { expires_at: second.expires_at });
  } finally {
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const concurrency of [1, 2, 4]) {
  test(`queue enforces concurrency ${String(concurrency)} without duplicate target ownership`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-queue-'));
    try {
      const file = path.join(root, 'source.jsonl');
      await fs.writeFile(file, [
        { type: 'meta', host: 'codex', source_session_id: 's' },
        ...Array.from({ length: 6 }, (_, index) => ({ type: 'event', kind: 'user_message', id: `u${String(index)}`, text: `request ${String(index)}` })),
      ].map(item => JSON.stringify(item)).join('\n') + '\n');
      const manifest = await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'queue',
        scope: { time_zone: 'UTC', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'synthetic' },
        sources: [{ path: file, host: 'codex', session_id: 's', created_at: '2026-09-02T00:00:00Z', role: 'direct', role_basis: 'user_declared' }] });
      const options = { worker_ready: true, ttl_ms: 1000, max_concurrency: concurrency,
        plan: { evidence_budget_bytes: 4096, max_targets: 1, context_events: 1 } };
      const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => claimTask(root, 'queue', { ...options, owner: `worker-${String(index)}`, request_id: `claim-${String(index)}` }, 1000)));
      const allocated = claims.filter(claim => claim.task !== null);
      assert.equal(allocated.length, concurrency);
      assert.equal(new Set(allocated.flatMap(claim => claim.task?.targets.map(target => target.target_id) ?? [])).size, concurrency);
      assert.equal((await queueStatus(root, 'queue', 1001)).running, concurrency);
      const firstIndex = claims.findIndex(claim => claim.task !== null);
      const first = claims[firstIndex];
      assert.ok(first?.task && first.generation !== null);
      const owner = `worker-${String(firstIndex)}`;
      const replay = await claimTask(root, 'queue', { ...options, owner, request_id: `claim-${String(firstIndex)}` }, 1100);
      assert.deepEqual(replay.task, first.task);
      assert.equal(replay.generation, first.generation);
      assert.equal(replay.expires_at, first.expires_at);
      await assert.rejects(claimTask(root, 'queue', { ...options, owner, request_id: `claim-${String(firstIndex)}`, ttl_ms: 2000 }, 1100));
      const target = first.task.targets[0];
      assert.ok(target);
      const submission = { schema: 'session-correction-analysis/batch-submission/v1', manifest_hash: stableHash(manifest), request_id: 'partial-first',
        judgments: [{ target_id: target.target_id, expected_version: 0, reading: 'inspected', judgment: 'negative', classification: 'ordinary_task',
          evidence_status: 'sufficient', inspected_evidence_ids: [target.evidence_id], unresolved_evidence_ids: [], citations: [] }] };
      await assert.rejects(submitTask(root, 'queue', { task_id: first.task.task_id, owner, generation: first.generation,
        submission: { ...submission, judgments: [{ ...submission.judgments[0], target_id: manifest.targets[5]?.target_id }] } }, 1100));
      await submitTask(root, 'queue', { task_id: first.task.task_id, owner, generation: first.generation, submission }, 1100);
      await finishTask(root, 'queue', { task_id: first.task.task_id, owner, generation: first.generation, outcome: 'submitted' }, 1200);
      assert.deepEqual(await submitTask(root, 'queue', { task_id: first.task.task_id, owner, generation: first.generation, submission }, 3000), { duplicate: true, revision: 1 });
      const next = await claimTask(root, 'queue', { ...options, owner: 'next-worker', request_id: 'next-claim' }, 1300);
      assert.ok(next.task);
      assert.ok(next.task.targets.every(item => item.target_id !== target.target_id));
      await assert.rejects(heartbeatTask(root, 'queue', { task_id: first.task.task_id, owner, generation: first.generation, ttl_ms: 1000 }, 1400));
      assert.equal((await queueStatus(root, 'queue', 3000)).expired, concurrency);
      const parent = await fs.readFile(path.join(root, 'batches', 'queue', 'ledger.json'));
      await assert.rejects(submitTask(root, 'queue', { task_id: next.task.task_id, owner: 'next-worker', generation: next.generation, submission }, 3000));
      assert.deepEqual(await fs.readFile(path.join(root, 'batches', 'queue', 'ledger.json')), parent);
      const takeovers = [];
      for (let index = 0; index < concurrency; index += 1) takeovers.push(await claimTask(root, 'queue', {
        ...options, owner: `takeover-${String(index)}`, request_id: `takeover-claim-${String(index)}`,
      }, 3100));
      const takeover = takeovers.find(claim => claim.task?.task_id === next.task?.task_id);
      assert.ok(takeover);
      assert.equal(takeover.generation, (next.generation ?? 0) + 1);
      await assert.rejects(claimTask(root, 'queue', { ...options, owner: 'next-worker', request_id: 'next-claim' }, 3200));
      assert.equal((await queueStatus(root, 'queue', 3200)).running, concurrency);
      // Explicit manual revision remains separate from managed task completion.
      await submitBatch(root, 'queue', { ...submission, request_id: 'manual-revision', judgments: [{ ...submission.judgments[0], expected_version: 1 }] });
      const queueFile = path.join(root, 'batches', 'queue', 'queue.json');
      const healthyQueue = await fs.readFile(queueFile, 'utf8');
      const legacy: unknown = JSON.parse(healthyQueue);
      assert.ok(typeof legacy === 'object' && legacy !== null && 'tasks' in legacy && Array.isArray(legacy.tasks));
      Reflect.deleteProperty(legacy, 'claim_log');
      for (const legacyEntry of legacy.tasks as unknown[]) {
        assert.ok(typeof legacyEntry === 'object' && legacyEntry !== null);
        for (const field of ['task', 'cursor', 'claim_request_id', 'claim_request_hash']) Reflect.deleteProperty(legacyEntry, field);
      }
      const legacyBytes = JSON.stringify(legacy);
      await fs.writeFile(queueFile, legacyBytes);
      assert.equal((await queueStatus(root, 'queue', 3200)).running, concurrency);
      assert.equal(await fs.readFile(queueFile, 'utf8'), legacyBytes);
      const legacyEntry: unknown = legacy.tasks[0];
      assert.ok(typeof legacyEntry === 'object' && legacyEntry !== null && 'target_ids' in legacyEntry);
      legacyEntry.target_ids = ['missing-legacy-target'];
      await fs.writeFile(queueFile, JSON.stringify(legacy));
      await assert.rejects(queueStatus(root, 'queue', 3200));
      await fs.writeFile(queueFile, healthyQueue);
      const historyDamaged: unknown = JSON.parse(healthyQueue);
      assert.ok(typeof historyDamaged === 'object' && historyDamaged !== null && 'claim_log' in historyDamaged && Array.isArray(historyDamaged.claim_log));
      const logged: unknown = historyDamaged.claim_log[0];
      assert.ok(typeof logged === 'object' && logged !== null && 'generation' in logged);
      logged.generation = 999;
      await fs.writeFile(queueFile, JSON.stringify(historyDamaged));
      await assert.rejects(queueStatus(root, 'queue', 3200));
      await fs.writeFile(queueFile, healthyQueue);
      const cursorDamaged: unknown = JSON.parse(healthyQueue);
      assert.ok(typeof cursorDamaged === 'object' && cursorDamaged !== null && 'tasks' in cursorDamaged && Array.isArray(cursorDamaged.tasks));
      const cursorEntry: unknown = cursorDamaged.tasks[0];
      assert.ok(typeof cursorEntry === 'object' && cursorEntry !== null);
      Object.assign(cursorEntry, { cursor: { manifest_hash: stableHash(manifest), source_index: 999, event_index: 0, text_offset: 0 } });
      await fs.writeFile(queueFile, JSON.stringify(cursorDamaged));
      await assert.rejects(queueStatus(root, 'queue', 3000));
      await fs.writeFile(queueFile, healthyQueue);
      const damaged: unknown = JSON.parse(healthyQueue);
      assert.ok(typeof damaged === 'object' && damaged !== null && 'tasks' in damaged && Array.isArray(damaged.tasks));
      const entry: unknown = damaged.tasks[0];
      assert.ok(typeof entry === 'object' && entry !== null && 'target_ids' in entry);
      entry.target_ids = ['wrong-target'];
      await fs.writeFile(queueFile, JSON.stringify(damaged));
      await assert.rejects(queueStatus(root, 'queue', 3000));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
