import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ScaError } from '../domain/errors.js';
import type { Sha256Hash } from '../domain/hash.js';

export const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

export interface FrozenSource {
  source_encoding: 'zstd';
  source_fingerprint: Sha256Hash;
  source_bytes: number;
  decoded_fingerprint: Sha256Hash;
  decoded_byte_length: number;
}

async function* bounded(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.length;
    if (bytes > TRANSCRIPT_MAX_BYTES) throw new ScaError('payload_too_large', 'compressed and decoded transcripts each have a 64 MiB limit');
    yield chunk;
  }
}

async function fingerprint(file: string): Promise<{ hash: Sha256Hash; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of bounded(createReadStream(file))) { hash.update(chunk); bytes += chunk.length; }
  return { hash: `sha256:${hash.digest('hex')}`, bytes };
}

async function decompress(source: string, target: string): Promise<void> {
  const child = spawn('zstd', ['-q', '-d', '-c', '--', source], { stdio: ['ignore', 'pipe', 'ignore'] });
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new ScaError('transcript_unreadable', 'DSH compressed input requires zstd on PATH')));
    child.once('close', code => code === 0 ? resolve() : reject(new ScaError('transcript_unreadable', 'zstd could not decode the complete transcript')));
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
  const decoded = pipeline(child.stdout, bounded, createWriteStream(target, { mode: 0o600 }));
  try {
    await Promise.all([decoded, completed]);
  } catch (error) {
    child.kill('SIGKILL');
    child.stdout.destroy();
    await Promise.allSettled([decoded, completed]);
    if (error instanceof ScaError) throw error;
    throw new ScaError('transcript_unreadable', 'compressed transcript decoding failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Physical bytes and decoded lines have different coordinate systems. */
export async function withFrozenTranscript<T>(file: string, consume: (decodedPath: string, source?: FrozenSource) => Promise<T>): Promise<T> {
  if (!file.endsWith('.zstd')) return consume(file);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-transcript-'));
  try {
    const raw = path.join(dir, 'source.zstd');
    const decoded = path.join(dir, path.basename(file, '.zstd'));
    await pipeline(createReadStream(file), bounded, createWriteStream(raw, { mode: 0o600 }));
    const frozen = await fingerprint(raw);
    const current = await fingerprint(file);
    if (current.hash !== frozen.hash || current.bytes !== frozen.bytes) {
      throw new ScaError('coverage_incomplete', 'compressed source changed while freezing; retry with a stable source');
    }
    await decompress(raw, decoded);
    const content = await fingerprint(decoded);
    return await consume(decoded, { source_encoding: 'zstd', source_fingerprint: frozen.hash, source_bytes: frozen.bytes,
      decoded_fingerprint: content.hash, decoded_byte_length: content.bytes });
  } catch (error) {
    if (error instanceof ScaError) throw error;
    throw new ScaError('transcript_unreadable', 'could not freeze the compressed transcript');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
