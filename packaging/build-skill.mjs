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
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');
  const registered = invoke('register', '--host', 'codex', '--session', 'skill-smoke', '--workspace', sandbox, '--transcript', transcript);
  const prepared = invoke('prepare', registered.record_id);
  const packet = JSON.parse(await fs.readFile(prepared.packet_path, 'utf8'));
  const submission = path.join(sandbox, 'submission.json');
  await fs.writeFile(submission, JSON.stringify({ episodes: [], candidates: [], processed_users: packet.user_coverage.map((user) => ({ evidence_id: user.evidence_id, status: 'reviewed' })) }));
  invoke('ingest', registered.record_id, '--run', prepared.run_id, '--submission', submission);
  invoke('validate', registered.record_id);
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}
const archive = path.join(output, `${name}-0.1.0-trial.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', output, name]);
await fs.writeFile(`${archive}.sha256`, `${createHash('sha256').update(await fs.readFile(archive)).digest('hex')}  ${path.basename(archive)}\n`);
process.stdout.write(JSON.stringify({ archive, skill, smoke: 'doctor/register/prepare/ingest/validate passed', maturity: 'analysis-only trial; not full plugin release' }, null, 2) + '\n');
