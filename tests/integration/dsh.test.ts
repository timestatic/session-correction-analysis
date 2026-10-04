import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, it } from 'node:test';

import { runCli } from '../../src/cli.js';
import type { PreparePacket } from '../../src/analysis/prepare.js';
import { buildBatch } from '../../src/batch/index.js';
import { validateManifest } from '../../src/batch/integrity.js';
import { reworkEvidencePairs } from '../../src/batch/rework.js';
import { RecordRepository } from '../../src/store/repository.js';
import { validateReworkClaim } from '../../src/batch/rework-validation.js';
import type { Judgment } from '../../src/batch/schema.js';

const HAS_ZSTD = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

async function setup(): Promise<{ dir: string; transcript: string; data: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-dsh-cli-'));
  dirs.push(dir);
  const session = path.join(dir, 'session');
  await fs.mkdir(session);
  const header = { type: 'session', version: 4, id: 'session-dsh', cwd: dir, createdAt: 1_790_000_000_000, isSeeded: false, delegationDepth: 0 };
  const event = (seq: number, type: string, data: unknown) => ({ seq, time: header.createdAt + seq, type, data });
  const edit = (seq: number, id: string) => event(seq, 'tool/call', { name: 'edit', callId: id,
    arguments: JSON.stringify({ file_path: path.join(dir, 'a.ts'), old_string: 'old', new_string: 'new' }) });
  const result = (seq: number, id: string) => event(seq, 'tool/result', { error: null,
    message: { role: 'user', source: { kind: 'tool', callId: id }, isError: false, content: [{ type: 'text', text: 'done' }] } });
  const rows = [header, edit(0, 'before'), result(1, 'before'), event(2, 'user/message', {
    role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '不要改错文件，先检查配置' }] }),
  edit(3, 'after'), result(4, 'after')];
  const transcript = path.join(session, 'session.v4.jsonl.zstd');
  await fs.writeFile(transcript, execFileSync('zstd', ['-q', '-c'], { input: rows.map(row => JSON.stringify(row)).join('\n') + '\n' }), { mode: 0o600 });
  await fs.writeFile(path.join(session, 'session.v3.jsonl'), JSON.stringify({ ...header, version: 3 }) + '\n');
  return { dir, transcript, data: path.join(dir, 'data') };
}

async function cli(args: string[]): Promise<Record<string, unknown>> {
  const output: string[] = [];
  const code = await runCli(args, { env: { PATH: process.env['PATH'] ?? '' }, stdout: line => output.push(line), stderr: line => output.push(line) });
  assert.equal(code, 0, output.join('\n'));
  return JSON.parse(output.join('\n')) as Record<string, unknown>;
}

it('registers the highest explicit generation and runs prepare, ingest, review, approve and copy', { skip: !HAS_ZSTD }, async () => {
  const { dir, transcript, data } = await setup();
  const registered = await cli(['register', '--host', 'dsh', '--session', 'session-dsh', '--workspace', dir,
    '--transcript', path.dirname(transcript), '--data-root', data]);
  const record = String(registered['record_id']);
  const prepared = await cli(['prepare', record, '--data-root', data]);
  const packet = JSON.parse(await fs.readFile(String(prepared['packet_path']), 'utf8')) as PreparePacket;
  const anchor = packet.evidence.find(item => item.kind === 'user_text');
  assert.ok(anchor);
  assert.equal(packet.snapshot.host, 'dsh');
  assert.equal(packet.snapshot.coverage, 'full');
  const submission = path.join(dir, 'submission.json');
  await fs.writeFile(submission, JSON.stringify({ processed_users: [{ evidence_id: anchor.id, status: 'reviewed' }],
    episodes: [{ anchor_event_id: anchor.id, issue_anchor: 'wrong-file', correction: { detected: true, confidence: 'high',
      prior_agent_behavior: [], agent_behavior_after: [], explanation: '纠正修改对象' },
    intervention: { detected: false, confidence: 'high', evidence: [], explanation: '无' }, citations: [{ evidence_id: anchor.id, quote: '不要改错文件' }] }],
    candidates: [{ title: '检查配置', category: 'process', confidence: 'high', proposed_content: '修改前先检查配置',
      evidence: [anchor.id], source_episode_anchor: anchor.id, source_issue_anchor: 'wrong-file' }] }));
  await cli(['ingest', record, '--run', packet.run_id, '--submission', submission, '--data-root', data]);
  const review = await cli(['review', record, '--candidate', 'learning-001', '--data-root', data]);
  assert.equal((review['source_origin_counts'] as Record<string, number>)['human'], 1);
  await cli(['review', record, '--candidate', 'learning-001', '--action', 'approve', '--request', 'dsh-approve',
    '--expected-revision', String(review['revision']), '--data-root', data]);
  const copied = await cli(['review', record, '--candidate', 'learning-001', '--action', 'copy_content', '--data-root', data]);
  assert.ok(JSON.stringify(copied).includes('修改前先检查配置'));
});

it('indexes explicit DSH batch sources and native successful rework pairs without keyword success', { skip: !HAS_ZSTD }, async () => {
  const { transcript } = await setup();
  const manifest = await buildBatch({ schema: 'session-correction-analysis/batch-input/v1', batch_id: 'dsh',
    scope: { time_zone: 'Asia/Shanghai', start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'explicit' },
    sources: [{ host: 'dsh', path: transcript, session_id: 'session-dsh', created_at: '2026-09-01T00:00:00Z', role: 'direct', role_basis: 'native_metadata' }] });
  validateManifest(manifest);
  assert.equal(manifest.sources[0]?.native_metadata?.format_version, 4);
  assert.equal(manifest.targets.length, 1);
  assert.equal(reworkEvidencePairs(manifest).length, 1);
});

it('submits native intervention anchors separately from user messages and fences the receipts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-native-intervention-'));
  dirs.push(dir);
  const transcript = path.join(dir, 'session.v4.jsonl');
  const rows = [
    { type: 'session', version: 4, id: 'native', cwd: dir, createdAt: 1_790_000_000_000, isSeeded: false, delegationDepth: 0 },
    { seq: 0, time: 1_790_000_000_000, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    { seq: 1, time: 1_790_000_000_001, type: 'approval/decided', data: { decision: 'deny' } },
    { seq: 2, time: 1_790_000_000_002, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'parent' } } } },
  ];
  await fs.writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const data = path.join(dir, 'data');
  const registered = await cli(['register', '--host', 'dsh', '--session', 'native', '--workspace', dir, '--transcript', transcript, '--data-root', data]);
  const record = String(registered['record_id']);
  const prepared = await cli(['prepare', record, '--data-root', data]);
  assert.equal(prepared['user_message_count'], 0);
  assert.equal(prepared['intervention_target_count'], 2);
  assert.equal(prepared['workspace_verification'], 'matched');
  const packet = JSON.parse(await fs.readFile(String(prepared['packet_path']), 'utf8')) as PreparePacket;
  assert.equal(packet.user_coverage.length, 0);
  const anchor = packet.evidence.find(item => item.kind === 'interrupt');
  assert.ok(anchor);
  assert.equal(anchor.origin?.kind, 'human');
  const approval = packet.evidence.find(item => item.kind === 'approval');
  assert.equal(approval?.origin?.kind, 'unknown');
  const submission = path.join(dir, 'submission.json');
  const payload = { processed_users: [],
    processed_interventions: packet.intervention_coverage?.map(entry => ({ evidence_id: entry.evidence_id, status: 'reviewed' })),
    episodes: [{ anchor_event_id: anchor.id, issue_anchor: 'stop', correction: { detected: false, confidence: 'high',
      prior_agent_behavior: [], agent_behavior_after: [], explanation: '没有文字纠错' },
      intervention: { detected: true, confidence: 'high', kind: 'interrupt_turn', evidence: [anchor.id], explanation: '用户停止' },
      citations: [{ evidence_id: anchor.id, quote: anchor.excerpt }] }], candidates: [] };
  await fs.writeFile(submission, JSON.stringify({ ...payload, processed_interventions: [] }));
  const errors: string[] = [];
  assert.equal(await runCli(['ingest', record, '--run', packet.run_id, '--submission', submission, '--data-root', data],
    { env: process.env, stdout: line => errors.push(line), stderr: line => errors.push(line) }), 2);
  assert.ok(errors.join('').includes('cover every native intervention'));
  await fs.writeFile(submission, JSON.stringify({ ...payload, episodes: payload.episodes.map(episode => ({
    ...episode, correction: { ...episode.correction, detected: true } })) }));
  const mislabeled: string[] = [];
  assert.equal(await runCli(['ingest', record, '--run', packet.run_id, '--submission', submission, '--data-root', data],
    { env: process.env, stdout: line => mislabeled.push(line), stderr: line => mislabeled.push(line) }), 2);
  assert.ok(mislabeled.join('').includes('no textual correction label'));
  await fs.writeFile(submission, JSON.stringify(payload));
  const result = await cli(['ingest', record, '--run', packet.run_id, '--submission', submission, '--data-root', data]);
  assert.equal((result['episode_ids'] as string[]).length, 1);
  await cli(['validate', record, '--data-root', data]);
  const manifest = await buildBatch({ schema: 'session-correction-analysis/batch-input/v1', batch_id: 'native',
    scope: { time_zone: 'UTC', start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'synthetic' },
    sources: [{ host: 'dsh', path: transcript, session_id: 'native', created_at: '2026-09-01T00:00:00Z', role: 'direct', role_basis: 'user_declared' }] });
  assert.equal(manifest.targets.length, 2);
  validateManifest(manifest);
  const target = manifest.targets[0];
  assert.ok(target);
  const judgment: Judgment = { target_id: target.target_id, expected_version: 0, reading: 'inspected',
    judgment: 'positive', classification: 'correction', evidence_status: 'sufficient',
    inspected_evidence_ids: [target.evidence_id], unresolved_evidence_ids: [], citations: [] };
  assert.throws(() => validateReworkClaim(manifest, judgment), /cannot be labeled as textual corrections/);
  validateReworkClaim(manifest, { ...judgment, classification: 'intervention' });
  const legacy = structuredClone(manifest);
  for (const source of legacy.sources) if (source.native_metadata !== undefined) delete source.native_metadata.intervention_targets;
  legacy.targets = [];
  validateManifest(legacy);
  const repo = new RecordRepository(data);
  assert.equal((await repo.loadAnalyze(record)).doc.facts?.snapshot.coverage, 'full');
  const again = await cli(['prepare', record, '--data-root', data]);
  await fs.writeFile(submission, JSON.stringify({ processed_users: [], episodes: [], candidates: [] }));
  await cli(['ingest', record, '--run', String(again['run_id']), '--submission', submission, '--data-root', data]);
  assert.equal((await repo.loadAnalyze(record)).doc.facts?.snapshot.coverage, 'partial');
});
