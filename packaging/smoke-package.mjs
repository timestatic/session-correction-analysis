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
  await fs.access(path.join(root, 'dist', 'src', 'cli.js'));
  const [{ filename }] = JSON.parse(run(['pack', '--json', '--pack-destination', scratch]));
  const archive = path.join(scratch, filename);
  const prefix = path.join(scratch, 'prefix');
  await fs.mkdir(prefix, { recursive: true });
  run(['install', '--silent', '--no-audit', '--no-fund', '--prefix', prefix, archive]);

  const bin = path.join(prefix, 'node_modules', '.bin', 'sca');
  await fs.access(bin);

  const data = path.join(scratch, 'data');
  const invoke = (...args) => {
    const result = JSON.parse(execFileSync(bin, [...args, '--data-root', data], { encoding: 'utf8' }));
    assert.equal(result.ok, true, `${args[0]} failed`);
    return result;
  };

  invoke('doctor');
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

  process.stdout.write(`${JSON.stringify({ archive, smoke: 'pack/doctor/register/prepare/ingest/detail/edit/approve/copy/export/adopt/replay/rules/revoke/validate passed' }, null, 2)}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
