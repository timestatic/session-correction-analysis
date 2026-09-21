import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { withSessionLock, withAdvisoryLock } from '../../../src/store/lock.js';
import { atomicWriteText } from '../../../src/store/atomic.js';
import { RecordRepository } from '../../../src/store/repository.js';
import { sessionLockTarget } from '../../../src/store/paths.js';

it('refuses atomic replacement immediately after a held lock directory disappears', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-lock-guard-'));
  try {
    const repo = new RecordRepository(root);
    const id = 'a'.repeat(64);
    await fs.writeFile(path.join(root, 'result.md'), 'original');
    await assert.rejects(withSessionLock(repo.paths, id, async () => {
      await fs.rmdir(`${sessionLockTarget(repo.paths, id)}.lock`);
      await atomicWriteText(root, 'result.md', 'must not write');
    }), /lock/i);
    assert.equal(await fs.readFile(path.join(root, 'result.md'), 'utf8'), 'original');
    assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('.tmp-')).length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('retains the outer session guard while a nested target lock is held', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-nested-guard-'));
  try {
    const repo = new RecordRepository(root);
    const id = 'b'.repeat(64);
    await assert.rejects(withSessionLock(repo.paths, id, async () => withAdvisoryLock(repo.paths, 'target-test', async () => {
      await fs.rmdir(`${sessionLockTarget(repo.paths, id)}.lock`);
      await atomicWriteText(root, 'result.md', 'must not write');
    })), /lock/i);
    await assert.rejects(fs.access(path.join(root, 'result.md')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('never removes a successor lock while releasing the old owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-successor-guard-'));
  try {
    const repo = new RecordRepository(root);
    const id = 'c'.repeat(64);
    const lockDir = `${sessionLockTarget(repo.paths, id)}.lock`;
    await assert.rejects(withSessionLock(repo.paths, id, async () => {
      await fs.rename(lockDir, path.join(root, 'retired-lock'));
      await fs.mkdir(lockDir);
      await atomicWriteText(root, 'result.md', 'must not write');
    }), /lock/i);
    assert.ok((await fs.stat(lockDir)).isDirectory());
    await assert.rejects(fs.access(path.join(root, 'result.md')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
