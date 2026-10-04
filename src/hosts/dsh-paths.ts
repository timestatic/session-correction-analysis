import fs from 'node:fs/promises';
import path from 'node:path';

import { ScaError } from '../domain/errors.js';

/** Explicit files select an exact snapshot; directories select the highest generation. */
export async function resolveDshTranscript(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (stat?.isFile()) return resolved;
  if (!stat?.isDirectory()) throw new ScaError('transcript_unreadable', 'DSH source must be a file or one explicit session directory');
  const generations = (await fs.readdir(resolved, { withFileTypes: true })).flatMap(entry => {
    if (!entry.isFile()) return [];
    const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(entry.name);
    if (match === null) return [];
    const version = Number(match[1] ?? 0);
    if (!Number.isSafeInteger(version)) throw new ScaError('unsupported_transcript', 'DSH generation number is out of range');
    return [{ file: path.join(resolved, entry.name), version }];
  }).sort((a, b) => b.version - a.version);
  const highest = generations[0];
  if (highest === undefined) throw new ScaError('transcript_unreadable', 'DSH session directory contains no canonical transcript');
  if (generations[1]?.version === highest.version) throw new ScaError('location_conflict', 'DSH highest generation has multiple encodings; select one file explicitly');
  return highest.file;
}
