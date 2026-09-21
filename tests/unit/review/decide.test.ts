import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { candidateSchema, type Candidate } from '../../../src/domain/candidates.js';
import { ScaError } from '../../../src/domain/errors.js';
import { sha256Tag } from '../../../src/domain/hash.js';
import { applyDecision, contentVersionHash, hasCurrentApproval, type DecisionRequest } from '../../../src/review/decide.js';
import { approvalMetrics } from '../../../src/review/metrics.js';
import { runCli, type CliIo } from '../../../src/cli.js';
import { RecordRepository } from '../../../src/store/repository.js';

const REPO = path.join(import.meta.dirname, '../../../..');
const CODEX_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'codex', 'basic.jsonl');
const NOW = '2026-01-01T00:00:00.000Z';

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function mkCandidate(id: string, overrides: Record<string, unknown> = {}): Candidate {
  return candidateSchema.parse({
    id,
    fingerprint: sha256Tag(`fp-${id}`),
    category: 'process',
    title: `candidate ${id}`,
    confidence: 'high',
    status: 'proposed',
    maturity: 'single_session',
    target: { kind: 'harness' },
    evidence: [`ev-${'a'.repeat(16)}`],
    source_episodes: [`ev-${'b'.repeat(16)}`],
    proposed_content: `content of ${id} v1`,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

async function seeded(...candidates: Candidate[]): Promise<{ repo: RecordRepository; recordId: string }> {
  const root = await tempDir('sca-review-');
  const ws = await tempDir('sca-review-ws-');
  const repo = new RecordRepository(root);
  const { recordId } = await repo.register({
    host: 'codex',
    canonicalWorkspace: ws,
    sessionId: 'review-session-1',
    transcriptPath: CODEX_FIXTURE,
    trigger: 'manual_skill',
    analyzerVersion: '0.1.0',
  });
  const current = await repo.loadCandidates(recordId);
  await repo.updateCandidates(recordId, current, (doc) => ({ ...doc, candidates }));
  return { repo, recordId };
}

async function revision(repo: RecordRepository, recordId: string): Promise<number> {
  return (await repo.loadCandidates(recordId)).doc.revision;
}

function req(
  candidateId: string,
  action: DecisionRequest['action'],
  requestId: string,
  expectedRevision: number,
  extra: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    request_id: requestId,
    candidate_id: candidateId,
    action,
    expected_revision: expectedRevision,
    ...extra,
  };
}

describe('candidate decisions (design 24.4 / 26.2)', () => {
  it('approve binds the decision to the exact content version', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    const outcome = await applyDecision(repo, recordId, req('learning-001', 'approve', 'r-approve', await revision(repo, recordId)));
    assert.equal(outcome.receipt.result, 'applied');
    assert.equal(outcome.candidate.status, 'approved');
    assert.ok(outcome.candidate.decision);
    assert.equal(outcome.candidate.decision.action, 'approve');
    assert.equal(outcome.candidate.decision.content_hash, contentVersionHash(outcome.candidate));
    assert.equal(hasCurrentApproval(outcome.candidate), true);
  });

  it('content edits invalidate the approval and keep the old decision in history', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await applyDecision(repo, recordId, req('learning-001', 'approve', 'r1', await revision(repo, recordId)));
    const afterEdit = await applyDecision(
      repo,
      recordId,
      req('learning-001', 'edit_content', 'r2', await revision(repo, recordId), { content: 'content v2', title: 'renamed' }),
    );
    assert.equal(afterEdit.candidate.status, 'proposed');
    assert.equal(afterEdit.candidate.title, 'renamed');
    assert.equal(afterEdit.candidate.decision, null);
    assert.deepEqual(
      afterEdit.candidate.decision_history.map((record) => record.action),
      ['approve', 'edit_content'],
    );
    assert.equal(hasCurrentApproval(afterEdit.candidate), false);
    // approving the NEW version works and binds the new hash
    const reapproved = await applyDecision(
      repo,
      recordId,
      req('learning-001', 'approve', 'r3', await revision(repo, recordId)),
    );
    assert.equal(reapproved.candidate.status, 'approved');
    assert.equal(hasCurrentApproval(reapproved.candidate), true);
  });

  it('revocation returns to proposed without a new top-level status', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await applyDecision(repo, recordId, req('learning-001', 'approve', 'r1', await revision(repo, recordId)));
    const revoked = await applyDecision(repo, recordId, req('learning-001', 'revoke', 'r2', await revision(repo, recordId), { note: '方向存疑' }));
    assert.equal(revoked.candidate.status, 'proposed');
    assert.equal(revoked.candidate.decision, null);
    assert.equal(revoked.candidate.decision_history.at(-1)?.action, 'revoke');
    const metrics = approvalMetrics((await repo.loadCandidates(recordId)).doc.candidates);
    assert.equal(metrics.pending_review, 1);
    assert.equal(metrics.revoked_pending, 1);
  });

  it('illegal actions are refused and leave the record untouched', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    const rev = await revision(repo, recordId);
    await applyDecision(repo, recordId, req('learning-001', 'approve', 'r1', rev));
    const rev2 = await revision(repo, recordId);
    await assert.rejects(
      () => applyDecision(repo, recordId, req('learning-001', 'approve', 'r2', rev2)),
      (err: unknown) => err instanceof ScaError && /not allowed/.test(err.message),
    );
    const rev3 = await revision(repo, recordId);
    await assert.rejects(
      () => applyDecision(repo, recordId, req('learning-001', 'edit_content', 'r3', rev3)),
      /requires the new content/,
    );
    // supersede from rejected is not a transition; from proposed it is
    const { repo: repo2, recordId: rid2 } = await seeded(mkCandidate('learning-001'));
    await applyDecision(repo2, rid2, req('learning-001', 'reject', 'x1', await revision(repo2, rid2)));
    const rev4 = await revision(repo2, rid2);
    await assert.rejects(
      () => applyDecision(repo2, rid2, req('learning-001', 'supersede', 'x2', rev4)),
      /cannot be superseded/,
    );
    const { repo: repo3, recordId: rid3 } = await seeded(mkCandidate('learning-001'));
    const sup = await applyDecision(repo3, rid3, req('learning-001', 'supersede', 'x3', await revision(repo3, rid3)));
    assert.equal(sup.candidate.status, 'superseded');
  });
});

describe('request idempotency (design 26.2)', () => {
  it('a replayed request id returns the original receipt without writing', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    const rev = await revision(repo, recordId);
    const first = await applyDecision(repo, recordId, req('learning-001', 'approve', 'r-dup', rev));
    assert.equal(first.receipt.result, 'applied');
    const afterFirst = await revision(repo, recordId);
    // the retry arrives with the STALE revision on purpose: receipts beat the revision check
    const retry = await applyDecision(repo, recordId, req('learning-001', 'approve', 'r-dup', rev));
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.receipt, first.receipt);
    assert.equal(await revision(repo, recordId), afterFirst);
  });

  it('same request id with a different payload is rejected outright', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    const rev = await revision(repo, recordId);
    await applyDecision(repo, recordId, req('learning-001', 'approve', 'r-x', rev));
    const before = await revision(repo, recordId);
    const clash = await applyDecision(repo, recordId, req('learning-001', 'approve', 'r-x', before, { note: 'different payload' }));
    assert.equal(clash.receipt.result, 'rejected');
    assert.equal(clash.duplicate, false);
    assert.equal(await revision(repo, recordId), before);
  });

  it('a request id past the retention window answers stale from decision history, never re-executes', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await applyDecision(repo, recordId, req('learning-001', 'approve', 'r-old', await revision(repo, recordId)), { retention: 1 });
    await applyDecision(repo, recordId, req('learning-001', 'revoke', 'r-new', await revision(repo, recordId)), { retention: 1 });
    // r-old has been trimmed out of request_log; its request id lives in decision_history
    const before = await revision(repo, recordId);
    const stale = await applyDecision(repo, recordId, req('learning-001', 'approve', 'r-old', before), { retention: 1 });
    assert.equal(stale.receipt.result, 'stale');
    assert.equal(await revision(repo, recordId), before);
    assert.equal((await repo.loadCandidates(recordId)).doc.candidates[0]?.status, 'proposed');
  });

  it('a stale expected revision fails with revision_conflict', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await assert.rejects(
      () => applyDecision(repo, recordId, req('learning-001', 'approve', 'r1', 999)),
      (err: unknown) => err instanceof ScaError && err.code === 'revision_conflict',
    );
    const doc = (await repo.loadCandidates(recordId)).doc;
    assert.equal(doc.candidates[0]?.status, 'proposed');
  });
});

describe('approval metrics (design 29.4)', () => {
  it('counts A/P/J, exclusion subsets and rates with real decisions', async () => {
    const { repo, recordId } = await seeded(
      mkCandidate('learning-001'),
      mkCandidate('learning-002'),
      mkCandidate('learning-003'),
      mkCandidate('learning-004'),
      mkCandidate('learning-005'),
      mkCandidate('learning-006', { target: { kind: 'memory', scope: 'project' } }),
    );
    const rev = async () => revision(repo, recordId);
    await applyDecision(repo, recordId, req('learning-001', 'approve', 'm1', await rev()));
    await applyDecision(repo, recordId, req('learning-002', 'reject', 'm2', await rev()));
    await applyDecision(repo, recordId, req('learning-003', 'approve', 'm3a', await rev()));
    await applyDecision(repo, recordId, req('learning-003', 'revoke', 'm3b', await rev()));
    // learning-004 stays proposed; learning-005 superseded
    await applyDecision(repo, recordId, req('learning-005', 'supersede', 'm5', await rev()));
    await applyDecision(repo, recordId, req('learning-006', 'approve', 'm6', await rev()));
    const metrics = approvalMetrics((await repo.loadCandidates(recordId)).doc.candidates);
    assert.equal(metrics.effective, 2);
    assert.equal(metrics.rejected, 1);
    assert.equal(metrics.pending_review, 2);
    assert.equal(metrics.revoked_pending, 1);
    assert.equal(metrics.superseded, 1);
    assert.equal(metrics.effective_memory, 1);
    assert.equal(metrics.approval_rate, 2 / 3);
    assert.equal(metrics.review_coverage, 3 / 5);
  });

  it('a hand-edited approved body no longer counts as effective', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await applyDecision(repo, recordId, req('learning-001', 'approve', 'r1', await revision(repo, recordId)));
    const loaded = await repo.loadCandidates(recordId);
    const tampered = await repo.updateCandidates(recordId, loaded, (doc) => ({
      ...doc,
      candidates: doc.candidates.map((c) => ({ ...c, proposed_content: 'silently rewritten content' })),
    }));
    const metrics = approvalMetrics(tampered.doc.candidates);
    assert.equal(metrics.effective, 0);
    assert.equal(metrics.pending_review, 1);
  });

  it('zero denominators are N/A, not percentages', () => {
    const metrics = approvalMetrics([]);
    assert.equal(metrics.approval_rate, null);
    assert.equal(metrics.review_coverage, null);
    assert.equal(metrics.effective, 0);
  });
});

describe('cli review (M3 surface)', () => {
  function collectIo(root: string): { io: CliIo; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      io: {
        env: { SCA_DATA_ROOT: root },
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      },
    };
  }

  it('lists candidates with allowed actions and metrics; decide applies via CLI', async () => {
    const root = await tempDir('sca-review-cli-');
    const ws = await tempDir('sca-review-cli-ws-');
    const repo = new RecordRepository(root);
    const { recordId } = await repo.register({
      host: 'codex',
      canonicalWorkspace: ws,
      sessionId: 'review-cli-1',
      transcriptPath: CODEX_FIXTURE,
      trigger: 'manual_skill',
      analyzerVersion: '0.1.0',
    });
    const loaded = await repo.loadCandidates(recordId);
    await repo.updateCandidates(recordId, loaded, (doc) => ({ ...doc, candidates: [mkCandidate('learning-001')] }));

    const list = collectIo(root);
    assert.equal(await runCli(['review', recordId], list.io), 0);
    const view = JSON.parse(String(list.lines[0])) as {
      ok: boolean;
      revision: number;
      candidates: { id: string; allowed_actions: string[] }[];
      metrics: { pending_review: number };
    };
    assert.equal(view.ok, true);
    assert.equal(view.candidates[0]?.allowed_actions.includes('approve'), true);
    assert.equal(view.metrics.pending_review, 1);

    const decide = collectIo(root);
    const code = await runCli(
      ['review', recordId, '--action', 'approve', '--candidate', 'learning-001', '--request', 'cli-1', '--expected-revision', String(view.revision)],
      decide.io,
    );
    assert.equal(code, 0);
    const receipt = JSON.parse(String(decide.lines[0])) as { receipt: { result: string }; candidate: { status: string } };
    assert.equal(receipt.receipt.result, 'applied');
    assert.equal(receipt.candidate.status, 'approved');

    const missing = collectIo(root);
    assert.equal(await runCli(['review', recordId, '--action', 'approve', '--candidate', 'learning-001'], missing.io), 2);
  });

  it('edit_content reads the new body from a file', async () => {
    const root = await tempDir('sca-review-cli2-');
    const ws = await tempDir('sca-review-cli2-ws-');
    const repo = new RecordRepository(root);
    const { recordId } = await repo.register({
      host: 'codex',
      canonicalWorkspace: ws,
      sessionId: 'review-cli-2',
      transcriptPath: CODEX_FIXTURE,
      trigger: 'manual_skill',
      analyzerVersion: '0.1.0',
    });
    const loaded = await repo.loadCandidates(recordId);
    await repo.updateCandidates(recordId, loaded, (doc) => ({ ...doc, candidates: [mkCandidate('learning-001')] }));
    const contentPath = path.join(root, 'new-content.md');
    await fs.writeFile(contentPath, '# 规则\n\n修订后的候选正文', 'utf8');
    const io = collectIo(root);
    const code = await runCli(
      [
        'review',
        recordId,
        '--action',
        'edit_content',
        '--candidate',
        'learning-001',
        '--request',
        'cli-edit',
        '--expected-revision',
        String(await revision(repo, recordId)),
        '--content-file',
        contentPath,
      ],
      io.io,
    );
    assert.equal(code, 0);
    const doc = (await repo.loadCandidates(recordId)).doc;
    assert.equal(doc.candidates[0]?.proposed_content, '# 规则\n\n修订后的候选正文');
    assert.equal(doc.candidates[0]?.status, 'proposed');
  });
});
