import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { eventSchema } from '../../../src/domain/events.js';
import { adaptClaude, adaptCodex, adaptNormalized, adaptTranscript, detectFormat } from '../../../src/hosts/index.js';
import { ScaError } from '../../../src/domain/errors.js';
import { buildPacket } from '../../../src/analysis/prepare.js';

const REPO = path.join(import.meta.dirname, '../../../..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');

function fixture(...parts: string[]): string {
  return path.join(FIXTURES, ...parts);
}

describe('codex adapter', () => {
  it('recognizes a standalone apply_patch wrapped in exec and keeps shell mentions as tool calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sca-codex-wrapper-'));
    try {
      const file = path.join(dir, 'rollout.jsonl');
      const patch = (replacement: string): string => `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+${replacement}\n*** End Patch`;
      const call = (id: string, input: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', id, call_id: id, name: 'exec', input } });
      const result = (id: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: 'Script completed' } });
      const rows = [
        { type: 'session_meta', payload: { id: 'wrapped', cwd: '/repo/test' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '修改文件' }] } },
        call('patch-before', `text(await tools.apply_patch(${JSON.stringify(patch('first'))}));`), result('patch-before'),
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '方向不对，请改回' }] } },
        call('patch-after', `text(await tools.apply_patch(${JSON.stringify(patch('second'))}));`), result('patch-after'),
        call('patch-then-check', `text(await tools.apply_patch(${JSON.stringify(patch('third'))}));\ntext(await tools.exec_command({cmd:"git status --short"}));`), result('patch-then-check'),
        call('mention', 'text(await tools.exec_command({cmd:"echo tools.apply_patch"}));'), result('mention'),
      ];
      fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const transcript = await adaptCodex(file);
      assert.deepEqual(transcript.events.filter((event) => event.kind === 'file_edit').map((event) => event.call_id), ['patch-before', 'patch-after', 'patch-then-check']);
      assert.equal(transcript.events.find((event) => event.call_id === 'mention')?.kind, 'tool_call');
      const packet = await buildPacket({ recordId: 'a'.repeat(64), runId: 'run-wrapped', analysisId: 'analysis-wrapped', transcriptPath: file, ruleVersion: 'test' });
      assert.equal(packet.edit_signals?.filter((signal) => signal.role === 'change' && signal.success === true).length, 3);
      assert.deepEqual(packet.rework_hints?.[0]?.paths, ['src/a.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('recognizes apply_patch bound to a variable as an escaped JSON string literal (real Codex shape)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sca-codex-var-'));
    try {
      const file = path.join(dir, 'rollout.jsonl');
      const call = (id: string, input: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', id, call_id: id, name: 'exec', input } });
      const result = (id: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: 'Script completed' } });
      // Mirror the rollout: the patch is a JSON string literal (escaped \n) bound to `patch`, then apply_patch(patch).
      const snippet = (target: string, body: string): string => {
        const literal = JSON.stringify(`*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+${body}\n*** End Patch`);
        return `const patch = ${literal};\ntext(await tools.apply_patch(patch));`;
      };
      const rows = [
        { type: 'session_meta', payload: { id: 'varform', cwd: '/repo/test' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '改这个文件' }] } },
        call('before', snippet('src/b.ts', 'first')), result('before'),
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '方向不对，改回去' }] } },
        call('after', snippet('src/b.ts', 'second')), result('after'),
        call('mention', 'text(await tools.exec_command({cmd:"echo tools.apply_patch"}));'), result('mention'),
      ];
      fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const transcript = await adaptCodex(file);
      assert.deepEqual(transcript.events.filter((event) => event.kind === 'file_edit').map((event) => event.call_id), ['before', 'after']);
      assert.equal(transcript.events.find((event) => event.call_id === 'mention')?.kind, 'tool_call');
      const packet = await buildPacket({ recordId: 'a'.repeat(64), runId: 'run-var', analysisId: 'analysis-var', transcriptPath: file, ruleVersion: 'test' });
      assert.equal(packet.edit_signals?.filter((signal) => signal.role === 'change' && signal.success === true).length, 2);
      assert.deepEqual(packet.rework_hints?.[0]?.paths, ['src/b.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
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
