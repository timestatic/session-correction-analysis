import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Allowlist release contents: never include transcripts, records or node_modules.
const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.versions.node.split('.')[0], '24', 'Build and run with Node.js 24');
const outputRoot = path.join(root, 'dist', 'skill-releases');
await fs.mkdir(outputRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(outputRoot, 'trial-'));
const name = 'session-correction-analysis';
const skill = path.join(output, name);
await fs.mkdir(path.join(skill, 'scripts'), { recursive: true });
await fs.copyFile(path.join(root, 'skills', name, 'SKILL.md'), path.join(skill, 'SKILL.md'));
await build({
  entryPoints: [path.join(root, 'src', 'cli.ts')],
  outfile: path.join(skill, 'scripts', 'sca.mjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm',
  banner: { js: "import { createRequire as scaCreateRequire } from 'node:module'; const require = scaCreateRequire(import.meta.url);" },
  legalComments: 'eof',
});

// Exercise the actual relocated bundle, not source imports. No real session data.
const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sca-skill-smoke-')));
try {
  const relocated = path.join(sandbox, name);
  await fs.cp(skill, relocated, { recursive: true });
  const cli = path.join(relocated, 'scripts', 'sca.mjs');
  const data = path.join(sandbox, 'data');
  const invoke = (...args) => {
    const result = JSON.parse(execFileSync(process.execPath, [cli, ...args, '--data-root', data], { cwd: sandbox, encoding: 'utf8' }));
    assert.equal(result.ok, true, `${args[0]} failed`);
    return result;
  };
  invoke('doctor');
  const transcript = path.join(sandbox, 'synthetic.jsonl');
  await fs.writeFile(transcript, [
    { type: 'meta', host: 'codex', source_session_id: 'skill-smoke', workspace: sandbox },
    { type: 'event', id: 'u1', kind: 'user_message', text: '请解释这段代码。' },
    { type: 'event', id: 'a1', kind: 'assistant_message', text: '我准备直接修改。' },
    { type: 'event', id: 'u2', kind: 'user_message', text: '不要修改，先解释。' },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');
  const registered = invoke('register', '--host', 'codex', '--session', 'skill-smoke', '--workspace', sandbox, '--transcript', transcript);
  const prepared = invoke('prepare', registered.record_id);
  const packet = JSON.parse(await fs.readFile(prepared.packet_path, 'utf8'));
  const submission = path.join(sandbox, 'submission.json');
  const user = packet.evidence.find(item => item.excerpt === '不要修改，先解释。');
  assert.ok(user);
  await fs.writeFile(submission, JSON.stringify({
    processed_users: packet.user_coverage.map(entry => ({ evidence_id: entry.evidence_id, status: 'reviewed' })),
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
  assert.ok(detail.provenance.evidence.some(item => item.excerpt.includes('不要修改')));
  const edit = path.join(sandbox, 'edit.md');
  await fs.writeFile(edit, '只解释代码；修改前取得明确授权。');
  const edited = invoke(...review, '--action', 'edit_content', '--content-file', edit, '--request', 'smoke-edit', '--expected-revision', String(detail.revision));
  const approved = invoke(...review, '--action', 'approve', '--request', 'smoke-approve', '--expected-revision', String(edited.revision));
  const copied = invoke(...review, '--action', 'copy_content');
  assert.ok(copied.content.includes('只解释代码'));
  const out = path.join(sandbox, 'approved.md');
  invoke(...review, '--action', 'export_content', '--out', out);
  assert.equal(await fs.readFile(out, 'utf8'), copied.content);
  const reloaded = invoke(...review);
  assert.equal(reloaded.revision, approved.revision);
  assert.equal(reloaded.candidate.status, 'approved');
  invoke('validate', registered.record_id);
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}
const archive = path.join(output, `${name}-0.1.0-trial.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', output, name]);
await fs.writeFile(`${archive}.sha256`, `${createHash('sha256').update(await fs.readFile(archive)).digest('hex')}  ${path.basename(archive)}\n`);
process.stdout.write(JSON.stringify({ archive, skill, smoke: 'doctor/register/prepare/ingest/detail/edit/approve/copy/export/reload/validate passed', maturity: 'Phase 1 analysis and human review trial; no automatic publishing' }, null, 2) + '\n');
