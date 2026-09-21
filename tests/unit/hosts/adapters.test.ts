import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { eventSchema } from '../../../src/domain/events.js';
import { adaptClaude, adaptCodex, adaptNormalized, adaptTranscript, detectFormat } from '../../../src/hosts/index.js';
import { ScaError } from '../../../src/domain/errors.js';

const REPO = path.join(import.meta.dirname, '../../../..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');

function fixture(...parts: string[]): string {
  return path.join(FIXTURES, ...parts);
}

describe('codex adapter', () => {
  it('deduplicates verified mirrors, links call ids and validates every event', async () => {
    const t = await adaptCodex(fixture('codex', 'basic.jsonl'));
    assert.equal(t.host, 'codex');
    assert.equal(t.source_session_id, 'thr_fixture_1');
    assert.equal(t.workspace, '/repo/dpp_v3');
    assert.equal(t.coverage, 'full');
    assert.deepEqual(
      t.events.map((e) => e.kind),
      ['user_message', 'tool_call', 'tool_result', 'assistant_message'],
    );
    assert.equal(t.stats.mirrors_merged, 1);
    assert.equal(t.stats.total_lines, 11);
    assert.ok(t.stats.ignored_records['function_call_placeholder'] === 1);
    assert.ok(t.stats.ignored_records['response_item:reasoning'] === 1);
    assert.ok(t.stats.ignored_records['event_msg:token_count'] === 1);
    const call = t.events.find((e) => e.kind === 'tool_call');
    const result = t.events.find((e) => e.kind === 'tool_result');
    assert.equal(call?.call_id, result?.call_id);
    for (const e of t.events) {
      assert.equal(eventSchema.safeParse(e).success, true, JSON.stringify(eventSchema.safeParse(e).error?.issues));
    }
  });

  it('accepts out-of-order call results without fabricating or dropping them', async () => {
    const t = await adaptCodex(fixture('codex', 'call-result-reordered.jsonl'));
    assert.equal(t.events[0]?.kind, 'tool_result');
    assert.equal(t.events[1]?.kind, 'tool_call');
    assert.equal(t.events[0]?.call_id, 'call_9');
    assert.equal(t.events[1]?.call_id, 'call_9');
  });

  it('classifies the trailing half line as tail_incomplete with partial coverage', async () => {
    const t = await adaptCodex(fixture('codex', 'tail-half-line.jsonl'));
    assert.equal(t.stats.tail_incomplete, true);
    assert.equal(t.stats.bad_lines, 0);
    assert.equal(t.coverage, 'partial');
  });

  it('marks mid-file corruption as partial coverage', async () => {
    const t = await adaptCodex(fixture('codex', 'middle-broken-line.jsonl'));
    assert.equal(t.stats.bad_lines, 1);
    assert.equal(t.coverage, 'partial');
    assert.equal(t.events.filter((e) => e.kind === 'user_message').length, 1);
  });

  it('handles CRLF line endings', async () => {
    const tmp = path.join(os.tmpdir(), `sca-crlf-${Date.now()}.jsonl`);
    const content = fs.readFileSync(fixture('codex', 'basic.jsonl'), 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(tmp, content);
    try {
      const t = await adaptCodex(tmp);
      assert.equal(t.stats.total_lines, 11);
      assert.equal(t.stats.bad_lines, 0);
    } finally {
      fs.rmSync(tmp);
    }
  });

  it('parses the local real Codex transcript (Chinese text preserved)', { skip: !fs.existsSync(path.join(REPO, 'test-data')) }, async () => {
    const file = path.join(
      REPO,
      'test-data/01a09e95-cadf-75a1-9a84-15cc4bd8129f/transcript.sanitized.jsonl',
    );
    const t = await adaptCodex(file);
    assert.equal(t.source_session_id, '01a09e95-cadf-75a1-9a84-15cc4bd8129f');
    const userMessages = t.events.filter((e) => e.kind === 'user_message');
    assert.ok(userMessages.length >= 5);
    assert.ok(
      userMessages.some((e) => /[\u4e00-\u9fff]/.test(e.text ?? '')),
      'Chinese user feedback must survive parsing',
    );
    assert.ok(t.stats.mirrors_merged > 0, 'real transcripts contain mirrors');
  });
});

describe('claude adapter', () => {
  it('maps tool_use/tool_result pairs and skips metadata lines', async () => {
    const t = await adaptClaude(fixture('claude', 'basic.jsonl'));
    assert.equal(t.host, 'claude');
    assert.equal(t.source_session_id, 'claude_fixture_1');
    assert.deepEqual(
      t.events.map((e) => e.kind),
      ['user_message', 'tool_call', 'tool_result', 'assistant_message'],
    );
    assert.equal(t.events[1]?.call_id, 'tu1');
    assert.equal(t.events[2]?.call_id, 'tu1');
    assert.equal(t.stats.ignored_records['mode'], 1);
    assert.equal(t.stats.ignored_records['last-prompt'], 1);
  });

  it('parses the local real Claude transcript', { skip: !fs.existsSync(path.join(REPO, 'test-data')) }, async () => {
    const t = await adaptClaude(path.join(REPO, 'test-data/04e2a3f2-e71a-4cfa-9388-74e4ffb3f4a0/transcript.sanitized.jsonl'));
    assert.equal(t.source_session_id, '04e2a3f2-e71a-4cfa-9388-74e4ffb3f4a0');
    assert.ok(t.events.length > 20);
    assert.ok(t.events.every((e) => eventSchema.safeParse(e).success));
  });
});

describe('normalized adapter', () => {
  it('imports the draft envelope and keeps declared order', async () => {
    const t = await adaptNormalized(fixture('normalized', 'basic.jsonl'));
    assert.equal(t.host, 'codex');
    assert.equal(t.source_session_id, 'norm_1');
    assert.equal(t.title, '规范化导入示例');
    assert.deepEqual(t.events.map((e) => e.kind), ['user_message', 'assistant_message', 'file_edit', 'tool_result']);
  });

  it('refuses to guess an identity from arbitrary jsonl', async () => {
    await assert.rejects(
      () => detectFormat(fixture('unknown', 'random-jsonl.jsonl')),
      (err: unknown) => err instanceof ScaError && err.code === 'unsupported_transcript',
    );
  });
});

describe('format detection through adaptTranscript', () => {
  it('routes each fixture family to its adapter', async () => {
    assert.equal((await adaptTranscript(fixture('codex', 'basic.jsonl'))).host, 'codex');
    assert.equal((await adaptTranscript(fixture('claude', 'basic.jsonl'))).host, 'claude');
    assert.equal((await adaptTranscript(fixture('normalized', 'basic.jsonl'))).host, 'codex');
  });
});
