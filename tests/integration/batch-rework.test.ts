import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stableHash } from '../../src/domain/hash.js';
import { validateLedger } from '../../src/batch/integrity.js';
import { saveBatch, submitBatch, createEvidencePager, evidencePage } from '../../src/batch/index.js';
import { reworkEvidencePairs } from '../../src/batch/rework.js';
import { batchCandidates, batchCandidateDetail } from '../../src/batch/candidates.js';
import { runBatchWorker } from '../../src/batch/worker.js';
import { runCli } from '../../src/cli.js';

test('rework index requires same-source successful edit pairs around feedback and shared paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-rework-'));
  try {
    const file = path.join(root, 'source.jsonl');
    const events = [
      { id: 'edit1', kind: 'file_edit', call_id: 'c1', text: '*** Update File: src/a.ts' },
      { id: 'result1', kind: 'tool_result', call_id: 'c1', text: 'success applied' },
      { id: 'user', kind: 'user_message', text: '请修正' },
      { id: 'edit2', kind: 'file_edit', call_id: 'c2', text: '*** Update File: src/a.ts' },
      { id: 'result2', kind: 'tool_result', call_id: 'c2', text: 'success applied' },
      { id: 'edit3', kind: 'file_edit', call_id: 'c3', text: '*** Update File: src/a.ts' },
      { id: 'result3', kind: 'tool_result', call_id: 'c3', text: 'failed' },
      { id: 'edit4', kind: 'file_edit', call_id: 'c4', text: '*** Update File: src/b.ts' },
      { id: 'result4', kind: 'tool_result', call_id: 'c4', text: 'success' },
      { id: 'ambiguous1', kind: 'file_edit', call_id: 'amb', text: '*** Update File: src/a.ts' },
      { id: 'ambiguous2', kind: 'file_edit', call_id: 'amb', text: '*** Update File: src/a.ts' },
      { id: 'amb-result', kind: 'tool_result', call_id: 'amb', text: 'success' },
      { id: 'double-edit', kind: 'file_edit', call_id: 'double', text: '*** Update File: src/a.ts' },
      { id: 'double-r1', kind: 'tool_result', call_id: 'double', text: 'success' },
      { id: 'double-r2', kind: 'tool_result', call_id: 'double', text: 'success' },
      { id: 'early-result', kind: 'tool_result', call_id: 'early', text: 'success' },
      { id: 'late-edit', kind: 'file_edit', call_id: 'early', text: '*** Update File: src/a.ts' },
      { id: 'unknown-edit', kind: 'file_edit', call_id: 'unknown', text: '*** Update File: src/a.ts' },
      { id: 'unknown-result', kind: 'tool_result', call_id: 'unknown', text: 'tool exited' },
    ];
    await fs.writeFile(file, [JSON.stringify({ type: 'meta', host: 'codex', source_session_id: 's' }),
      ...events.map(event => JSON.stringify({ type: 'event', ...event }))].join('\n') + '\n');
    const manifest = await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'rework',
      scope: { time_zone: 'UTC', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'synthetic' },
      sources: [{ path: file, host: 'codex', session_id: 's', created_at: '2026-09-02T00:00:00Z', role: 'direct', role_basis: 'user_declared' }] });
    const longText = '反馈🙂'.repeat(3000);
    await fs.writeFile(file, [JSON.stringify({ type: 'meta', host: 'codex', source_session_id: 's' }),
      JSON.stringify({ type: 'event', id: 'large-user', kind: 'user_message', text: longText })].join('\n') + '\n');
    const workerManifest = await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'worker',
      scope: manifest.scope, sources: [{ path: file, host: 'codex', session_id: 's', created_at: '2026-09-02T00:00:00Z', role: 'direct', role_basis: 'user_declared' }] });
    const pagerInput = structuredClone(workerManifest);
    const pager = createEvidencePager(pagerInput);
    const pageRequest = { max_bytes: 2048, evidence_id: workerManifest.targets[0]?.evidence_id };
    const expectedPage = evidencePage(workerManifest, pageRequest);
    assert.deepEqual(pager(pageRequest), expectedPage);
    const mutableEvent = pagerInput.sources[0]?.events[0]; assert.ok(mutableEvent);
    mutableEvent.event.text = 'changed after pager creation';
    const mutablePage = pager(pageRequest);
    if (mutablePage.targets[0] !== undefined) mutablePage.targets[0].target_id = 'tampered';
    assert.deepEqual(pager(pageRequest), expectedPage);
    const workerClaim = { owner: 'synthetic-worker', worker_ready: true, ttl_ms: 60_000, max_concurrency: 1,
      plan: { evidence_budget_bytes: 16_384, max_targets: 1, context_events: 0 } };
    let closedPage: (() => unknown) | undefined;
    let closedHeartbeat: (() => Promise<unknown>) | undefined;
    const workerResult = await runBatchWorker(root, 'worker', workerClaim, async context => {
      const target = context.task.targets[0]; assert.ok(target);
      assert.throws(() => context.page({ max_bytes: 4096, evidence_id: 'outside-task' }));
      let page = context.page({ max_bytes: 4096, evidence_id: target.evidence_id });
      let restored = page.items.map(item => item.text).join('');
      assert.ok(page.next_cursor);
      while (page.next_cursor !== null) {
        const cursor = page.next_cursor;
        assert.throws(() => context.page({ max_bytes: 4096, cursor: { ...cursor, expand: false } }));
        await context.heartbeat(cursor);
        page = context.page({ max_bytes: 4096, cursor });
        restored += page.items.map(item => item.text).join('');
      }
      assert.equal(restored, longText);
      closedPage = () => context.page({ max_bytes: 4096, evidence_id: target.evidence_id });
      closedHeartbeat = () => context.heartbeat();
      return { schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: stableHash(workerManifest), request_id: 'worker-result',
        judgments: [{ target_id: target.target_id, expected_version: target.expected_version, reading: 'inspected', judgment: 'negative', classification: 'ordinary_task',
          labels: { correction: false, intervention: false }, evidence_status: 'sufficient', inspected_evidence_ids: [target.evidence_id], unresolved_evidence_ids: [], citations: [] }] };
    });
    assert.deepEqual(workerResult, { outcome: 'submitted', revision: 1 });
    assert.ok(closedPage && closedHeartbeat);
    assert.throws(closedPage);
    await assert.rejects(closedHeartbeat());
    assert.deepEqual(await runBatchWorker(root, 'worker', workerClaim, () => Promise.reject(new Error('must not run'))), { outcome: 'idle' });
    const pairs = reworkEvidencePairs(manifest);
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0]?.shared_paths, ['src/a.ts']);
    assert.equal(pairs[0]?.semantic_verified, false);
    assert.equal(pairs[0]?.target_id, manifest.targets[0]?.target_id);
    assert.equal(pairs[0]?.earlier_edit, manifest.sources[0]?.events[0]?.evidence_id);
    assert.equal(pairs[0]?.later_edit, manifest.sources[0]?.events[3]?.evidence_id);
    const pair = pairs[0]; const target = manifest.targets[0];
    assert.ok(pair && target);
    const claim = { causal_status: 'unverified', earlier_edit: pair.earlier_edit, earlier_result: pair.earlier_result,
      later_edit: pair.later_edit, later_result: pair.later_result };
    const judgment = { target_id: target.target_id, expected_version: 0, reading: 'inspected', judgment: 'positive', classification: 'correction',
      labels: { correction: true, intervention: false }, rework: claim, evidence_status: 'sufficient',
      candidates: [{ kind: 'memory', content: '先核对实际修改证据，再确认返工。', evidence_ids: [target.evidence_id] }],
      inspected_evidence_ids: [target.evidence_id, pair.earlier_edit, pair.earlier_result, pair.later_edit, pair.later_result],
      unresolved_evidence_ids: [], citations: [{ evidence_id: target.evidence_id, quote: '请修正' }] };
    const submission = { schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: stableHash(manifest), request_id: 'rework-one', judgments: [judgment] };
    await assert.rejects(submitBatch(root, 'rework', { ...submission, judgments: [{ ...judgment, rework: { ...claim, later_result: pair.earlier_result } }] }));
    await assert.rejects(submitBatch(root, 'rework', { ...submission, judgments: [{ ...judgment, inspected_evidence_ids: [target.evidence_id] }] }));
    assert.deepEqual(await submitBatch(root, 'rework', submission), { duplicate: false, revision: 1 });
    assert.deepEqual(await submitBatch(root, 'rework', submission), { duplicate: true, revision: 1 });
    const ledger = validateLedger(JSON.parse(await fs.readFile(path.join(root, 'batches', 'rework', 'ledger.json'), 'utf8')) as unknown, manifest);
    assert.deepEqual(ledger.history[0]?.judgments[0], judgment);
    const corrupt = structuredClone(ledger);
    const transaction = corrupt.history[0]; const corruptJudgment = transaction?.judgments[0];
    assert.ok(transaction && corruptJudgment && 'rework' in corruptJudgment && corruptJudgment.rework);
    [corruptJudgment.rework.earlier_edit, corruptJudgment.rework.later_edit] = [corruptJudgment.rework.later_edit, corruptJudgment.rework.earlier_edit];
    transaction.request_hash = stableHash({ schema: transaction.submission_schema, manifest_hash: corrupt.manifest_hash,
      request_id: transaction.request_id, judgments: transaction.judgments });
    assert.throws(() => validateLedger(corrupt, manifest), /rework requires/);
    const snapshotFile = path.join(root, 'batches', 'rework', 'manifest.json');
    const before = await fs.readFile(snapshotFile);
    const output: string[] = [];
    assert.equal(await runCli(['batch', '--action', 'rework', '--batch', 'rework', '--limit', '1', '--data-root', root], {
      env: {}, stdout: line => output.push(line), stderr: line => output.push(line),
    }), 0);
    const response: unknown = JSON.parse(output[0] ?? '{}');
    assert.ok(typeof response === 'object' && response !== null && 'total_pairs' in response);
    assert.equal(response.total_pairs, 1);
    assert.equal(output.join('').includes('src/a.ts'), false);
    assert.equal(output.join('').includes('请修正'), false);
    assert.deepEqual(await fs.readFile(snapshotFile), before);
    const candidateView = await batchCandidates(root, 'rework');
    assert.equal(candidateView.candidates.length, 1);
    assert.equal(candidateView.candidates[0]?.review_status, 'unreviewed');
    assert.deepEqual(await batchCandidates(root, 'rework'), candidateView);
    const ledgerFile = path.join(root, 'batches', 'rework', 'ledger.json');
    const ledgerBefore = await fs.readFile(ledgerFile);
    output.length = 0;
    assert.equal(await runCli(['batch', '--action', 'candidates', '--batch', 'rework', '--limit', '1', '--data-root', root], {
      env: {}, stdout: line => output.push(line), stderr: line => output.push(line),
    }), 0);
    assert.equal(output.join('').includes('先核对实际修改'), false);
    assert.deepEqual(await fs.readFile(ledgerFile), ledgerBefore);
    const reference = candidateView.candidates[0];
    assert.ok(reference);
    const detailRequest = { candidate_id: reference.candidate_id, expected_content_hash: reference.content_hash };
    const detail = await batchCandidateDetail(root, 'rework', detailRequest);
    assert.equal(detail.content, judgment.candidates[0]?.content);
    await assert.rejects(batchCandidateDetail(root, 'rework', { ...detailRequest, expected_content_hash: stableHash('wrong') }));
    assert.deepEqual(await fs.readFile(ledgerFile), ledgerBefore);
    await submitBatch(root, 'rework', { ...submission, request_id: 'remove-candidates', judgments: [{ ...judgment, expected_version: 1, candidates: [] }] });
    assert.equal((await batchCandidates(root, 'rework')).candidates.length, 0);
    await assert.rejects(batchCandidateDetail(root, 'rework', detailRequest));
    const revised = validateLedger(JSON.parse(await fs.readFile(ledgerFile, 'utf8')) as unknown, manifest);
    assert.deepEqual(revised.history[0]?.judgments[0], judgment);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
