import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { sha256Tag } from '../../../src/domain/hash.js';
import { atomicWriteText, sha256File } from '../../../src/store/atomic.js';
import { resolvePaths } from '../../../src/store/paths.js';
import { acquireSessionLock, withSessionLock } from '../../../src/store/lock.js';

const RECORD_A = 'a'.repeat(64);
const RECORD_B = 'b'.repeat(64);

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sca-store-'));
}

describe('atomic single-file writes', () => {
  it('writes content with matching hash and leaves no temp files behind', async () => {
    const dir = await tmpDir();
    const text = '---\nschema: x\n---\n\n正文\n';
    const result = await atomicWriteText(dir, 'analyze.md', text);
    assert.equal(result.fileHash, sha256Tag(text));
    assert.equal(await fsp.readFile(path.join(dir, 'analyze.md'), 'utf8'), text);
    assert.equal(await sha256File(path.join(dir, 'analyze.md')), sha256Tag(text));
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  it('overwrites in place without touching other files', async () => {
    const dir = await tmpDir();
    await fsp.writeFile(path.join(dir, 'keep.md'), 'keep');
    await atomicWriteText(dir, 'analyze.md', 'v1');
    await atomicWriteText(dir, 'analyze.md', 'v2');
    assert.equal(await fsp.readFile(path.join(dir, 'analyze.md'), 'utf8'), 'v2');
    assert.equal(await fsp.readFile(path.join(dir, 'keep.md'), 'utf8'), 'keep');
  });

  it('fails loudly when the directory does not exist', async () => {
    const dir = path.join(await tmpDir(), 'missing');
    await assert.rejects(() => atomicWriteText(dir, 'analyze.md', 'x'));
  });
});

describe('session locks', () => {
  it('serializes two acquirers of the same record', async () => {
    const root = await tmpDir();
    const paths = resolvePaths(root);
    const order: string[] = [];
    const first = await acquireSessionLock(paths, RECORD_A);
    const second = withSessionLock(paths, RECORD_A, () => {
      order.push('second-in');
      return 2;
    });
    order.push('first-hold');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    await first.release();
    await second;
    assert.deepEqual(order, ['first-hold', 'second-in']);
    assert.equal(first.compromised(), false);
  });

  it('allows different records to lock concurrently', async () => {
    const root = await tmpDir();
    const paths = resolvePaths(root);
    const [a, b] = await Promise.all([acquireSessionLock(paths, RECORD_A), acquireSessionLock(paths, RECORD_B)]);
    await a.release();
    await b.release();
  });

  it('releases after the context exits even on failure', async () => {
    const root = await tmpDir();
    const paths = resolvePaths(root);
    await assert.rejects(() =>
      withSessionLock(paths, RECORD_A, () => {
        throw new Error('boom');
      }),
    );
    const handle = await acquireSessionLock(paths, RECORD_A);
    await handle.release();
  });

  it('rejects unsafe record ids before touching the filesystem', async () => {
    const root = await tmpDir();
    const paths = resolvePaths(root);
    await assert.rejects(() => acquireSessionLock(paths, '../../escape'));
  });
});
