import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { candidateSchema, type Candidate } from '../../../src/domain/candidates.js';
import { ScaError } from '../../../src/domain/errors.js';
import { sha256Tag, stableHash } from '../../../src/domain/hash.js';
import { computeRuleId } from '../../../src/domain/rules.js';
import { applyDecision, contentVersionHash } from '../../../src/review/decide.js';
import { adoptCandidate, revokeRule } from '../../../src/rules/adopt.js';
import { listRules, ruleDetail } from '../../../src/rules/list.js';
import { loadRegistry, transactRegistry } from '../../../src/store/registry.js';
import { RecordRepository } from '../../../src/store/repository.js';
import { runCli, type CliIo } from '../../../src/cli.js';

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

async function seeded(...candidates: Candidate[]): Promise<{ repo: RecordRepository; recordId: string; ws: string }> {
  const root = await tempDir('sca-adopt-');
  const ws = await tempDir('sca-adopt-ws-');
  const repo = new RecordRepository(root);
  const { recordId } = await repo.register({
    host: 'codex',
    canonicalWorkspace: ws,
    sessionId: 'adopt-session-1',
    transcriptPath: CODEX_FIXTURE,
    trigger: 'manual_skill',
    analyzerVersion: '0.1.0',
  });
  const current = await repo.loadCandidates(recordId);
  await repo.updateCandidates(recordId, current, (doc) => ({ ...doc, candidates }));
  return { repo, recordId, ws };
}

async function revision(repo: RecordRepository, recordId: string): Promise<number> {
  return (await repo.loadCandidates(recordId)).doc.revision;
}

async function registryRevision(repo: RecordRepository): Promise<number> {
  return (await loadRegistry(repo.paths)).revision;
}

async function approve(repo: RecordRepository, recordId: string, candidateId: string, requestId: string): Promise<void> {
  await applyDecision(repo, recordId, {
    request_id: requestId,
    candidate_id: candidateId,
    action: 'approve',
    expected_revision: await revision(repo, recordId),
  });
}

function adoptReq(candidateId: string, requestId: string, expectedRevision: number, extra: Record<string, unknown> = {}) {
  return { request_id: requestId, candidate_id: candidateId, expected_revision: expectedRevision, ...extra };
}

describe('adopt records approvals in the root registry (design 31.2 lightweight)', () => {
  it('adopts an approved candidate and leaves the candidate document untouched', async () => {
    const { repo, recordId, ws } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const candidatesPath = repo.candidatesPath(recordId);
    const candidatesBefore = await fs.readFile(candidatesPath, 'utf8');
    const revBefore = await revision(repo, recordId);

    const outcome = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a1', revBefore));
    assert.equal(outcome.receipt.result, 'applied');
    assert.equal(outcome.duplicate, false);
    assert.equal(outcome.revision, 1);
    assert.equal(outcome.rule.rule_id, computeRuleId(recordId, 'learning-001'));
    assert.equal(outcome.rule.status, 'active');
    assert.equal(outcome.rule.version, 1);
    assert.equal(outcome.rule.content, 'content of learning-001 v1');
    const approved = (await repo.loadCandidates(recordId)).doc.candidates[0];
    assert.equal(contentVersionHash(approved!), outcome.rule.content_hash);
    assert.deepEqual(outcome.rule.scope, { kind: 'project', canonical_workspace: ws });
    assert.deepEqual(outcome.rule.source, {
      record_id: recordId,
      candidate_id: 'learning-001',
      candidate_content_hash: outcome.rule.content_hash,
    });
    // No double write: the candidates file is byte-identical, no rule_ref anywhere.
    assert.equal(await revision(repo, recordId), revBefore);
    assert.equal(await fs.readFile(candidatesPath, 'utf8'), candidatesBefore);
    // The registry file itself lives at the data root and round-trips.
    await fs.access(path.join(repo.paths.root, 'accepted_rules.md'));
    const reloaded = await loadRegistry(repo.paths);
    assert.equal(reloaded.rules[0]?.rule_id, outcome.rule.rule_id);
  });

  it('refuses unapproved content and stale revisions', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    const rev0 = await revision(repo, recordId);
    await assert.rejects(
      () => adoptCandidate(repo, recordId, adoptReq('learning-001', 'a1', rev0)),
      (err: unknown) => err instanceof ScaError && err.code === 'approval_missing',
    );
    await approve(repo, recordId, 'learning-001', 'ap1');
    await assert.rejects(
      () => adoptCandidate(repo, recordId, adoptReq('learning-001', 'a2', rev0)),
      (err: unknown) => err instanceof ScaError && err.code === 'revision_conflict',
    );
    // an edit drops the approval again
    await applyDecision(repo, recordId, {
      request_id: 'e1',
      candidate_id: 'learning-001',
      action: 'edit_content',
      expected_revision: await revision(repo, recordId),
      content: 'content v2',
    });
    const revAfterEdit = await revision(repo, recordId);
    await assert.rejects(
      () => adoptCandidate(repo, recordId, adoptReq('learning-001', 'a3', revAfterEdit)),
      (err: unknown) => err instanceof ScaError && err.code === 'approval_missing',
    );
    assert.equal(await registryRevision(repo), 0);
  });

  it('the ledger replays retries and rejects payload clashes without writing', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const rev = await revision(repo, recordId);
    const first = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a-dup', rev));
    const registryRev = await registryRevision(repo);
    // the candidates revision has moved on, but the identical request payload
    // must replay from the ledger before any gate is evaluated
    await repo.loadCandidates(recordId).then((c) =>
      repo.updateCandidates(recordId, c, (doc) => ({ ...doc })),
    );
    const retry = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a-dup', rev));
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.receipt, first.receipt);
    assert.equal(await registryRevision(repo), registryRev);

    const clash = await adoptCandidate(
      repo,
      recordId,
      adoptReq('learning-001', 'a-dup', rev, { note: 'different payload' }),
    );
    assert.equal(clash.receipt.result, 'rejected');
    assert.equal(clash.duplicate, false);
    assert.equal(await registryRevision(repo), registryRev);
  });

  it('re-adopting the same version under a new request id is a no-op', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const first = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a1', await revision(repo, recordId)));
    const second = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a2', await revision(repo, recordId)));
    assert.equal(second.duplicate, true);
    assert.equal(second.receipt.result, 'duplicate');
    assert.equal(second.rule.rule_id, first.rule.rule_id);
    assert.equal(second.revision, 2);
    assert.deepEqual(second.rule, first.rule);
    assert.equal((await loadRegistry(repo.paths)).rules.length, 1);
  });

  it('edit → re-approve → adopt revises the rule in place with version + history', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const v1 = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a1', await revision(repo, recordId)));
    await applyDecision(repo, recordId, {
      request_id: 'e1',
      candidate_id: 'learning-001',
      action: 'edit_content',
      expected_revision: await revision(repo, recordId),
      content: 'revised body',
    });
    await approve(repo, recordId, 'learning-001', 'ap2');
    const v2 = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a2', await revision(repo, recordId)));
    assert.equal(v2.rule.version, 2);
    assert.equal(v2.rule.content, 'revised body');
    assert.equal(v2.rule.accepted_at, v1.rule.accepted_at);
    assert.deepEqual(v2.rule.history.map((h) => h.action), ['adopted', 'revised']);
    assert.equal(v2.revision, 2);
    const registry = await loadRegistry(repo.paths);
    assert.equal(registry.rules.length, 1);
  });

  it('a request id trimmed out of the ledger answers stale from rule history', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'), mkCandidate('learning-002'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    await approve(repo, recordId, 'learning-002', 'ap2');
    await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a-old', await revision(repo, recordId)));
    await adoptCandidate(repo, recordId, adoptReq('learning-002', 'a-new', await revision(repo, recordId)));
    await transactRegistry(repo.paths, (doc) => ({ write: true, doc: { ...doc, request_log: doc.request_log.slice(-1) }, result: undefined }));
    const before = await registryRevision(repo);
    const stale = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a-old', await revision(repo, recordId)));
    assert.equal(stale.receipt.result, 'stale');
    assert.equal(stale.rule.rule_id, computeRuleId(recordId, 'learning-001'));
    assert.equal(await registryRevision(repo), before);
  });
});

describe('registry request identity and durable replay', () => {
  it('records a duplicate receipt so retrying after revocation cannot reactivate the rule', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const request = adoptReq('learning-001', 'duplicate-request', await revision(repo, recordId));
    await adoptCandidate(repo, recordId, { ...request, request_id: 'first' });
    const duplicate = await adoptCandidate(repo, recordId, request);
    const revoked = await revokeRule(repo, { request_id: 'revoke', rule_id: duplicate.rule.rule_id, expected_revision: duplicate.revision });
    const replay = await adoptCandidate(repo, recordId, request);
    assert.deepEqual(replay.receipt, duplicate.receipt);
    assert.equal(replay.rule.status, 'revoked');
    assert.equal(replay.revision, revoked.revision);
    assert.equal((await adoptCandidate(repo, recordId, { ...request, request_id: 'new-decision' })).rule.status, 'active');
  });

  it('rejects cross-record, cross-operation and changed-payload reuse with the original rule', async () => {
    const { repo, recordId, ws } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const request = adoptReq('learning-001', 'shared', await revision(repo, recordId));
    const first = await adoptCandidate(repo, recordId, request);
    const other = await repo.register({ host: 'codex', canonicalWorkspace: ws, sessionId: 'other-session', transcriptPath: CODEX_FIXTURE, trigger: 'manual_skill', analyzerVersion: '0.1.0' });
    const loaded = await repo.loadCandidates(other.recordId);
    await repo.updateCandidates(other.recordId, loaded, (doc) => ({ ...doc, candidates: [mkCandidate('learning-001')] }));
    await approve(repo, other.recordId, 'learning-001', 'ap-other');
    for (const id of ['shared', 'duplicate-id']) {
      if (id === 'duplicate-id') await adoptCandidate(repo, recordId, { ...request, request_id: id });
      const before = await registryRevision(repo);
      const collision = await adoptCandidate(repo, other.recordId, { ...request, request_id: id });
      assert.equal(collision.receipt.result, 'rejected');
      assert.equal(collision.rule.rule_id, first.rule.rule_id);
      const changed = await adoptCandidate(repo, recordId, { ...request, request_id: id, scope: 'user' });
      assert.equal(changed.receipt.result, 'rejected');
      const differentCandidate = await adoptCandidate(repo, recordId, { ...request, request_id: id, candidate_id: 'learning-999' });
      assert.equal(differentCandidate.receipt.result, 'rejected');
      const differentOperation = await revokeRule(repo, { request_id: id, rule_id: 'rule-0000000000000000', expected_revision: before });
      assert.equal(differentOperation.receipt.result, 'rejected');
      assert.equal(differentOperation.rule.rule_id, first.rule.rule_id);
      assert.equal(await registryRevision(repo), before);
    }
    await adoptCandidate(repo, other.recordId, { ...request, request_id: 'other-adopt' });
    const collision = await adoptCandidate(repo, other.recordId, request);
    assert.equal(collision.receipt.result, 'rejected');
    assert.equal(collision.rule.rule_id, first.rule.rule_id);
  });

  it('replays legacy hashes only for their original rule and action', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const request = adoptReq('learning-001', 'legacy-adopt', await revision(repo, recordId));
    const adopted = await adoptCandidate(repo, recordId, request);
    const { request_id: _adoptId, ...adoptPayload } = request;
    const revokeRequest = { request_id: 'legacy-revoke', rule_id: adopted.rule.rule_id, expected_revision: adopted.revision };
    await revokeRule(repo, revokeRequest);
    const { request_id: _revokeId, ...revokePayload } = revokeRequest;
    await transactRegistry(repo.paths, (doc) => ({ write: true, doc: { ...doc, request_log: doc.request_log.map((receipt) => ({
      request_id: receipt.request_id, at: receipt.at, result: receipt.result,
      payload_hash: stableHash(receipt.request_id === request.request_id ? adoptPayload : revokePayload),
    })) }, result: undefined }));
    const before = await registryRevision(repo);
    assert.equal((await adoptCandidate(repo, recordId, request)).duplicate, true);
    assert.equal((await revokeRule(repo, revokeRequest)).duplicate, true);
    const foreign = await adoptCandidate(repo, 'a'.repeat(64), request);
    assert.equal(foreign.receipt.result, 'rejected');
    assert.equal(foreign.rule.rule_id, adopted.rule.rule_id);
    assert.equal(await registryRevision(repo), before);
  });

  it('keeps receipts beyond the former retention limit through adopt and revoke writes', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const request = adoptReq('learning-001', 'early', await revision(repo, recordId));
    const adopted = await adoptCandidate(repo, recordId, request);
    const duplicateRequest = { ...request, request_id: 'early-duplicate' };
    const duplicate = await adoptCandidate(repo, recordId, duplicateRequest);
    await transactRegistry(repo.paths, (doc) => ({ write: true, doc: { ...doc, request_log: [
      ...doc.request_log,
      ...Array.from({ length: 500 }, (_, i) => ({ ...duplicate.receipt, request_id: `later-${String(i)}` })),
    ] }, result: undefined }));
    const later = await adoptCandidate(repo, recordId, { ...request, request_id: 'later-real' });
    const revoked = await revokeRule(repo, { request_id: 'revoke', rule_id: adopted.rule.rule_id, expected_revision: later.revision });
    assert.equal((await loadRegistry(repo.paths)).request_log.length, 504);
    for (const original of [request, duplicateRequest]) {
      const replay = await adoptCandidate(repo, recordId, original);
      assert.equal(replay.duplicate, true);
      assert.equal(replay.rule.status, 'revoked');
      assert.equal(replay.revision, revoked.revision);
    }
  });
});

describe('revoke and scope handling', () => {
  it('revoke flips the status, keeps replay semantics, and re-adoption reactivates', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await approve(repo, recordId, 'learning-001', 'ap1');
    const adopted = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a1', await revision(repo, recordId)));
    const revoked = await revokeRule(repo, {
      request_id: 'rv1',
      rule_id: adopted.rule.rule_id,
      expected_revision: adopted.revision,
      note: '不再适用',
    });
    assert.equal(revoked.rule.status, 'revoked');
    assert.deepEqual(revoked.rule.history.map((h) => h.action), ['adopted', 'revoked']);

    // an identical payload (note included) replays from the ledger, skipping the revision gate
    const replay = await revokeRule(repo, {
      request_id: 'rv1',
      rule_id: adopted.rule.rule_id,
      expected_revision: adopted.revision,
      note: '不再适用',
    });
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.receipt, revoked.receipt);

    await assert.rejects(
      () => revokeRule(repo, { request_id: 'rv2', rule_id: adopted.rule.rule_id, expected_revision: revoked.revision }),
      (err: unknown) => err instanceof ScaError && /already revoked/.test(err.message),
    );
    await assert.rejects(
      () => revokeRule(repo, { request_id: 'rv3', rule_id: 'rule-0000000000000000', expected_revision: revoked.revision }),
      (err: unknown) => err instanceof ScaError && err.code === 'schema_invalid',
    );

    // the approval still stands on the candidate, so re-adoption reactivates v1
    const again = await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a2', await revision(repo, recordId)));
    assert.equal(again.rule.status, 'active');
    assert.equal(again.rule.version, 1);
    assert.deepEqual(again.rule.history.map((h) => h.action), ['adopted', 'revoked', 'adopted']);
  });

  it('user scope survives project filtering, and detail reports deleted sources', async () => {
    const { repo, recordId } = await seeded(
      mkCandidate('learning-001'),
      mkCandidate('learning-002', { target: { kind: 'memory', scope: 'user' } }),
    );
    await approve(repo, recordId, 'learning-001', 'ap1');
    await approve(repo, recordId, 'learning-002', 'ap2');
    await adoptCandidate(repo, recordId, adoptReq('learning-001', 'a1', await revision(repo, recordId)));
    const userRule = await adoptCandidate(
      repo,
      recordId,
      adoptReq('learning-002', 'a2', await revision(repo, recordId), { scope: 'user' }),
    );
    assert.deepEqual(userRule.rule.scope, { kind: 'user' });

    const all = await listRules(repo);
    assert.equal(all.count, 2);
    const foreign = await listRules(repo, { workspace: '/some/other/project' });
    assert.deepEqual(foreign.rules.map((r) => r.rule_id), [userRule.rule.rule_id]);

    const detail = await ruleDetail(repo, userRule.rule.rule_id);
    assert.equal(detail.rule.content, 'content of learning-002 v1');
    assert.equal(detail.record_available, true);

    // revoke + list default filter hides revoked rules; --includeRevoked shows them
    await revokeRule(repo, { request_id: 'rv', rule_id: userRule.rule.rule_id, expected_revision: detail.revision });
    assert.equal((await listRules(repo)).count, 1);
    assert.equal((await listRules(repo, { includeRevoked: true })).count, 2);

    await fs.rm(path.join(repo.paths.recordsDir, recordId), { recursive: true, force: true });
    const orphan = await ruleDetail(repo, userRule.rule.rule_id);
    assert.equal(orphan.record_available, false);
  });
});

describe('cli adopt / rules (M4 surface)', () => {
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

  it('adopts, lists, reads detail and revokes through the CLI', async () => {
    const root = await tempDir('sca-adopt-cli-');
    const ws = await tempDir('sca-adopt-cli-ws-');
    const repo = new RecordRepository(root);
    const { recordId } = await repo.register({
      host: 'codex',
      canonicalWorkspace: ws,
      sessionId: 'adopt-cli-1',
      transcriptPath: CODEX_FIXTURE,
      trigger: 'manual_skill',
      analyzerVersion: '0.1.0',
    });
    const loaded = await repo.loadCandidates(recordId);
    await repo.updateCandidates(recordId, loaded, (doc) => ({ ...doc, candidates: [mkCandidate('learning-001')] }));
    await approve(repo, recordId, 'learning-001', 'ap1');

    const io = collectIo(root);
    const code = await runCli(
      ['adopt', recordId, '--candidate', 'learning-001', '--request', 'cli-a1', '--expected-revision', String(await revision(repo, recordId))],
      io.io,
    );
    assert.equal(code, 0);
    const view = JSON.parse(String(io.lines[0])) as {
      ok: boolean;
      registry_revision: number;
      rule: { rule_id: string; status: string; version: number };
    };
    assert.equal(view.ok, true);
    assert.equal(view.rule.status, 'active');
    const ruleId = view.rule.rule_id;

    const list = collectIo(root);
    assert.equal(await runCli(['rules'], list.io), 0);
    const listed = JSON.parse(String(list.lines[0])) as { exists: boolean; rules: { rule_id: string }[] };
    assert.equal(listed.exists, true);
    assert.equal(listed.rules.length, 1);

    const detail = collectIo(root);
    assert.equal(await runCli(['rules', '--rule', ruleId], detail.io), 0);
    assert.match(String(detail.lines[0]), /content of learning-001 v1/);

    const bad = collectIo(root);
    assert.equal(await runCli(['adopt', recordId, '--candidate', 'learning-001'], bad.io), 2);

    const revoke = collectIo(root);
    assert.equal(
      await runCli(
        ['rules', '--revoke', ruleId, '--request', 'cli-r1', '--expected-revision', String(view.registry_revision)],
        revoke.io,
      ),
      0,
    );
    const revokedView = JSON.parse(String(revoke.lines[0])) as { rule: { status: string } };
    assert.equal(revokedView.rule.status, 'revoked');
  });
});
