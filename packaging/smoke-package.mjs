import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

/**
 * Installs the real `npm pack` tarball into a throwaway prefix and drives the
 * full lifecycle through the resulting bin, so a missing `files` entry, a broken
 * bin shim or an unresolved dependency fails here instead of on a user's machine.
 * Run `npm run build` first; `npm pack` ships whatever `dist/` currently holds.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sca-pkg-smoke-')));

function run(args, opts = {}) {
  return execFileSync('npm', args, { cwd: root, encoding: 'utf8', ...opts }).trim();
}

try {
  execFileSync('zstd', ['--version'], { stdio: 'ignore' });
  await fs.access(path.join(root, 'dist', 'src', 'cli.js'));
  const [{ filename }] = JSON.parse(run(['pack', '--json', '--pack-destination', scratch]));
  const archive = path.join(scratch, filename);
  const prefix = path.join(scratch, 'prefix');
  await fs.mkdir(prefix, { recursive: true });
  run(['install', '--silent', '--no-audit', '--no-fund', '--prefix', prefix, archive]);

  for (const name of ['BATCH_PROTOCOL.md', 'BATCH_RECOVERY.md', 'BATCH_COMPATIBILITY.md', 'BATCH_EXECUTION.md']) {
    const relative = path.join('skills', 'session-correction-analysis', 'references', name);
    const installed = await fs.readFile(path.join(prefix, 'node_modules', 'session-correction-analysis', relative), 'utf8');
    assert.equal(installed, await fs.readFile(path.join(root, relative), 'utf8'));
    for (const match of installed.matchAll(/\]\(<([^>]+\.md)>\)/g)) {
      await fs.access(path.resolve(prefix, 'node_modules', 'session-correction-analysis', path.dirname(relative), match[1]));
    }
  }

  const bin = path.join(prefix, 'node_modules', '.bin', 'sca');
  await fs.access(bin);

  const data = path.join(scratch, 'data');
  const invoke = (...args) => {
    const result = JSON.parse(execFileSync(bin, [...args, '--data-root', data], { encoding: 'utf8' }));
    assert.equal(result.ok, true, `${args[0]} failed`);
    return result;
  };

  const doctor = invoke('doctor');
  const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(doctor.version, packageInfo.version);
  const transcript = path.join(scratch, 'synthetic.jsonl');
  await fs.writeFile(transcript, [
    { type: 'meta', host: 'codex', source_session_id: 'pkg-smoke', workspace: scratch },
    { type: 'event', id: 'u1', kind: 'user_message', text: '请解释这段代码。' },
    { type: 'event', id: 'a1', kind: 'assistant_message', text: '我准备直接修改。' },
    { type: 'event', id: 'u2', kind: 'user_message', text: '不要修改，先解释。' },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');

  const registered = invoke('register', '--host', 'codex', '--session', 'pkg-smoke', '--workspace', scratch, '--transcript', transcript);
  const prepared = invoke('prepare', registered.record_id);
  const packet = JSON.parse(await fs.readFile(prepared.packet_path, 'utf8'));
  const user = packet.evidence.find((item) => item.excerpt === '不要修改，先解释。');
  assert.ok(user);
  const submission = path.join(scratch, 'submission.json');
  await fs.writeFile(submission, JSON.stringify({
    processed_users: packet.user_coverage.map((entry) => ({ evidence_id: entry.evidence_id, status: 'reviewed' })),
    episodes: [{ anchor_event_id: user.id, issue_anchor: 'explain-first',
      correction: { detected: true, confidence: 'high', prior_agent_behavior: [], agent_behavior_after: [], explanation: '先解释再修改' },
      intervention: { detected: false, confidence: 'high', evidence: [], explanation: '无其他介入' },
      citations: [{ evidence_id: user.id, quote: '不要修改' }] }],
    candidates: [{ title: '先解释', category: 'process', confidence: 'high', proposed_content: '修改前解释', evidence: [user.id],
      source_episode_anchor: user.id, source_issue_anchor: 'explain-first' }],
  }));
  invoke('ingest', registered.record_id, '--run', prepared.run_id, '--submission', submission);

  const review = ['review', registered.record_id, '--candidate', 'learning-001'];
  const detail = invoke(...review);
  assert.equal(detail.provenance.status, 'available');
  assert.equal(detail.version, packageInfo.version);
  assert.ok(detail.provenance.evidence.every((item) => !Object.hasOwn(item, 'excerpt')));
  assert.equal(detail.provenance.episodes[0].citations[0].quote.text, '不要修改');
  const fullDetail = invoke(...review, '--full');
  assert.ok(fullDetail.provenance.evidence.some((item) => item.excerpt === '不要修改，先解释。'));
  const edit = path.join(scratch, 'edit.md');
  await fs.writeFile(edit, '只解释代码；修改前取得明确授权。');
  const edited = invoke(...review, '--action', 'edit_content', '--content-file', edit, '--request', 'pkg-edit', '--expected-revision', String(detail.revision));
  invoke(...review, '--action', 'approve', '--request', 'pkg-approve', '--expected-revision', String(edited.revision));
  const copied = invoke(...review, '--action', 'copy_content');
  assert.ok(copied.content.includes('只解释代码'));
  const exported = path.join(scratch, 'approved.md');
  invoke(...review, '--action', 'export_content', '--out', exported);
  assert.equal(await fs.readFile(exported, 'utf8'), copied.content);

  // adoption ledger: adopt → replay → list/detail → revoke, all through the packed bin
  const approvedView = invoke('review', registered.record_id);
  const adopted = invoke('adopt', registered.record_id, '--candidate', 'learning-001',
    '--request', 'pkg-adopt', '--expected-revision', String(approvedView.revision));
  assert.equal(adopted.rule.status, 'active');
  await fs.access(path.join(data, 'accepted_rules.md'));
  const replay = invoke('adopt', registered.record_id, '--candidate', 'learning-001',
    '--request', 'pkg-adopt', '--expected-revision', String(approvedView.revision));
  assert.equal(replay.duplicate, true);
  const listed = invoke('rules');
  assert.equal(listed.rules.length, 1);
  const detailRule = invoke('rules', '--rule', adopted.rule.rule_id);
  assert.ok(detailRule.rule.content.includes('只解释代码'));
  invoke('rules', '--revoke', adopted.rule.rule_id, '--request', 'pkg-revoke', '--expected-revision', String(listed.revision));
  assert.equal(invoke('rules').count, 0);

  invoke('validate', registered.record_id);

  const dshTranscript = path.join(scratch, 'session.v4.jsonl.zstd');
  const native = (seq, type, value) => ({ seq, time: 1_790_000_000_000 + seq, type, data: value });
  const nativeEdit = (seq, callId) => native(seq, 'tool/call', { name: 'edit', callId,
    arguments: JSON.stringify({ file_path: path.join(scratch, 'a.ts'), old_string: 'old', new_string: 'new' }) });
  const nativeResult = (seq, callId) => native(seq, 'tool/result', { error: null,
    message: { role: 'user', source: { kind: 'tool', callId }, isError: false, content: [{ type: 'text', text: 'done' }] } });
  const nativeRows = [{ type: 'session', version: 4, id: 'pkg-dsh', cwd: scratch, createdAt: 1_790_000_000_000,
    isSeeded: false, delegationDepth: 0 }, nativeEdit(0, 'before'), nativeResult(1, 'before'),
    native(2, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '先检查配置' }] }),
    nativeEdit(3, 'after'), nativeResult(4, 'after'),
    native(5, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })];
  await fs.writeFile(dshTranscript, execFileSync('zstd', ['-q', '-c'], {
    input: nativeRows.map(row => JSON.stringify(row)).join('\n') + '\n' }));
  const dshRegistered = invoke('register', '--host', 'dsh', '--session', 'pkg-dsh', '--workspace', scratch, '--transcript', dshTranscript);
  const dshPrepared = invoke('prepare', dshRegistered.record_id);
  const dshPacket = JSON.parse(await fs.readFile(dshPrepared.packet_path, 'utf8'));
  assert.equal(dshPacket.snapshot.source_encoding, 'zstd');
  assert.equal(dshPacket.snapshot.workspace_verification, 'matched');
  assert.equal(dshPacket.snapshot.coverage, 'full');
  assert.equal(dshPacket.user_coverage.length, 1);
  assert.equal(dshPacket.intervention_coverage.length, 1);
  assert.equal(dshPacket.rework_hints.length, 1);
  const stop = dshPacket.evidence.find(item => item.kind === 'interrupt');
  assert.ok(stop);
  const dshSubmission = path.join(scratch, 'dsh-submission.json');
  await fs.writeFile(dshSubmission, JSON.stringify({
    processed_users: dshPacket.user_coverage.map(entry => ({ evidence_id: entry.evidence_id, status: 'reviewed' })),
    processed_interventions: dshPacket.intervention_coverage.map(entry => ({ evidence_id: entry.evidence_id, status: 'reviewed' })),
    episodes: [{ anchor_event_id: stop.id, issue_anchor: 'stop-turn',
      correction: { detected: false, confidence: 'high', prior_agent_behavior: [], agent_behavior_after: [], explanation: '无文字纠错' },
      intervention: { detected: true, confidence: 'high', kind: 'interrupt_turn', evidence: [stop.id], explanation: '用户停止执行' },
      citations: [{ evidence_id: stop.id, quote: stop.excerpt }] }], candidates: [] }));
  assert.equal(invoke('ingest', dshRegistered.record_id, '--run', dshPrepared.run_id, '--submission', dshSubmission).episode_ids.length, 1);
  invoke('validate', dshRegistered.record_id);

  process.stdout.write(`${JSON.stringify({ archive, dsh_smoke: 'compressed/register/prepare/native-intervention/rework-hints/ingest/validate passed', smoke: 'pack/doctor/register/prepare/ingest/detail/edit/approve/copy/export/adopt/replay/rules/revoke/validate passed' }, null, 2)}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
