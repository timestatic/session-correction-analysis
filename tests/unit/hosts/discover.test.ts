import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { CliIo } from '../../../src/cli.js';
import { runCli } from '../../../src/cli.js';

const MARKER = 'sca-probe-0f5c6a92-3b47-4c1d-9e2f-1a2b3c4d5e6f';

const tmpRoots: string[] = [];
after(async () => {
  for (const dir of tmpRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function capture(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  return { io: { env: {}, stdout: (line) => out.push(line), stderr: () => {} }, out };
}

function lastJson(out: string[]): Record<string, unknown> {
  const last = out[out.length - 1];
  assert.ok(last !== undefined, 'expected CLI stdout output');
  return JSON.parse(last) as Record<string, unknown>;
}

async function writeCodexSession(home: string, name: string, lines: unknown[]): Promise<string> {
  const now = new Date();
  const dir = path.join(
    home,
    '.codex',
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  return file;
}

function codexMeta(id: string, cwd: string): unknown {
  return { type: 'session_meta', payload: { session_id: id, id, timestamp: '2026-09-22T07:00:00Z', cwd } };
}

function codexCommand(command: string): unknown {
  return { type: 'response_item', payload: { type: 'custom_tool_call', id: `ctc-${command.length}`, call_id: 'c1', name: 'exec', input: command } };
}

describe('cli discover (codex)', () => {
  it('finds the single transcript whose command text carries the marker', async () => {
    const home = await tempDir('sca-disc-home-');
    const ws = await tempDir('sca-disc-ws-');
    const hit = await writeCodexSession(home, 'rollout-a.jsonl', [
      codexMeta('thr-probe-a', ws),
      codexCommand('cat README.md'),
      codexCommand(`echo ${MARKER}`),
    ]);
    await writeCodexSession(home, 'rollout-b.jsonl', [codexMeta('thr-probe-b', ws), codexCommand('ls')]);

    const cap = capture();
    const code = await runCli(
      ['discover', '--host', 'codex', '--marker', MARKER, '--workspace', ws, '--home', home],
      cap.io,
    );
    assert.equal(code, 0);
    const report = lastJson(cap.out);
    assert.equal(report['ok'], true);
    assert.equal(report['session_id'], 'thr-probe-a');
    assert.equal(report['transcript_path'], hit);
  });

  it('does not count a marker that only appears in tool output', async () => {
    const home = await tempDir('sca-disc-home-');
    const ws = await tempDir('sca-disc-ws-');
    await writeCodexSession(home, 'rollout-a.jsonl', [
      codexMeta('thr-probe-a', ws),
      {
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'c1', output: `${MARKER}\n` },
      },
    ]);

    const cap = capture();
    const code = await runCli(['discover', '--host', 'codex', '--marker', MARKER, '--home', home], cap.io);
    assert.equal(code, 2);
    assert.equal((lastJson(cap.out)['error'] as { code: string }).code, 'session_locator_unavailable');
  });

  it('fails closed when more than one transcript carries the marker', async () => {
    const home = await tempDir('sca-disc-home-');
    const ws = await tempDir('sca-disc-ws-');
    await writeCodexSession(home, 'rollout-a.jsonl', [codexMeta('thr-probe-a', ws), codexCommand(`echo ${MARKER}`)]);
    await writeCodexSession(home, 'rollout-b.jsonl', [codexMeta('thr-probe-b', ws), codexCommand(`echo ${MARKER}`)]);

    const cap = capture();
    const code = await runCli(['discover', '--host', 'codex', '--marker', MARKER, '--home', home], cap.io);
    assert.equal(code, 2);
    assert.equal((lastJson(cap.out)['error'] as { code: string }).code, 'location_conflict');
  });

  it('finds a resumed session still appending inside its original date directory', async () => {
    const home = await tempDir('sca-disc-home-');
    const ws = await tempDir('sca-disc-ws-');
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '20');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-09-20T17-52-46-01a0bde7-34f7-7a11-9b74-65b204a161a5_01a0be3b.jsonl');
    await fs.writeFile(
      file,
      `${[codexMeta('thr-resumed', ws), codexCommand(`echo ${MARKER}`)].map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );

    const cap = capture();
    const code = await runCli(
      ['discover', '--host', 'codex', '--marker', MARKER, '--workspace', ws, '--home', home],
      cap.io,
    );
    assert.equal(code, 0);
    assert.equal(lastJson(cap.out)['transcript_path'], file);
  });

  it('prunes transcripts untouched since the lookback window even when they carry the marker', async () => {
    const home = await tempDir('sca-disc-home-');
    const ws = await tempDir('sca-disc-ws-');
    const stale = await writeCodexSession(home, 'rollout-stale.jsonl', [
      codexMeta('thr-stale', ws),
      codexCommand(`echo ${MARKER}`),
    ]);
    const past = new Date(Date.now() - 3 * 86_400_000);
    await fs.utimes(stale, past, past);

    const cap = capture();
    const code = await runCli(['discover', '--host', 'codex', '--marker', MARKER, '--home', home], cap.io);
    assert.equal(code, 2);
    assert.equal((lastJson(cap.out)['error'] as { code: string }).code, 'session_locator_unavailable');
  });

  it('rejects markers that are not a lowercase uuidv4 probe token', async () => {
    const home = await tempDir('sca-disc-home-');
    const cap = capture();
    const code = await runCli(['discover', '--host', 'codex', '--marker', 'sca-probe-deadbeef', '--home', home], cap.io);
    assert.equal(code, 2);
    assert.equal((lastJson(cap.out)['error'] as { code: string }).code, 'schema_invalid');
  });
});

describe('cli discover (claude)', () => {
  async function claudeProjectDir(home: string, workspace: string): Promise<string> {
    const dir = path.join(home, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  it('derives the project directory from the workspace and returns its session id', async () => {
    const home = await tempDir('sca-disc-home-');
    const ws = await tempDir('sca-disc-ws-');
    const dir = await claudeProjectDir(home, ws);
    await fs.writeFile(
      path.join(dir, 'sess-claude-1.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'u1',
        sessionId: 'sess-claude-1',
        cwd: ws,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `echo ${MARKER}` } }] },
      })}\n`,
      'utf8',
    );

    const cap = capture();
    const code = await runCli(
      ['discover', '--host', 'claude', '--marker', MARKER, '--workspace', ws, '--home', home],
      cap.io,
    );
    assert.equal(code, 0);
    const report = lastJson(cap.out);
    assert.equal(report['session_id'], 'sess-claude-1');
  });

  it('refuses a transcript whose recorded cwd differs from --workspace', async () => {
    const home = await tempDir('sca-disc-home-');
    const ws = await tempDir('sca-disc-ws-');
    const elsewhere = await tempDir('sca-disc-other-');
    const dir = await claudeProjectDir(home, ws);
    await fs.writeFile(
      path.join(dir, 'sess-claude-2.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'u1',
        sessionId: 'sess-claude-2',
        cwd: elsewhere,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `echo ${MARKER}` } }] },
      })}\n`,
      'utf8',
    );

    const cap = capture();
    const code = await runCli(
      ['discover', '--host', 'claude', '--marker', MARKER, '--workspace', ws, '--home', home],
      cap.io,
    );
    assert.equal(code, 2);
    assert.equal((lastJson(cap.out)['error'] as { code: string }).code, 'record_identity_mismatch');
  });

  it('requires --workspace to derive a claude project directory', async () => {
    const home = await tempDir('sca-disc-home-');
    const cap = capture();
    const code = await runCli(['discover', '--host', 'claude', '--marker', MARKER, '--home', home], cap.io);
    assert.equal(code, 2);
    assert.equal((lastJson(cap.out)['error'] as { code: string }).code, 'schema_invalid');
  });
});
