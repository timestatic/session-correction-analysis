import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ScaError } from '../../../src/domain/errors.js';
import { resolveSource, type SessionIndex } from '../../../src/hosts/resolver.js';

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sca-resolver-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{"type":"session_meta","payload":{"id":"x"}}\n');
  return file;
}

function indexWith(entries: { source: string; record: string; transcript: string }[]): SessionIndex {
  return {
    lookup: (sessionId: string) => {
      const hit = entries.find((e) => e.source === sessionId);
      return Promise.resolve(hit === undefined ? null : { record_id: hit.record, transcript_path: hit.transcript });
    },
  };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => err instanceof ScaError && err.code === code);
}

describe('exact session resolver', () => {
  it('prefers an explicit transcript path', async () => {
    const file = tmpFile('rollout-a.jsonl');
    const resolved = await resolveSource({ transcriptPath: file }, indexWith([]));
    assert.equal(resolved.transcriptPath, file);
    assert.equal(resolved.registered, undefined);
  });

  it('resolves a session id only through the registered index', async () => {
    const file = tmpFile('rollout-b.jsonl');
    const index = indexWith([{ source: 'thr_1', record: 'rec-1', transcript: file }]);
    const resolved = await resolveSource({ sessionId: 'thr_1' }, index);
    assert.equal(resolved.registered?.record_id, 'rec-1');
  });

  it('fails closed for unknown session ids instead of scanning history', async () => {
    await expectCode(() => resolveSource({ sessionId: 'nope' }, indexWith([])), 'session_locator_unavailable');
  });

  it('rejects conflicting explicit locators', async () => {
    const fileA = tmpFile('rollout-a.jsonl');
    const fileB = tmpFile('rollout-b.jsonl');
    const index = indexWith([{ source: 'thr_1', record: 'rec-1', transcript: fileA }]);
    await expectCode(
      () => resolveSource({ sessionId: 'thr_1', transcriptPath: fileB }, index),
      'location_conflict',
    );
  });

  it('accepts matching explicit session + transcript locators', async () => {
    const file = tmpFile('rollout-a.jsonl');
    const index = indexWith([{ source: 'thr_1', record: 'rec-1', transcript: file }]);
    const resolved = await resolveSource({ sessionId: 'thr_1', transcriptPath: file }, index);
    assert.equal(resolved.registered?.record_id, 'rec-1');
  });

  it('reports unreadable transcripts distinctly', async () => {
    const missing = path.join(os.tmpdir(), 'sca-definitely-missing.jsonl');
    await expectCode(() => resolveSource({ transcriptPath: missing }, indexWith([])), 'transcript_unreadable');
  });
});
