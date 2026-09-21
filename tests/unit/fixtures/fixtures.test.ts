import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, it } from 'node:test';

interface Line {
  raw: string;
  json: Record<string, unknown> | null;
}

function readJsonl(file: string): Line[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((raw) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        json = null;
      }
      return { raw, json };
    });
}

const REPO = path.join(import.meta.dirname, '../../../..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');

describe('synthetic host fixtures (T03)', () => {
  it('codex/basic: only the unknown-type line stays unparseable, mirrors and call ids are recorded', () => {
    const lines = readJsonl(path.join(FIXTURES, 'codex/basic.jsonl'));
    const broken = lines.filter((l) => l.json === null);
    assert.equal(broken.length, 0);
    const types = lines.map((l) => l.json?.['type']);
    assert.ok(types.includes('function_call_placeholder'), 'unknown record type must exist');

    const userMsg = lines.find(
      (l) => l.json?.['type'] === 'response_item' && (l.json['payload'] as { role?: string }).role === 'user',
    );
    const mirror = lines.find(
      (l) =>
        l.json?.['type'] === 'event_msg' &&
        (l.json['payload'] as { type?: string; item?: { type?: string } }).type === 'item_completed' &&
        (l.json['payload'] as { item: { type: string } }).item.type === 'UserMessage',
    );
    assert.ok(userMsg && mirror, 'mirror pair must exist');
    const original = (
      ((userMsg.json?.['payload'] as { content: { text: string }[] }).content[0] as { text: string }).text
    );
    const mirrored = (
      (
        (mirror.json?.['payload'] as { item: { content: { text: string }[] } }).item
          .content[0] as { text: string }
      ).text
    );
    assert.equal(mirrored, original, 'mirror must carry identical user text');

    const call = lines.find(
      (l) => (l.json?.['payload'] as { type?: string })?.type === 'custom_tool_call',
    );
    const result = lines.find(
      (l) => (l.json?.['payload'] as { type?: string })?.type === 'custom_tool_call_output',
    );
    assert.ok(call && result);
    assert.equal(
      (call.json?.['payload'] as { call_id: string }).call_id,
      (result.json?.['payload'] as { call_id: string }).call_id,
    );
  });

  it('codex/call-result-reordered: result appears before its call', () => {
    const lines = readJsonl(path.join(FIXTURES, 'codex/call-result-reordered.jsonl'));
    const kinds = lines.map((l) => (l.json?.['payload'] as { type?: string })?.type);
    assert.ok(
      kinds.indexOf('custom_tool_call_output') !== -1 &&
        kinds.indexOf('custom_tool_call_output') < kinds.indexOf('custom_tool_call'),
    );
  });

  it('codex/tail-half-line: final line is not valid JSON', () => {
    const lines = readJsonl(path.join(FIXTURES, 'codex/tail-half-line.jsonl'));
    const last = lines[lines.length - 1];
    assert.ok(last);
    assert.equal(last.json, null);
  });

  it('codex/middle-broken-line: a corrupt line sits between valid records', () => {
    const lines = readJsonl(path.join(FIXTURES, 'codex/middle-broken-line.jsonl'));
    assert.equal(lines[1]?.json !== null, true);
    assert.equal(lines[2]?.json, null);
    assert.equal(lines[3]?.json !== null, true);
  });

  it('claude/basic: user/assistant/tool_result chain with uuid linkage', () => {
    const lines = readJsonl(path.join(FIXTURES, 'claude/basic.jsonl'));
    for (const line of lines) {
      assert.notEqual(line.json, null, line.raw.slice(0, 60));
    }
    const toolUse = lines.find((l) =>
      ((l.json?.['message'] as { content?: { type: string }[] })?.content ?? []).some(
        (c) => c.type === 'tool_use',
      ),
    );
    const toolResult = lines.find((l) =>
      ((l.json?.['message'] as { content?: { type: string }[] })?.content ?? []).some(
        (c) => c.type === 'tool_result',
      ),
    );
    assert.ok(toolUse && toolResult);
    const useId = (
      (toolUse.json?.['message'] as { content: { type: string; id?: string }[] }).content.find(
        (c) => c.type === 'tool_use',
      ) as { id: string }
    ).id;
    const resultId = (
      (toolResult.json?.['message'] as { content: { type: string; tool_use_id?: string }[] }).content.find(
        (c) => c.type === 'tool_result',
      ) as { tool_use_id: string }
    ).tool_use_id;
    assert.equal(resultId, useId);
  });
});

const LOCAL_DATA = path.join(REPO, 'test-data');
const skipLocal = fs.existsSync(LOCAL_DATA) ? '' : 'local test-data not present';

describe('local real-session fixtures integrity', { skip: skipLocal === '' ? false : skipLocal }, () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(LOCAL_DATA, 'catalog.json'), 'utf8')) as {
    sessions?: { session_id?: string }[];
  };
  const sessionDirs = catalog.sessions
    ?.map((s) => s.session_id)
    .filter((id): id is string => typeof id === 'string');

  it('every manifest fixture hash matches the on-disk sanitized transcript', () => {
    assert.ok(sessionDirs && sessionDirs.length > 0, 'catalog must list sessions');
    for (const dir of sessionDirs ?? []) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(LOCAL_DATA, dir, 'manifest.json'), 'utf8'),
      ) as { fixture_sha256: string; fixture_file: string; fixture_lines: number };
      const file = path.join(LOCAL_DATA, dir, manifest.fixture_file);
      const content = fs.readFileSync(file);
      const hash = createHash('sha256').update(content).digest('hex');
      assert.equal(hash, manifest.fixture_sha256.replace(/^sha256:/, ''), dir);
      const lines = content
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim() !== '').length;
      assert.equal(lines, manifest.fixture_lines, dir);
    }
  });
});
