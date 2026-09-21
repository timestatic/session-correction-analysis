import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { sha256Tag, type Sha256Hash } from '../domain/hash.js';
import { assertActiveLocksOwned } from './lock.js';

export interface WriteResult {
  fileHash: Sha256Hash;
  bytes: number;
}

/**
 * Same-directory temp file, fsync, atomic rename, directory fsync (design 10.4).
 * Pre-rename failures leave the previous content untouched and clean the temp.
 * Errors after rename require caller reconciliation; they cannot be rolled back here.
 */
export async function atomicWriteText(dirPath: string, fileName: string, text: string): Promise<WriteResult> {
  const target = path.join(dirPath, fileName);
  const tmp = path.join(dirPath, `.tmp-${fileName}-${crypto.randomBytes(8).toString('hex')}`);
  let handle;
  try {
    assertActiveLocksOwned();
    handle = await fs.open(tmp, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertActiveLocksOwned();
    await fs.rename(tmp, target);
    await fsyncDir(dirPath);
  } finally {
    await handle?.close();
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  return { fileHash: sha256Tag(text), bytes: Buffer.byteLength(text, 'utf8') };
}

async function fsyncDir(dirPath: string): Promise<void> {
  const handle = await fs.open(dirPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function sha256File(filePath: string): Promise<Sha256Hash> {
  return sha256Tag(await fs.readFile(filePath, 'utf8'));
}
