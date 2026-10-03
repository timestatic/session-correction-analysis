import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { batchStatus, evidencePage, loadBatch, saveBatch, submitBatch } from '../../src/batch/index.js';
import type { BatchInput, PageCursor } from '../../src/batch/schema.js';
import { stableHash, stableStringify } from '../../src/domain/hash.js';
import { runCli } from '../../src/cli.js';
import { claimTask, finishTask, submitTask, heartbeatTask, queueStatus } from '../../src/batch/queue.js';
import { identityInventory } from '../../src/batch/identity.js';
import { batchAuditPlan } from '../../src/batch/audit.js';
import { batchTaskPlan } from '../../src/batch/tasks.js';
import { sourceDifferences } from '../../src/batch/diff.js';
import { appendBatch } from '../../src/batch/append.js';
import { validateLedger, validateManifest } from '../../src/batch/integrity.js';

test('batch freezes divergent sources, losslessly pages Unicode and preserves incremental history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-batch-'));
  try {
    const long = '长😀引文\\\n'.repeat(4000);
    const files = [path.join(root, 'a.jsonl'), path.join(root, 'b.jsonl')];
    for (const [index, file] of files.entries()) {
      await fs.writeFile(file, [
        { type: 'meta', host: 'codex', source_session_id: 'same' },
        { type: 'event', id: 'one', kind: 'user_message', text: long },
        { type: 'event', id: 'two', kind: 'user_message', text: index === 0 ? '需要修改' : '不需要修改' },
      ].map(item => JSON.stringify(item)).join('\n') + '\n');
    }
    const input: BatchInput = { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'example',
      scope: { time_zone: 'Asia/Shanghai', start: '2026-09-01T00:00:00+08:00', end: '2026-10-01T00:00:00+08:00',
        time_mode: 'created', inclusion_rule: 'explicit synthetic fixtures' },
      sources: files.map(file => ({ path: file, host: 'codex', session_id: 'same', created_at: '2026-09-02T00:00:00+08:00', role: 'direct', role_basis: 'user_declared' })),
    };
    const manifest = await saveBatch(root, input);
    assert.equal(manifest.targets.length, 4);
    assert.deepEqual(validateManifest(manifest), manifest);
    const taskOptions = { evidence_budget_bytes: 1024, max_targets: 2, context_events: 1 };
    const tasks = await batchTaskPlan(root, 'example', taskOptions);
    assert.equal(tasks.tasks.flatMap(task => task.targets).length, 4);
    assert.equal(new Set(tasks.tasks.flatMap(task => task.targets.map(target => target.target_id))).size, 4);
    assert.ok(tasks.tasks.every(task => task.targets.length === 1 && task.requires_paging));
    assert.deepEqual(await batchTaskPlan(root, 'example', taskOptions), tasks);
    const claimRequest = { owner: 'worker-one', worker_ready: true, ttl_ms: 1000, max_concurrency: 1, plan: taskOptions };
    const claimed = await claimTask(root, 'example', claimRequest, 1000);
    assert.ok(claimed.task);
    assert.equal(claimed.generation, 1);
    const resumeCursor = { manifest_hash: stableHash(manifest), source_index: 0, event_index: 0, text_offset: 0 };
    assert.deepEqual(await heartbeatTask(root, 'example', { task_id: claimed.task.task_id, owner: 'worker-one', generation: 1, ttl_ms: 1000, cursor: resumeCursor }, 1050), { expires_at: 2050 });
    assert.equal((await queueStatus(root, 'example', 1100)).running, 1);
    await assert.rejects(heartbeatTask(root, 'example', { task_id: claimed.task.task_id, owner: 'worker-two', generation: 1, ttl_ms: 1000 }, 1100));
    assert.equal((await claimTask(root, 'example', { ...claimRequest, owner: 'worker-two' }, 1100)).task, null);
    await assert.rejects(finishTask(root, 'example', { task_id: claimed.task.task_id, owner: 'worker-one', generation: 1, outcome: 'submitted' }, 1200));
    const takeover = await claimTask(root, 'example', { ...claimRequest, owner: 'worker-two' }, 2051);
    assert.equal(takeover.task?.task_id, claimed.task.task_id);
    assert.equal(takeover.generation, 2);
    assert.deepEqual(takeover.cursor, resumeCursor);
    await assert.rejects(heartbeatTask(root, 'example', { task_id: claimed.task.task_id, owner: 'worker-one', generation: 1, ttl_ms: 1000 }, 2100));
    assert.equal((await queueStatus(root, 'example', 4000)).expired, 1);
    await assert.rejects(finishTask(root, 'example', { task_id: claimed.task.task_id, owner: 'worker-one', generation: 1, outcome: 'cancelled', failure: 'cancelled' }, 2100));
    const cancelled = { task_id: claimed.task.task_id, owner: 'worker-two', generation: 2, outcome: 'cancelled', failure: 'cancelled' };
    assert.equal((await finishTask(root, 'example', cancelled, 2100)).duplicate, false);
    assert.equal((await finishTask(root, 'example', cancelled, 2200)).duplicate, true);
    const retry = await claimTask(root, 'example', claimRequest, 2300);
    assert.equal(retry.generation, 3);
    assert.equal((await fs.stat(path.join(root, 'batches', 'example', 'queue.json'))).mode & 0o777, 0o600);
    const differences = sourceDifferences(manifest);
    assert.equal(differences.length, 1);
    assert.equal(differences[0]?.relation, 'divergent');
    assert.equal(differences[0]?.shared_prefix_events, 1);
    assert.deepEqual(differences[0]?.left_range, [1, 2]);
    assert.deepEqual(differences[0]?.right_range, [1, 2]);
    assert.equal(differences[0]?.left_target_ids.length, 1);
    assert.equal(differences[0]?.right_target_ids.length, 1);
    assert.equal(differences[0]?.semantic_reuse_authorized, false);
    assert.throws(() => validateManifest({ ...manifest, targets: manifest.targets.slice(1) }));
    assert.throws(() => validateManifest({ ...manifest, targets: [...manifest.targets, manifest.targets[0]] }));
    const brokenBytes = structuredClone(manifest);
    const brokenSource = brokenBytes.sources[0];
    assert.ok(brokenSource);
    brokenSource.frozen_bytes_base64 = Buffer.from('changed').toString('base64');
    assert.throws(() => validateManifest(brokenBytes));
    const brokenBody = structuredClone(manifest);
    const brokenEvent = brokenBody.sources[0]?.events[0];
    assert.ok(brokenEvent);
    brokenEvent.event.text = 'silently changed';
    assert.throws(() => validateManifest(brokenBody));
    const reconstruction = new Map<string, string>();
    let cursor: PageCursor | undefined;
    let pages = 0;
    do {
      const page = evidencePage(manifest, { max_bytes: 2048, ...(cursor === undefined ? {} : { cursor }) });
      assert.ok(Buffer.byteLength(stableStringify(page)) <= 2048);
      for (const item of page.items) {
        if (item.reading_reuse_of === undefined) reconstruction.set(item.evidence_id, (reconstruction.get(item.evidence_id) ?? '') + item.text);
      }
      cursor = page.next_cursor ?? undefined;
      pages += 1;
      assert.ok(pages < 2000);
    } while (cursor !== undefined);
    assert.ok(pages > 2);
    for (const source of manifest.sources) for (const item of source.events) {
      if (item.reading_reuse_of === undefined) assert.equal(reconstruction.get(item.evidence_id), item.event.text);
    }
    const reusedEvent = manifest.sources[1]?.events[0];
    assert.ok(reusedEvent);
    let expanded = '';
    let expansionCursor: PageCursor | undefined;
    do {
      const page = evidencePage(manifest, { max_bytes: 2048,
        ...(expansionCursor === undefined ? { evidence_id: reusedEvent.evidence_id } : { cursor: expansionCursor }) });
      assert.ok(Buffer.byteLength(stableStringify(page)) <= 2048);
      assert.ok(page.items.every(item => item.evidence_id === reusedEvent.evidence_id));
      expanded += page.items.map(item => item.text).join('');
      expansionCursor = page.next_cursor ?? undefined;
    } while (expansionCursor !== undefined);
    assert.equal(expanded, long);
    assert.equal((await fs.stat(path.join(root, 'batches', 'example', 'manifest.json'))).mode & 0o777, 0o600);
    const first = manifest.targets[0];
    assert.ok(first);
    const submission = { schema: 'session-correction-analysis/batch-submission/v1', manifest_hash: stableHash(manifest),
      request_id: 'request-one', judgments: [{ target_id: first.target_id, expected_version: 0, reading: 'inspected',
        judgment: 'negative', classification: 'ordinary_task', evidence_status: 'sufficient',
        inspected_evidence_ids: [first.evidence_id], unresolved_evidence_ids: [], citations: [] }] };
    await assert.rejects(submitTask(root, 'example', { task_id: claimed.task.task_id, owner: 'worker-one', generation: 1, submission }, 2400));
    assert.deepEqual(await submitTask(root, 'example', { task_id: claimed.task.task_id, owner: 'worker-one', generation: 3, submission }, 2400), { duplicate: false, revision: 1 });
    assert.equal((await submitBatch(root, 'example', submission)).duplicate, true);
    const ledgerBeforeOversize = await fs.readFile(path.join(root, 'batches', 'example', 'ledger.json'));
    await assert.rejects(submitBatch(root, 'example', { ...submission, request_id: 'too-large', judgments: [{ ...submission.judgments[0],
      citations: [{ evidence_id: first.evidence_id, quote: '😀'.repeat(300_000) }] }] }));
    assert.deepEqual(await fs.readFile(path.join(root, 'batches', 'example', 'ledger.json')), ledgerBeforeOversize);
    assert.equal((await finishTask(root, 'example', { task_id: claimed.task.task_id, owner: 'worker-one', generation: 3, outcome: 'submitted' }, 2400)).duplicate, false);
    await assert.rejects(submitBatch(root, 'example', { ...submission, judgments: [] }));
    await assert.rejects(submitBatch(root, 'example', { ...submission, request_id: 'unresolved-negative',
      judgments: [{ ...submission.judgments[0], expected_version: 1, classification: 'unresolved' }] }));
    const status = await batchStatus(root, 'example');
    assert.equal(status.pending, 3);
    const remainingTasks = await batchTaskPlan(root, 'example', taskOptions);
    assert.equal(remainingTasks.skipped_sufficient_targets, 1);
    assert.equal(remainingTasks.tasks.flatMap(task => task.targets).length, 3);
    assert.ok(remainingTasks.tasks.every(task => task.targets.every(target => target.target_id !== first.target_id)));
    assert.equal(status.coverage, 'partial');
    const auditOptions = { seed: 'frozen-quality-seed', negative_fraction: 0.2 };
    const negativeAudit = await batchAuditPlan(root, 'example', auditOptions);
    assert.equal(negativeAudit.totals.sampled_negative, 1);
    assert.equal(negativeAudit.items[0]?.version, 1);
    assert.equal(negativeAudit.items[0]?.review_status, 'unreviewed');
    assert.equal(negativeAudit.pending_target_ids.length, 3);
    assert.deepEqual(await batchAuditPlan(root, 'example', auditOptions), negativeAudit);
    await assert.rejects(batchAuditPlan(root, 'example', { ...auditOptions, negative_fraction: 0.1 }));
    await assert.rejects(submitBatch(root, 'example', { ...submission, request_id: 'stale-request' }));
    await assert.rejects(submitBatch(root, 'example', { ...submission, request_id: 'bad-unresolved',
      judgments: [{ ...submission.judgments[0], expected_version: 1, unresolved_evidence_ids: [first.evidence_id] }] }));
    const correction = { ...submission.judgments[0], target_id: first.target_id, expected_version: 1,
      reading: 'inspected', judgment: 'positive', classification: 'correction', evidence_status: 'sufficient',
      inspected_evidence_ids: [first.evidence_id], unresolved_evidence_ids: [],
      citations: [{ evidence_id: first.evidence_id, quote: long.slice(0, 10) }] };
    await Promise.all([
      submitBatch(root, 'example', { ...submission, request_id: 'revision-two', judgments: [correction] }),
      submitBatch(root, 'example', { ...submission, request_id: 'revision-two', judgments: [correction] }),
    ]);
    assert.equal((await batchStatus(root, 'example')).revision, 2);
    const revisedAudit = await batchAuditPlan(root, 'example', auditOptions);
    assert.equal(revisedAudit.totals.positive, 1);
    assert.deepEqual((await batchStatus(root, 'example')).labels, { correction: 1, intervention: 0, intersection: 0, positive_targets: 1 });
    assert.equal(revisedAudit.items[0]?.version, 2);
    assert.notEqual(revisedAudit.items[0]?.judgment_hash, negativeAudit.items[0]?.judgment_hash);
    const ledgerPath = path.join(root, 'batches', 'example', 'ledger.json');
    const ledger = validateLedger(JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as unknown, manifest);
    assert.throws(() => validateLedger({ ...ledger, revision: 99 }, manifest));
    const brokenHistory = structuredClone(ledger);
    const historyEntry = brokenHistory.history[0];
    assert.ok(historyEntry);
    historyEntry.request_hash = stableHash('changed');
    assert.throws(() => validateLedger(brokenHistory, manifest));
    const missingTarget = structuredClone(ledger);
    const firstJudgment = missingTarget.history[0]?.judgments[0];
    assert.ok(firstJudgment);
    firstJudgment.target_id = 'unknown';
    assert.throws(() => validateLedger(missingTarget, manifest));
    await assert.rejects(submitBatch(root, 'example', { ...submission, request_id: 'revision-two', judgments: [{ ...correction, citations: [] }] }));
    await assert.rejects(submitBatch(root, 'example', { ...submission, request_id: 'bad-quote', judgments: [{ ...correction, expected_version: 2, citations: [{ evidence_id: first.evidence_id, quote: 'not-in-evidence' }] }] }));
    await fs.appendFile(files[0] ?? '', '{}\n');
    assert.deepEqual(await loadBatch(root, 'example'), manifest);
    await assert.rejects(saveBatch(root, input));
    const appendRequest = { schema: 'session-correction-analysis/batch-append/v1', batch_id: 'grown', sources: [input.sources[0]] };
    const parentBytes = await fs.readFile(path.join(root, 'batches', 'example', 'manifest.json'));
    const parentLedger = await fs.readFile(path.join(root, 'batches', 'example', 'ledger.json'));
    const lineage = await appendBatch(root, 'example', appendRequest);
    assert.equal(lineage.appended_source_ids.length, 1);
    assert.equal(lineage.added_target_ids.length, 2);
    assert.equal(lineage.semantics_inherited, false);
    assert.ok(lineage.source_differences?.some(diff => diff.relation === 'exact_events'));
    assert.deepEqual(await appendBatch(root, 'example', appendRequest), lineage);
    const { source_differences: _diffs, ...legacyLineage } = lineage;
    await fs.writeFile(path.join(root, 'batches', 'grown', 'lineage.json'), JSON.stringify(legacyLineage));
    assert.deepEqual(await appendBatch(root, 'example', appendRequest), lineage);
    const grown = await loadBatch(root, 'grown');
    assert.equal(grown.sources.length, 3);
    assert.equal(grown.targets.length, 6);
    assert.deepEqual(grown.sources.slice(0, 2), manifest.sources);
    assert.equal((await batchStatus(root, 'grown')).pending, 6);
    assert.deepEqual(await fs.readFile(path.join(root, 'batches', 'example', 'manifest.json')), parentBytes);
    assert.deepEqual(await fs.readFile(path.join(root, 'batches', 'example', 'ledger.json')), parentLedger);
    await assert.rejects(appendBatch(root, 'example', { ...appendRequest, batch_id: 'example' }));
    const original = Buffer.from(manifest.sources[0]?.frozen_bytes_base64 ?? '', 'base64').toString('utf8');
    assert.ok(original.includes(long.slice(0, 1)));
    assert.equal((await fs.readdir(root)).includes('records'), false);
    const output: string[] = [];
    assert.equal(await runCli(['batch', '--action', 'status', '--batch', 'example', '--data-root', root], {
      env: {}, stdout: line => output.push(line), stderr: line => output.push(line),
    }), 0);
    const cliResult: unknown = JSON.parse(output[0] ?? '{}');
    assert.ok(typeof cliResult === 'object' && cliResult !== null && 'pending' in cliResult);
    assert.equal(cliResult.pending, 3);
    const auditFile = path.join(root, 'audit-options.json');
    await fs.writeFile(auditFile, JSON.stringify(auditOptions));
    for (const action of ['identity', 'audit']) {
      output.length = 0;
      assert.equal(await runCli(['batch', '--action', action, '--batch', 'example', '--offset', '0', '--limit', '1',
        ...(action === 'audit' ? ['--input', auditFile] : []), '--data-root', root], {
        env: {}, stdout: line => output.push(line), stderr: line => output.push(line),
      }), 0);
      const query: unknown = JSON.parse(output[0] ?? '{}');
      assert.ok(typeof query === 'object' && query !== null);
      const entries: unknown = 'issues' in query ? query.issues : 'items' in query ? query.items : undefined;
      assert.ok(Array.isArray(entries) && entries.length <= 1);
      assert.deepEqual(await fs.readFile(path.join(root, 'batches', 'example', 'manifest.json')), parentBytes);
      assert.deepEqual(await fs.readFile(path.join(root, 'batches', 'example', 'ledger.json')), parentLedger);
    }
    const secretFile = path.join(root, 'invalid.json');
    await fs.writeFile(secretFile, 'SECRET_API_TOKEN_not_JSON');
    const errors: string[] = [];
    assert.equal(await runCli(['batch', '--action', 'create', '--input', secretFile, '--data-root', root], {
      env: {}, stdout: line => errors.push(line), stderr: line => errors.push(line),
    }), 2);
    assert.ok(errors.join('').includes('schema_invalid'));
    assert.equal(errors.join('').includes('SECRET_API'), false);
    errors.length = 0;
    assert.equal(await runCli(['batch', '--action', 'page', '--batch', 'example', '--cursor', 'SECRET_API_TOKEN_not_JSON', '--data-root', root], {
      env: {}, stdout: line => errors.push(line), stderr: line => errors.push(line),
    }), 2);
    assert.equal(errors.join('').includes('SECRET_API'), false);
    await fs.writeFile(secretFile, JSON.stringify({ task_id: 'task', owner: 'worker', generation: 1, outcome: 'SECRET_API_TOKEN_ABC' }));
    errors.length = 0;
    assert.equal(await runCli(['batch', '--action', 'finish', '--batch', 'example', '--input', secretFile, '--data-root', root], {
      env: {}, stdout: line => errors.push(line), stderr: line => errors.push(line),
    }), 2);
    assert.ok(errors.join('').includes('schema_invalid'));
    assert.equal(errors.join('').includes('SECRET_API'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('batch never drops same-text targets with different declared source actors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-batch-role-'));
  try {
    const file = path.join(root, 'source.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'meta', host: 'codex', source_session_id: 's' }) + '\n' +
      JSON.stringify({ type: 'event', id: 'u', kind: 'user_message', text: '同一正文' }) + '\n');
    const base = { path: file, host: 'codex', session_id: 's', created_at: '2026-09-01T00:00:00Z', role_basis: 'user_declared' };
    const manifest = await saveBatch(root, { schema: 'session-correction-analysis/batch-input/v1', batch_id: 'actors',
      scope: { time_zone: 'UTC', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'explicit' },
      sources: [{ ...base, role: 'direct' }, { ...base, role: 'guardian' }],
    });
    assert.equal(manifest.targets.length, 2);
    const dualTarget = manifest.targets[0];
    assert.ok(dualTarget);
    const dualSubmission = { schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: stableHash(manifest), request_id: 'dual',
      judgments: [{ target_id: dualTarget.target_id, expected_version: 0, reading: 'inspected', judgment: 'positive', classification: 'correction',
        labels: { correction: true, intervention: true }, evidence_status: 'sufficient', inspected_evidence_ids: [dualTarget.evidence_id],
        unresolved_evidence_ids: [], citations: [{ evidence_id: dualTarget.evidence_id, quote: '同一正文' }] }] };
    assert.deepEqual(await submitBatch(root, 'actors', dualSubmission), { duplicate: false, revision: 1 });
    assert.deepEqual(await submitBatch(root, 'actors', dualSubmission), { duplicate: true, revision: 1 });
    const actorLedger = validateLedger(JSON.parse(await fs.readFile(path.join(root, 'batches', 'actors', 'ledger.json'), 'utf8')) as unknown, manifest);
    assert.deepEqual(actorLedger.history[0]?.judgments[0], dualSubmission.judgments[0]);
    const actorStatus = await batchStatus(root, 'actors');
    assert.deepEqual(actorStatus.labels, { correction: 1, intervention: 1, intersection: 1, positive_targets: 1 });
    assert.equal(actorStatus.semantic_complete, 1);
    assert.equal(actorStatus.actor_coverage.find(item => item.role === 'direct')?.targets, 1);
    assert.equal(actorStatus.actor_coverage.find(item => item.role === 'guardian')?.pending, 1);
    assert.equal(actorStatus.actor_coverage.find(item => item.role === 'automation')?.submitted_coverage, null);
    const inventory = identityInventory(manifest);
    assert.equal(inventory.affected_sources, 2);
    assert.equal(inventory.affected_targets, 2);
    assert.equal(inventory.issues[0]?.reason, 'same_session_actor_conflict');
    assert.equal(inventory.issues[0]?.semantic_reuse_authorized, false);
    assert.equal(JSON.stringify(inventory).includes('同一正文'), false);
    assert.equal(manifest.targets[1]?.reuse_candidate_of, undefined);
    assert.ok(manifest.sources[1]?.events[0]?.reading_reuse_of);
    await assert.rejects(saveBatch(root, { ...manifest, schema: 'session-correction-analysis/batch-input/v1' }));
    assert.throws(() => evidencePage(manifest, { max_bytes: 2048, cursor: { manifest_hash: stableHash('wrong'), source_index: 0, event_index: 0, text_offset: 0 } }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
