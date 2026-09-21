import { createReadStream } from 'node:fs';
import { ScaError } from '../domain/errors.js';

export function assertTextBudget(text: string, maxBytes: number): void {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ScaError('payload_too_large', `input exceeds ${String(maxBytes)} bytes`);
}

/** Bound while reading, not after an unbounded readFile/Buffer.concat. */
export async function readBoundedText(stream: AsyncIterable<Uint8Array | string>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new ScaError('payload_too_large', `input exceeds ${String(maxBytes)} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

export function readBoundedFile(filePath: string, maxBytes: number): Promise<string> {
  return readBoundedText(createReadStream(filePath), maxBytes);
}
