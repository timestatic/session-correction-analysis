import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { Candidate } from '../../../src/domain/candidates.js';
import type { AnalyzeFacts } from '../../../src/domain/documents.js';
import { ScaError } from '../../../src/domain/errors.js';
import { PENDING_COMMIT_MAX_BYTES } from '../../../src/domain/limits.js';
import { CANDIDATES_FILE, RecordRepository } from '../../../src/store/repository.js';
import type { PendingPayload, RunFence } from '../../../src/store/commit.js';
import { makeCandidate, makeEpisode, HASH_A, HASH_B } from '../domain/helpers.js';

async function newRecord(): Promise<{ repo: RecordRepository; recordId: string; root: string; ws: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sca-commit-'));
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'sca-cws-'));
  const repo = new RecordRepository(root);
  const { recordId } = await repo.register({
    host: 'codex',
    canonicalWorkspace: ws,
    sessionId: 'thr_123',
    transcriptPath: path.join(ws, 'rollout.jsonl'),
    analyzerVersion: '0.1.0',
    trigger: 'manual_skill',
  });
  return { repo, recordId, root, ws };
}

function facts(overrides?: Partial<AnalyzeFacts>): AnalyzeFacts {
  return {
    processed_users: [],
    candidate_sources: [],
    snapshot: {
      source_kind: 'codex_transcript',
      host: 'codex',
      source_session_id: 'thr_123',
      coverage: 'full',
      parser_version: '0.1.0',
      rule_version: 'r1',
      source_fingerprint: HASH_A,
    },
    episodes: [makeEpisode()],
    evidence: [
      {
        id: 'ev-1',
        kind: 'user_text',
        excerpt: '不是这个来源',
        source_ref: { line: 5, hash: HASH_B },
        truncated: false,
      },
    ],
    runs: [],
    parse_errors: [],
    ...overrides,
  };
}

function payload(candidates: Candidate[]): PendingPayload {
  return {
    analysisId: 'analysis-1',
    inputDigest: HASH_A,
    facts: facts(),
    candidates,
  };
}

function fence(lease: { run_id: string; generation: number }): RunFence {
  return { runId: lease.run_id, generation: lease.generation };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => err instanceof ScaError && err.code === code);
}

describe('lease fencing', () => {
  it('grants one live lease, renews the same run and blocks other runners', async () => {
    const { repo, recordId } = await newRecord();
    const first = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    assert.equal(first.generation, 0);
    await expectCode(
      () => repo.acquireLease(recordId, { runId: 'run-2', owner: 'drain', ttlMs: 60_000 }),
      'lease_active',
    );
    const renewed = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    assert.equal(renewed.generation, 0);
  });

  it('a takeover after expiry bumps the generation and rejects the stale runner', async () => {
    const { repo, recordId } = await newRecord();
    const stale = await repo.acquireLease(recordId, { runId: 'run-old', owner: 'skill', ttlMs: 1 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    const taken = await repo.acquireLease(recordId, { runId: 'run-new', owner: 'drain', ttlMs: 60_000 });
    assert.equal(taken.generation, 1);
    await expectCode(() => repo.beginCommit(recordId, fence(stale), payload([])), 'lease_expired');
    const { doc } = await repo.loadAnalyze(recordId);
    const history = doc.extensions?.['lease_history'];
    assert.ok(Array.isArray(history) && history.length === 1);
  });

  it('commit steps require a lease from the start', async () => {
    const { repo, recordId } = await newRecord();
    await expectCode(() => repo.beginCommit(recordId, { runId: 'ghost', generation: 0 }, payload([])), 'lease_expired');
  });
});

describe('two-file recoverable commit', () => {
  it('begin → apply commits facts, appends candidates and clears lease', async () => {
    const { repo, recordId } = await newRecord();
    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    const pending = await repo.beginCommit(recordId, fence(lease), payload([makeCandidate()]));
    const mid = await repo.loadAnalyze(recordId);
    assert.equal(mid.doc.pending_commit?.analysis_id, 'analysis-1');
    assert.equal(mid.doc.analysis_status, 'running');

    const analysisId = await repo.applyCommit(recordId, fence(lease));
    assert.equal(analysisId, pending.analysis_id);
    const view = await repo.loadRecord(recordId);
    assert.equal(view.analyze.doc.analysis_id, 'analysis-1');
    assert.equal(view.analyze.doc.analysis_status, 'completed');
    assert.equal(view.analyze.doc.pending_commit, null);
    assert.equal(view.analyze.doc.lease, null);
    assert.equal(view.analyze.doc.facts?.episodes.length, 1);
    assert.equal(view.candidates.doc.candidates.length, 1);
    assert.equal(view.candidates.doc.applied_analysis_id, 'analysis-1');
    assert.equal(view.candidates.doc.candidate_count, 1);
  });

  it('a crash after step 1 is completed idempotently by the next reader', async () => {
    const { repo, recordId } = await newRecord();
    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    await repo.beginCommit(recordId, fence(lease), payload([makeCandidate()]));

    const view = await repo.loadRecord(recordId);
    assert.equal(view.analyze.doc.analysis_id, 'analysis-1');
    assert.equal(view.candidates.doc.candidates.length, 1);
    // second read must not duplicate; the still-live owner lease survives a reader-driven recovery
    const again = await repo.loadRecord(recordId);
    assert.equal(again.candidates.doc.candidates.length, 1);
    assert.equal(again.analyze.doc.lease?.run_id, 'run-1');
  });

  it('a crash after step 2 finishes only step 3', async () => {
    const { repo, recordId } = await newRecord();
    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    await repo.beginCommit(recordId, fence(lease), payload([makeCandidate()]));
    await repo.stageCandidates(recordId, fence(lease));
    const staged = await repo.loadCandidates(recordId);
    assert.equal(staged.doc.candidates.length, 1);
    assert.equal(staged.doc.applied_analysis_id, 'analysis-1');

    const view = await repo.loadRecord(recordId);
    assert.equal(view.analyze.doc.pending_commit, null);
    assert.equal(view.candidates.doc.candidates.length, 1);
  });

  it('re-applying an already committed run is rejected, not duplicated', async () => {
    const { repo, recordId } = await newRecord();
    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    await repo.beginCommit(recordId, fence(lease), payload([makeCandidate()]));
    await repo.applyCommit(recordId, fence(lease));
    // the commit released the run's authority: any late retry is fenced out
    await expectCode(() => repo.applyCommit(recordId, fence(lease)), 'lease_expired');
    const view = await repo.loadCandidates(recordId);
    assert.equal(view.doc.candidates.length, 1);
  });

  it('never overwrites published or human-reviewed candidates during apply', async () => {
    const { repo, recordId } = await newRecord();
    const seed = await repo.loadCandidates(recordId);
    const approved = makeCandidate({ status: 'approved' });
    await repo.updateCandidates(recordId, seed, (doc) => ({ ...doc, candidates: [approved] }));

    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    // the re-analyzer proposes the same learning again as a fresh proposed candidate
    await repo.beginCommit(recordId, fence(lease), payload([makeCandidate({ status: 'proposed' })]));
    await repo.applyCommit(recordId, fence(lease));

    const view = await repo.loadCandidates(recordId);
    assert.equal(view.doc.candidates.length, 1);
    assert.equal(view.doc.candidates[0]?.status, 'approved');
    assert.equal(view.doc.applied_analysis_id, 'analysis-1');
  });

  it('a corrupt candidates file blocks recovery and keeps files untouched', async () => {
    const { repo, root, recordId } = await newRecord();
    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    await repo.beginCommit(recordId, fence(lease), payload([makeCandidate()]));
    const candidatesFile = path.join(root, 'records', recordId, CANDIDATES_FILE);
    await fsp.writeFile(candidatesFile, 'garbage not markdown\n');
    const before = await fsp.readFile(candidatesFile, 'utf8');

    await expectCode(() => repo.loadRecord(recordId), 'pending_commit_recovery_failed');
    const after = await fsp.readFile(candidatesFile, 'utf8');
    assert.equal(after, before);
    // and new writes stay refused while recovery fails
    await expectCode(
      () => repo.acquireLease(recordId, { runId: 'run-2', owner: 'drain', ttlMs: 60_000 }),
      'pending_commit_recovery_failed',
    );
  });

  it('oversized pending payloads are refused before any write', async () => {
    const { repo, recordId } = await newRecord();
    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    const huge = facts({
      summary: 'x'.repeat(PENDING_COMMIT_MAX_BYTES + 1_024),
    });
    await expectCode(
      () => repo.beginCommit(recordId, fence(lease), { analysisId: 'a', inputDigest: HASH_A, facts: huge, candidates: [] }),
      'payload_too_large',
    );
    const doc = await repo.loadAnalyze(recordId);
    assert.ok(doc.doc.pending_commit === undefined || doc.doc.pending_commit === null);
  });

  it('a second pending commit while one is open is refused', async () => {
    const { repo, recordId } = await newRecord();
    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    await repo.beginCommit(recordId, fence(lease), payload([]));
    await expectCode(() => repo.beginCommit(recordId, fence(lease), payload([])), 'revision_conflict');
  });

  it('register on a record with an open commit recovers it first', async () => {
    const { repo, recordId, ws } = await newRecord();
    const lease = await repo.acquireLease(recordId, { runId: 'run-1', owner: 'skill', ttlMs: 60_000 });
    await repo.beginCommit(recordId, fence(lease), payload([makeCandidate()]));
    const res = await repo.register({
      host: 'codex',
      canonicalWorkspace: ws,
      sessionId: 'thr_123',
      transcriptPath: path.join(ws, 'rollout.jsonl'),
      analyzerVersion: '0.1.0',
      trigger: 'session_end',
    });
    assert.equal(res.created, false);
    assert.equal(res.analyze.doc.analysis_id, 'analysis-1');
    assert.equal(res.analyze.doc.pending_commit, null);
    assert.equal(res.candidates.doc.candidates.length, 1);
  });
});
