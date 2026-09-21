import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ScaError } from '../../../src/domain/errors.js';
import { adaptNormalized, normalizedEventSchema, normalizedMetaSchema } from '../../../src/hosts/normalized.js';

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function transcriptFile(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-norm-'));
  dirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

const META = JSON.stringify({
  type: 'meta',
  host: 'codex',
  source_session_id: 'norm-session-1',
  workspace: '/tmp/project',
  title: '归一化示例',
});

function eventLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({ type: 'event', kind: 'user_message', text: '不是这个来源', ...overrides });
}

describe('normalized transcript frozen contract (T07a)', () => {
  it('accepts the canonical example: meta first, explicit ids preserved', async () => {
    const file = await transcriptFile(
      'basic.jsonl',
      `${META}\n${eventLine({ id: 'u-1' })}\n${eventLine({ id: 'a-1', kind: 'assistant_message' })}\n`,
    );
    const t = await adaptNormalized(file);
    assert.equal(t.host, 'codex');
    assert.equal(t.source_session_id, 'norm-session-1');
    assert.equal(t.workspace, '/tmp/project');
    assert.equal(t.title, '归一化示例');
    assert.equal(t.coverage, 'full');
    assert.deepEqual(
      t.events.map((e) => e.id),
      ['u-1', 'a-1'],
    );
    assert.deepEqual(
      t.events.map((e) => e.ordinal),
      [0, 1],
    );
  });

  it('handles CRLF line endings without corrupting events', async () => {
    const file = await transcriptFile('crlf.jsonl', `${META}\r\n${eventLine({})}\r\n`);
    const t = await adaptNormalized(file);
    assert.equal(t.events.length, 1);
    assert.equal(t.coverage, 'full');
    assert.equal(t.stats.bad_lines, 0);
  });

  it('generates deterministic norm:L<line> ids when id is omitted', async () => {
    const file = await transcriptFile('genids.jsonl', `${META}\n${eventLine({})}\n`);
    const t = await adaptNormalized(file);
    assert.equal(t.events[0]?.id, 'norm:L2');
  });

  it('fails closed when the first line is not a valid identity meta', async () => {
    const cases: [string, string][] = [
      ['no meta', `${eventLine({})}\n${META}\n`],
      ['unknown host', `${JSON.stringify({ type: 'meta', host: 'cursor', source_session_id: 'x' })}\n`],
      ['extra meta keys', `${JSON.stringify({ ...JSON.parse(META), vendor: 'acme' })}\n`],
      ['empty session id', `${JSON.stringify({ type: 'meta', host: 'codex', source_session_id: '' })}\n`],
    ];
    for (const [label, content] of cases) {
      const file = await transcriptFile(`bad-${label.replace(/\W+/g, '-')}.jsonl`, content);
      await assert.rejects(
        () => adaptNormalized(file),
        (err: unknown) => err instanceof ScaError && err.code === 'unsupported_transcript',
        label,
      );
    }
  });

  it('degrades bad event lines to counted noise with partial coverage', async () => {
    const broken = '{"type":"event","kind":"user_message"\n';
    const wrongKind = JSON.stringify({ type: 'event', kind: 'telepathy', text: 'x' });
    const noText = JSON.stringify({ type: 'event', kind: 'user_message' });
    const file = await transcriptFile('noisy.jsonl', `${META}\n${broken}${wrongKind}\n${noText}\n${eventLine({})}\n`);
    const t = await adaptNormalized(file);
    assert.equal(t.events.length, 1);
    assert.equal(t.stats.bad_lines, 3);
    assert.equal(t.coverage, 'partial');
    assert.equal(t.stats.ignored_records['normalized:invalid_event_line'], 2);
  });

  it('marks a truncated final line as tail_incomplete, not a corrupt line', async () => {
    const file = await transcriptFile('tail.jsonl', `${META}\n{"type":"event","kind":"user_message","tex`);
    const t = await adaptNormalized(file);
    assert.equal(t.stats.tail_incomplete, true);
    assert.equal(t.stats.bad_lines, 0);
    assert.equal(t.coverage, 'partial');
  });

  it('rejects an empty file instead of inventing an empty full session', async () => {
    const file = await transcriptFile('empty.jsonl', '');
    await assert.rejects(
      () => adaptNormalized(file),
      (err: unknown) => err instanceof ScaError && err.code === 'unsupported_transcript',
    );
  });

  it('exposes the frozen line schemas for external tooling', () => {
    assert.equal(normalizedMetaSchema.safeParse(JSON.parse(META)).success, true);
    assert.equal(
      normalizedEventSchema.safeParse({ type: 'event', kind: 'tool_call', text: 'ls', call_id: 'c1' }).success,
      true,
    );
    assert.equal(normalizedEventSchema.safeParse({ type: 'event', kind: 'tool_call' }).success, false);
  });
});
