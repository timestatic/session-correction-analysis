import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { sha256Tag } from '../../src/domain/hash.js';
import { reconcileReceipts, receiptsDir } from '../../src/publish/receipt.js';
import { scenario, tempDirs, type Scenario } from '../unit/publish/fixtures.js';

/**
 * T14 real-process crash matrix: a genuine child process SIGKILLs itself at
 * each durable publication boundary — before the target write, right after
 * it, and after the state commit — and the parent recovers from disk only.
 * No same-process exception stands in for these cases.
 */

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CHILD = path.join(REPO_ROOT, 'dist', 'tests', 'integration', 'publish_crash_child.js');

after(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function runChild(sc: Scenario, mode: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [CHILD, mode, sc.recordId, 'learning-001', sc.preview.preview.preview_id, String(sc.revision)],
    { env: { ...process.env, SCA_DATA_ROOT: sc.root }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const exit = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
  return { code: exit ?? -1, stdout, stderr };
}

async function runOk(sc: Scenario, mode: string): Promise<number> {
  const { code, stderr, stdout } = await runChild(sc, mode);
  if (code !== 0) {
    throw new Error(`child ${mode} exited ${code}: ${(stderr + stdout).slice(0, 500)}`);
  }
  return code;
}

async function receiptFiles(sc: Scenario): Promise<string[]> {
  const entries = await fs.readdir(receiptsDir(sc.repo.paths)).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith('.json'));
}

async function awaitReceipt(sc: Scenario): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if ((await receiptFiles(sc)).length === 1) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('no durable receipt appeared');
    }
    await sleep(20);
  }
}

async function awaitTargetHash(file: string, want: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (sha256Tag(await fs.readFile(file, 'utf8').catch(() => '')) === want) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('target never reached the expected hash');
    }
    await sleep(20);
  }
}

/**
 * The killed holder is verifiably dead (its exit was awaited), so its lock
 * directories are removed instead of waiting out the 30s stale window.
 */
async function releaseDeadLocks(sc: Scenario): Promise<void> {
  await fs.rm(sc.repo.paths.locksDir, { recursive: true, force: true }).catch(() => undefined);
}

async function doc(sc: Scenario) {
  return (await sc.repo.loadCandidates(sc.recordId)).doc;
}

describe('publish crash recovery with real processes (design 15 step 8)', () => {
  it('kill before the target write: nothing landed, reconcile reports retry, publish then succeeds', async () => {
    const sc = await scenario('crash-it-before');
    const beforeHash = sha256Tag(await fs.readFile(sc.agents, 'utf8'));
    assert.equal((await runChild(sc, 'before_target')).code, -1, 'SIGKILL leaves no exit code');
    await releaseDeadLocks(sc);

    assert.equal(sha256Tag(await fs.readFile(sc.agents, 'utf8')), beforeHash);
    assert.equal((await doc(sc)).candidates[0]?.status, 'approved');
    assert.equal((await receiptFiles(sc)).length, 1);

    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.outcome, 'retryable');
    assert.equal((await receiptFiles(sc)).length, 0);
    assert.equal((await doc(sc)).revision, sc.revision);

    await runOk(sc, 'publish-cli');
    const after = await doc(sc);
    assert.equal(after.candidates[0]?.status, 'published');
    assert.equal(
      (await fs.readFile(sc.agents, 'utf8')).split('### candidate learning-001').length - 1,
      1,
      'the retry must not double-insert the rule',
    );
  });

  it('kill right after the target write: reconcile converges to published without rewriting the file', async () => {
    const sc = await scenario('crash-it-after');
    const landed = awaitReceipt(sc);
    const killed = await runChild(sc, 'after_target');
    assert.equal(killed.code, -1);
    await landed;
    await awaitTargetHash(sc.agents, sc.preview.preview.hash_after);
    await releaseDeadLocks(sc);

    assert.equal(sha256Tag(await fs.readFile(sc.agents, 'utf8')), sc.preview.preview.hash_after);
    assert.equal((await doc(sc)).candidates[0]?.status, 'approved', 'the child never got to write state');

    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports[0]?.outcome, 'converged');
    assert.equal(sha256Tag(await fs.readFile(sc.agents, 'utf8')), sc.preview.preview.hash_after);
    const after = await doc(sc);
    assert.equal(after.candidates[0]?.status, 'published');
    assert.equal(after.candidates[0]?.publication.published, true);
    assert.equal(after.revision, sc.revision + 1);
    assert.equal((await receiptFiles(sc)).length, 0);

    // Repeating the publish afterwards replays the receipt instead of writing again.
    await runOk(sc, 'publish-cli');
    assert.equal((await doc(sc)).revision, after.revision);
    assert.equal((await fs.readFile(sc.agents, 'utf8')).split('### candidate learning-001').length - 1, 1);
  });

  it('self-kill after the state commit: the leftover receipt clears with zero state churn', async () => {
    const sc = await scenario('crash-it-residue');
    assert.equal((await runChild(sc, 'after_state')).code, -1);
    await releaseDeadLocks(sc);

    const committed = await doc(sc);
    assert.equal(committed.candidates[0]?.status, 'published');
    assert.equal(committed.revision, sc.revision + 1);
    assert.equal((await receiptFiles(sc)).length, 1, 'cleanup died, so the receipt is residue');

    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports[0]?.outcome, 'residue_cleared');
    assert.equal((await doc(sc)).revision, committed.revision, 'residue cleanup must not bump revision');
    assert.equal((await receiptFiles(sc)).length, 0);
  });

  it('external target edit during the crash window survives reconcile and kills the stale preview', async () => {
    const sc = await scenario('crash-it-moved');
    const landed = awaitReceipt(sc);
    assert.equal((await runChild(sc, 'before_target')).code, -1);
    await landed;
    await releaseDeadLocks(sc);
    await fs.writeFile(sc.agents, '# 外部在崩溃窗口改写了目标\n', 'utf8');

    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports[0]?.outcome, 'retryable');
    assert.equal(await fs.readFile(sc.agents, 'utf8'), '# 外部在崩溃窗口改写了目标\n');

    // The pre-crash preview is now stale and must fail closed, never overwrite.
    const stale = await runChild(sc, 'publish-cli');
    assert.equal(stale.code, 2);
    assert.match(stale.stdout + stale.stderr, /target_changed/);
    assert.equal(await fs.readFile(sc.agents, 'utf8'), '# 外部在崩溃窗口改写了目标\n');
  });
});
