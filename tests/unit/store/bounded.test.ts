import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { it } from 'node:test';
import { readBoundedText } from '../../../src/store/bounded.js';

it('counts UTF-8 bytes exactly and cancels a stream when the budget is exceeded', async () => {
  const text = '汉字';
  const bytes = Buffer.from(text);
  assert.equal(await readBoundedText(Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]), 6), text);
  const stream = Readable.from([bytes]);
  await assert.rejects(readBoundedText(stream, 5), /exceeds/);
  assert.equal(stream.destroyed, true);
});
