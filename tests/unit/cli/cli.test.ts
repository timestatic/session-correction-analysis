import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';

import type { CliIo } from '../../../src/cli.js';
import { runCli } from '../../../src/cli.js';
import { computeRecordId } from '../../../src/domain/ids.js';
import { canonicalWorkspace } from '../../../src/store/paths.js';

const execFileAsync = promisify(execFile);
const REPO = path.join(import.meta.dirname, '../../../..');
const CLI_ENTRY = path.join(REPO, 'dist', 'src', 'cli.js');
const CODEX_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'codex', 'basic.jsonl');
const UNKNOWN_FIXTURE_DIR = path.join(REPO, 'tests', 'fixtures', 'unknown');

interface IoCapture {
  io: CliIo;
  out: string[];
  err: string[];
}

function makeIo(env: Record<string, string | undefined> = {}): IoCapture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { env, stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    out,
    err,
  };
}

function lastJson(out: string[]): Record<string, unknown> {
  const last = out[out.length - 1];
  assert.ok(last !== undefined, 'expected CLI stdout output');
  return JSON.parse(last) as Record<string, unknown>;
}

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

function registerArgs(root: string, session: string, workspace: string, transcript: string): string[] {
  return [
    'register',
    '--data-root',
    root,
    '--host',
    'codex',
    '--session',
    session,
    '--workspace',
    workspace,
    '--transcript',
    transcript,
  ];
}

describe('cli doctor', () => {
  it('reports a writable data root and passes on the pinned node', async () => {
    const root = await tempDir('sca-doctor-');
    const cap = makeIo();
    const code = await runCli(['doctor', '--data-root', root], cap.io);
    assert.equal(code, 0);
    const report = lastJson(cap.out);
    assert.equal(report['ok'], true);
    const checks = report['checks'] as { name: string; status: string }[];
    assert.ok(checks.some((c) => c.name === 'data_root' && c.status === 'ok'));
    assert.ok(checks.some((c) => c.name === 'node_version' && c.status === 'ok'));
    await fs.access(path.join(root, 'records'));
  });

  it('fails the data root check when the root cannot be written', async () => {
    const blocker = await tempDir('sca-doctor-blocked-');
    const inTheWay = path.join(blocker, 'in-the-way');
    await fs.writeFile(inTheWay, 'a file where a directory is needed', 'utf8');
    const cap = makeIo();
    const code = await runCli(['doctor', '--data-root', path.join(inTheWay, 'nested')], cap.io);
    assert.equal(code, 1);
    const report = lastJson(cap.out);
    assert.equal(report['ok'], false);
  });
});

describe('cli register', () => {
  it('creates the record skeleton once and is idempotent on re-register', async () => {
    const root = await tempDir('sca-cli-reg-');
    const ws = '/repo/dpp_v3';
    const first = makeIo();
    const code = await runCli(registerArgs(root, 'thr_fixture_1', ws, CODEX_FIXTURE), first.io);
    assert.equal(code, 0);
    const created = lastJson(first.out);
    assert.equal(created['created'], true);
    const recordId = created['record_id'] as string;
    assert.equal(recordId, computeRecordId('codex', await canonicalWorkspace(ws), 'thr_fixture_1'));
    await fs.access(path.join(root, 'records', recordId, 'analyze.md'));
    await fs.access(path.join(root, 'records', recordId, 'learning_candidates.md'));

    const second = makeIo();
    const code2 = await runCli(
      [...(registerArgs(root, 'thr_fixture_1', ws, CODEX_FIXTURE)), '--title', 'renamed'],
      second.io,
    );
    assert.equal(code2, 0);
    const again = lastJson(second.out);
    assert.equal(again['created'], false);
    assert.equal(again['record_id'], recordId);
  });

  it('refuses a missing transcript before touching the records tree', async () => {
    const root = await tempDir('sca-cli-missing-');
    const ws = await tempDir('sca-cli-ws-');
    const cap = makeIo();
    const code = await runCli(
      registerArgs(root, 'cli-session-2', ws, path.join(root, 'nope.jsonl')),
      cap.io,
    );
    assert.equal(code, 2);
    const report = lastJson(cap.out) as { error: { code: string } };
    assert.equal(report.error.code, 'transcript_unreadable');
    await assert.rejects(fs.access(path.join(root, 'records')));
  });

  it('fails closed on unknown transcript formats', async () => {
    const root = await tempDir('sca-cli-unknown-');
    const ws = await tempDir('sca-cli-ws-');
    const entries = await fs.readdir(UNKNOWN_FIXTURE_DIR);
    const sample = path.join(UNKNOWN_FIXTURE_DIR, entries[0]!);
    const cap = makeIo();
    const code = await runCli(registerArgs(root, 'cli-session-3', ws, sample), cap.io);
    assert.equal(code, 2);
    const report = lastJson(cap.out) as { error: { code: string } };
    assert.equal(report.error.code, 'unsupported_transcript');
  });

  it('honours SCA_DATA_ROOT when no flag is given', async () => {
    const root = await tempDir('sca-cli-env-');
    const ws = '/repo/dpp_v3';
    const cap = makeIo({ SCA_DATA_ROOT: root });
    const code = await runCli(
      ['register', '--host', 'codex', '--session', 'thr_fixture_1', '--workspace', ws, '--transcript', CODEX_FIXTURE],
      cap.io,
    );
    assert.equal(code, 0);
    const recordId = (lastJson(cap.out) as { record_id: string }).record_id;
    await fs.access(path.join(root, 'records', recordId, 'analyze.md'));
  });
});

describe('cli validate', () => {
  async function registeredRecord(): Promise<{ root: string; recordId: string }> {
    const root = await tempDir('sca-cli-val-');
    const ws = '/repo/dpp_v3';
    const cap = makeIo();
    const code = await runCli(registerArgs(root, 'thr_fixture_1', ws, CODEX_FIXTURE), cap.io);
    assert.equal(code, 0);
    return { root, recordId: (lastJson(cap.out) as { record_id: string }).record_id };
  }

  it('accepts freshly registered records by id and via --all', async () => {
    const { root, recordId } = await registeredRecord();
    const byId = makeIo();
    assert.equal(await runCli(['validate', '--data-root', root, recordId], byId.io), 0);
    assert.equal((lastJson(byId.out) as { invalid: number }).invalid, 0);

    const all = makeIo();
    assert.equal(await runCli(['validate', '--data-root', root, '--all'], all.io), 0);
    assert.equal((lastJson(all.out) as { checked: number }).checked, 1);
  });

  it('reports hand-edited derived counters as invalid without rewriting the file', async () => {
    const { root, recordId } = await registeredRecord();
    const candidatesPath = path.join(root, 'records', recordId, 'learning_candidates.md');
    const before = await fs.readFile(candidatesPath, 'utf8');
    await fs.writeFile(candidatesPath, before.replace('candidate_count: 0', 'candidate_count: 9'), 'utf8');
    const cap = makeIo();
    const code = await runCli(['validate', '--data-root', root, recordId], cap.io);
    assert.equal(code, 1);
    const report = lastJson(cap.out) as {
      reports: { candidates: { status: string; code?: string } }[];
    };
    assert.equal(report.reports[0]?.candidates.status, 'invalid');
    assert.equal(report.reports[0]?.candidates.code, 'schema_invalid');
    assert.equal(await fs.readFile(candidatesPath, 'utf8'), before.replace('candidate_count: 0', 'candidate_count: 9'));
  });

  it('detects identity tampering and duplicated User Notes sections', async () => {
    const { root, recordId } = await registeredRecord();
    const analyzePath = path.join(root, 'records', recordId, 'analyze.md');
    const before = await fs.readFile(analyzePath, 'utf8');
    await fs.writeFile(analyzePath, `${before}\n## User Notes\n\nsecond one\n`, 'utf8');
    const notes = makeIo();
    assert.equal(await runCli(['validate', '--data-root', root, recordId], notes.io), 1);
    const notesReport = lastJson(notes.out) as { reports: { analyze: { code?: string } }[] };
    assert.equal(notesReport.reports[0]?.analyze.code, 'schema_invalid');

    await fs.writeFile(analyzePath, before.replace(/^session_id:.*$/m, 'session_id: forged-999'), 'utf8');
    const tampered = makeIo();
    assert.equal(await runCli(['validate', '--data-root', root, recordId], tampered.io), 1);
    const tamperedReport = lastJson(tampered.out) as { reports: { analyze: { code?: string } }[] };
    assert.equal(tamperedReport.reports[0]?.analyze.code, 'record_identity_mismatch');
  });

  it('rejects invocations without a record id or --all', async () => {
    const root = await tempDir('sca-cli-usage-');
    const cap = makeIo();
    assert.equal(await runCli(['validate', '--data-root', root], cap.io), 2);
    assert.equal((lastJson(cap.out) as { error: { code: string } }).error.code, 'schema_invalid');
  });
});

describe('cli process smoke', () => {
  it('runs as a real node process: doctor, unknown command, help exit codes', async () => {
    const root = await tempDir('sca-cli-proc-');
    const ok = await execFileAsync(process.execPath, [CLI_ENTRY, 'doctor', '--data-root', root]);
    const report = JSON.parse(ok.stdout) as { ok: boolean };
    assert.equal(report.ok, true);

    await assert.rejects(execFileAsync(process.execPath, [CLI_ENTRY, 'frobnicate']), (err: unknown) => {
      const e = err as { code?: number; stderr?: string };
      assert.equal(e.code, 3);
      assert.ok(e.stderr?.includes('sca <command>'));
      return true;
    });
  });
});
