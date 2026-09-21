import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { adaptCodex } from '../../../src/hosts/codex.js';
import { adaptClaude } from '../../../src/hosts/claude.js';

it('preserves function_call arguments and distinguishes Claude result blocks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-parser-regression-'));
  try {
    const codex = path.join(dir, 'codex.jsonl');
    await fs.writeFile(codex, [
      { type: 'session_meta', payload: { id: 'session' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git diff"}', call_id: 'c1' } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    assert.equal((await adaptCodex(codex)).events[0]?.text, '{"cmd":"git diff"}');
    const claude = path.join(dir, 'claude.jsonl');
    await fs.writeFile(claude, JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'session', message: { content: [
      { type: 'tool_result', tool_use_id: 'a', content: 'FIRST' },
      { type: 'tool_result', tool_use_id: 'b', content: 'SECOND' },
      { type: 'text', text: 'one' }, { type: 'text', text: 'two' },
    ] } }) + '\n');
    const events = (await adaptClaude(claude)).events;
    assert.equal(new Set(events.map((event) => event.id)).size, 4);
    assert.deepEqual(events.slice(0, 2).map((event) => event.call_id), ['a', 'b']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
