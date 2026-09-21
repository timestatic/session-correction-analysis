import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { computeRecordId } from '../../../src/domain/ids.js';
import { ScaError } from '../../../src/domain/errors.js';
import { canonicalWorkspace, assertSafeRecordId } from '../../../src/store/paths.js';
import { ANALYZE_FILE, CANDIDATES_FILE, RecordRepository } from '../../../src/store/repository.js';
import { makeCandidate } from '../domain/helpers.js';

async function newRepo(): Promise<{ repo: RecordRepository; root: string; ws: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sca-repo-'));
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'sca-ws-'));
  return { repo: new RecordRepository(root), root, ws };
}

function registerInput(ws: string, title?: string) {
  return {
    host: 'codex' as const,
    canonicalWorkspace: ws,
    sessionId: 'thr_123',
    transcriptPath: path.join(ws, 'rollout-123.jsonl'),
    analyzerVersion: '0.1.0',
    trigger: 'manual_skill' as const,
    ...(title !== undefined ? { title } : {}),
  };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => err instanceof ScaError && err.code === code);
}

describe('records/<record_id>/ flat layout', () => {
  it('registers a session in a deterministic flat directory', async () => {
    const { repo, root, ws } = await newRepo();
    const res = await repo.register(registerInput(ws, '第四批联调测试-2'));
    const expected = computeRecordId('codex', ws, 'thr_123');
    assert.equal(res.recordId, expected);
    assert.equal(res.created, true);
    assertSafeRecordId(res.recordId);
    const dir = path.join(root, 'records', res.recordId);
    assert.equal(path.basename(path.dirname(dir)), 'records');
    const analyzeText = await fsp.readFile(path.join(dir, ANALYZE_FILE), 'utf8');
    assert.match(analyzeText, /session_id: thr_123/);
    assert.match(analyzeText, /session_title: 第四批联调测试-2/);
    assert.match(analyzeText, /# Session 分析/);
    assert.equal(res.candidates.doc.candidate_count, 0);
    assert.equal(res.analyze.doc.analysis_status, 'pending');
  });

  it('re-registering with a new title reuses the directory and keeps state', async () => {
    const { repo, ws } = await newRepo();
    const first = await repo.register(registerInput(ws, '旧标题'));
    const second = await repo.register(registerInput(ws, '新标题'));
    assert.equal(second.recordId, first.recordId);
    assert.equal(second.created, false);
    assert.equal(second.analyze.doc.revision, 1);
    assert.equal(second.analyze.fileHash, first.analyze.fileHash);
    assert.equal(second.analyze.doc.session_title, '旧标题');
  });

  it('different identity never shares a directory', async () => {
    const { repo, ws } = await newRepo();
    const a = await repo.register(registerInput(ws));
    const b = await repo.register({ ...registerInput(ws), sessionId: 'thr_999' });
    assert.notEqual(a.recordId, b.recordId);
  });

  it('completes a half-written skeleton without clobbering the existing file', async () => {
    const { repo, root, ws } = await newRepo();
    const first = await repo.register(registerInput(ws));
    const dir = path.join(root, 'records', first.recordId);
    await fsp.rm(path.join(dir, CANDIDATES_FILE));
    const again = await repo.register(registerInput(ws));
    assert.equal(again.created, true);
    assert.equal(again.analyze.doc.revision, 1);
    assert.equal(again.candidates.doc.revision, 1);
    await fsp.writeFile(path.join(dir, CANDIDATES_FILE), 'not markdown at all');
    await expectCode(() => repo.register(registerInput(ws)), 'schema_invalid');
  });

  it('load refuses a record whose stored identity does not match the directory', async () => {
    const { repo, root, ws } = await newRepo();
    const first = await repo.register(registerInput(ws));
    const file = path.join(root, 'records', first.recordId, ANALYZE_FILE);
    const text = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(file, text.replace('session_id: thr_123', 'session_id: thr_hacked'));
    await expectCode(() => repo.loadAnalyze(first.recordId), 'record_identity_mismatch');
  });
});

describe('optimistic updates with revision + file hash', () => {
  it('bumps revision, regenerates projection and preserves User Notes', async () => {
    const { repo, root, ws } = await newRepo();
    const { recordId, analyze } = await repo.register(registerInput(ws));
    const dir = path.join(root, 'records', recordId);
    const file = path.join(dir, ANALYZE_FILE);
    const text = await fsp.readFile(file, 'utf8');
    assert.match(text, /## User Notes/);
    await fsp.writeFile(file, text.replace('## User Notes\n', '## User Notes\n\n人工备注：等复核\n'));

    const current = await repo.loadAnalyze(recordId);
    const updated = await repo.updateAnalyze(recordId, current, (doc) => ({
      ...doc,
      analysis_status: 'running',
    }));
    assert.equal(updated.doc.revision, 2);
    assert.equal(updated.doc.analysis_status, 'running');
    const written = await fsp.readFile(file, 'utf8');
    assert.match(written, /人工备注：等复核/);
    assert.equal(analyze.doc.revision, 1);
  });

  it('rejects a stale revision or a file that changed on disk', async () => {
    const { repo, ws } = await newRepo();
    const { recordId } = await repo.register(registerInput(ws));
    const snapshot = await repo.loadAnalyze(recordId);
    await repo.updateAnalyze(recordId, snapshot, (doc) => ({ ...doc, analysis_status: 'running' }));
    await expectCode(
      () => repo.updateAnalyze(recordId, snapshot, (doc) => ({ ...doc, analysis_status: 'failed' })),
      'revision_conflict',
    );
  });

  it('rejects mutations that break the schema and leaves the file untouched', async () => {
    const { repo, ws } = await newRepo();
    const { recordId } = await repo.register(registerInput(ws));
    const before = await repo.loadAnalyze(recordId);
    await expectCode(
      () => repo.updateAnalyze(recordId, before, (doc) => ({ ...doc, source: 'other-host' as never })),
      'schema_invalid',
    );
    const after = await repo.loadAnalyze(recordId);
    assert.equal(after.fileHash, before.fileHash);
  });

  it('recomputes derived candidate counts and rejects contradictory edits', async () => {
    const { repo, root, ws } = await newRepo();
    const { recordId, candidates } = await repo.register(registerInput(ws));
    const withOne = await repo.updateCandidates(recordId, candidates, (doc) => ({
      ...doc,
      candidates: [makeCandidate({ status: 'published' })],
    }));
    assert.equal(withOne.doc.candidate_count, 1);
    assert.equal(withOne.doc.published_count, 1);

    const file = path.join(root, 'records', recordId, CANDIDATES_FILE);
    const text = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(file, text.replace('published_count: 1', 'published_count: 7'));
    await expectCode(() => repo.loadCandidates(recordId), 'schema_invalid');
  });
});

describe('workspace canonicalization', () => {
  it('stable identity survives a trailing slash', async () => {
    const { repo, ws } = await newRepo();
    const a = await repo.register(registerInput(ws));
    const b = await repo.register(registerInput(`${ws}/`));
    assert.equal(b.recordId, a.recordId);
    assert.equal(b.created, false);
  });

  it('canonicalWorkspace resolves . and trailing slashes to one value', async () => {
    const { ws } = await newRepo();
    const canonical = await canonicalWorkspace(ws);
    assert.equal(await canonicalWorkspace(path.join(ws, '.')), canonical);
    assert.equal(await canonicalWorkspace(`${ws}/`), canonical);
  });
});
