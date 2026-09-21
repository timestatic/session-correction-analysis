import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export interface JsonlLine {
  line: number;
  raw: string;
  value: unknown;
  malformed: boolean;
  isLast: boolean;
}

export async function endsWithNewline(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return true;
    }
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/** Streams a JSONL file line by line without loading it whole; malformed lines are reported, never dropped silently. */
export async function* readJsonl(filePath: string): AsyncGenerator<JsonlLine> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let previous: JsonlLine | null = null;
  let lineNumber = 0;
  for await (const raw of rl) {
    lineNumber += 1;
    if (raw.trim() === '') {
      continue;
    }
    let value: unknown = null;
    let malformed = false;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      malformed = true;
    }
    if (previous !== null) {
      yield previous;
    }
    previous = { line: lineNumber, raw, value, malformed, isLast: false };
  }
  if (previous !== null) {
    yield { ...previous, isLast: true };
  }
}
