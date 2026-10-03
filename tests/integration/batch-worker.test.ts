import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveBatch, readLedger, loadBatch } from '../../src/batch/index.js';
import { queueStatus } from '../../src/batch/queue.js';
import { stableHash } from '../../src/domain/hash.js';
import { runBatchWorker } from '../../src/batch/worker.js';

test('worker exceptions scrub private text and failed tasks can be reclaimed without judgments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-worker-'));
  try {
    const file = path.join(root, 'input.jsonl');
    await fs.writeFile(file, [JSON.stringify({ type: 'meta', host: 'codex', source_session_id: 's' }),
      JSON.stringify({ type: 'event', id: 'u', kind: 'user_message', text: 'synthetic feedback' })].join('\n') + '\n');
    const manifest = await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'failure',
      scope: { time_zone: 'UTC', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'synthetic' },
      sources: [{ path: file, host: 'codex', session_id: 's', created_at: '2026-09-02T00:00:00Z', role: 'direct', role_basis: 'user_declared' }] });
    const partialManifest = await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'partial', scope: manifest.scope,
      sources: [{ path: file, host: 'codex', session_id: 's', created_at: '2026-09-02T00:00:00Z', role: 'direct', role_basis: 'user_declared' }] });
    const claim = { owner: 'worker', worker_ready: true, ttl_ms: 60_000, max_concurrency: 1,
      plan: { evidence_budget_bytes: 4096, max_targets: 1, context_events: 0 } };
    const unknownBudget = { schema: 'session-correction-analysis/batch-budget-input/v1', warning_fraction: 0.8, limits: { output_tokens: 10 },
      usage: { schema: 'session-correction-analysis/batch-usage-input/v1', expected_agents: ['worker'], entries: [] } };
    const neverRun = (): Promise<unknown> => Promise.reject(new Error('budget must block worker'));
    const blocked = await runBatchWorker(root, 'failure', claim, neverRun, undefined, unknownBudget);
    assert.equal(blocked.outcome, 'budget_blocked');
    assert.equal(blocked.budget?.status, 'indeterminate');
    const exceeded = await runBatchWorker(root, 'failure', claim, neverRun, undefined, { ...unknownBudget,
      usage: { ...unknownBudget.usage, entries: [{ agent_id: 'worker', model: 'synthetic', request_id: 'usage', sequence: 0, mode: 'final',
        noncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 10 }] } });
    assert.equal(exceeded.outcome, 'budget_blocked');
    assert.equal(exceeded.budget?.status, 'exceeded');
    await assert.rejects(fs.access(path.join(root, 'batches', 'failure', 'queue.json')));
    assert.deepEqual(await runBatchWorker(root, 'partial', claim, context => {
      const target = context.task.targets[0]; assert.ok(target);
      return Promise.resolve({ schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: stableHash(partialManifest), request_id: 'uncertain-result',
        judgments: [{ target_id: target.target_id, expected_version: target.expected_version, reading: 'inspected', judgment: 'uncertain', classification: 'unresolved',
          labels: { correction: false, intervention: false }, evidence_status: 'incomplete', inspected_evidence_ids: [target.evidence_id], unresolved_evidence_ids: [target.evidence_id], citations: [] }] });
    }, undefined, { ...unknownBudget, usage: { ...unknownBudget.usage, entries: [{ agent_id: 'worker', model: 'synthetic', request_id: 'usage', sequence: 0, mode: 'final',
      noncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 1 }] } }), { outcome: 'partial', revision: 1 });
    assert.equal((await readLedger(root, partialManifest)).revision, 1);
    assert.equal((await queueStatus(root, 'partial')).running, 1);
    assert.equal((await queueStatus(root, 'partial')).submitted, 0);
    const preCancelled = new AbortController(); preCancelled.abort();
    assert.deepEqual(await runBatchWorker(root, 'failure', claim, () => Promise.reject(new Error('must not run')), preCancelled.signal), { outcome: 'cancelled' });
    await assert.rejects(fs.access(path.join(root, 'batches', 'failure', 'queue.json')));
    const cancelled = new AbortController();
    assert.deepEqual(await runBatchWorker(root, 'failure', claim, async context => {
      assert.equal(context.signal, cancelled.signal);
      cancelled.abort();
      assert.throws(() => context.page({ max_bytes: 4096, evidence_id: context.task.evidence_ids[0] }));
      await assert.rejects(context.heartbeat());
      return { invalid: true };
    }, cancelled.signal), { outcome: 'cancelled' });
    assert.equal((await queueStatus(root, 'failure')).cancelled, 1);
    assert.equal((await readLedger(root, manifest)).revision, 0);
    await assert.rejects(runBatchWorker(root, 'failure', claim, () => Promise.reject(new Error('PRIVATE_TRANSCRIPT_MARKER'))),
      error => error instanceof Error && !error.message.includes('PRIVATE_TRANSCRIPT_MARKER'));
    assert.equal((await readLedger(root, manifest)).revision, 0);
    assert.equal((await queueStatus(root, 'failure')).failed, 1);
    await assert.rejects(runBatchWorker(root, 'failure', claim, context => {
      const target = context.task.targets[0]; assert.ok(target);
      return Promise.resolve({ schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: context.task.manifest_hash, request_id: 'bad-result',
        judgments: [{ target_id: target.target_id, expected_version: target.expected_version, reading: 'inspected', judgment: 'negative', classification: 'PRIVATE_RESULT_MARKER',
          labels: { correction: false, intervention: false }, evidence_status: 'sufficient', inspected_evidence_ids: [target.evidence_id], unresolved_evidence_ids: [], citations: [] }] });
    }), error => error instanceof Error && !error.message.includes('PRIVATE_RESULT_MARKER'));
    assert.equal((await readLedger(root, manifest)).revision, 0);
    assert.equal((await queueStatus(root, 'failure')).submitted, 0);
    assert.equal((await queueStatus(root, 'failure')).running, 1);
    const secret = '{"x":PRIVATE_STORAGE_MARKER}';
    const cleanError = (error: unknown): boolean => error instanceof Error && !error.message.includes('PRIVATE_STORAGE') && 'code' in error && error.code === 'schema_invalid';
    const queueFile = path.join(root, 'batches', 'failure', 'queue.json');
    await fs.writeFile(queueFile, secret);
    await assert.rejects(queueStatus(root, 'failure'), cleanError);
    assert.equal(await fs.readFile(queueFile, 'utf8'), secret);
    const ledgerFile = path.join(root, 'batches', 'failure', 'ledger.json');
    await fs.writeFile(ledgerFile, secret);
    await assert.rejects(readLedger(root, manifest), cleanError);
    assert.equal(await fs.readFile(ledgerFile, 'utf8'), secret);
    const manifestFile = path.join(root, 'batches', 'failure', 'manifest.json');
    await fs.writeFile(manifestFile, secret);
    await assert.rejects(loadBatch(root, 'failure'), cleanError);
    await assert.rejects(runBatchWorker(root, 'failure', claim, neverRun), cleanError);
    assert.equal(await fs.readFile(manifestFile, 'utf8'), secret);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
