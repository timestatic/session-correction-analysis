import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { Candidate } from '../../../src/domain/candidates.js';
import {
  ACCEPTED_RULES_SCHEMA_ID,
  computeRuleId,
  initialRulesDocument,
  ruleContentHash,
  type Rule,
  type RuleAdoptRequest,
} from '../../../src/domain/rules.js';
import type { AcceptedRulesDocument } from '../../../src/domain/rules.js';
import type { ErrorCode, ScaError } from '../../../src/domain/errors.js';
import { stableHash } from '../../../src/domain/hash.js';
import { renderDocument, splitFrontmatter } from '../../../src/store/frontmatter.js';
import { acceptedRulesPath } from '../../../src/store/paths.js';
import { applyRuleMigration, planRuleMigration } from '../../../src/store/migration.js';
import {
  adoptApprovedCandidate,
  recoverPendingAcceptance,
  setAcceptanceCrashHook,
  type AdoptionCrashPoint,
} from '../../../src/store/acceptance.js';
import { RulesRepository } from '../../../src/store/rules.js';
import { RecordRepository } from '../../../src/store/repository.js';
import { withRegistryLock, withSessionLock } from '../../../src/store/lock.js';
import { applyDecision, contentVersionHash } from '../../../src/review/decide.js';
import { memoryContent } from '../../../src/publish/memory.js';
import { createPreview } from '../../../src/publish/preview.js';
import { makeCandidate } from '../domain/helpers.js';

/**
 * LC-02: registry storage, the cross-file adoption transaction with durable
 * pending recovery, and explicit migration. Everything runs against a temp data
 * root; nothing touches a real AGENTS file or memory store.
 */

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

interface Fixture {
  root: string;
  rules: RulesRepository;
  records: RecordRepository;
  recordId: string;
  workspace: string;
}

async function fixture(candidates: Candidate[] = [makeCandidate()]): Promise<Fixture> {
  const root = await tempDir('sca-rules-');
  const workspace = await tempDir('sca-rules-ws-');
  const records = new RecordRepository(root);
  const { recordId } = await records.register({
    host: 'codex',
    canonicalWorkspace: workspace,
    sessionId: 'rules-session-1',
    transcriptPath: path.join(workspace, 'rollout.jsonl'),
    analyzerVersion: '0.1.0',
    trigger: 'manual_skill',
    projectName: 'mytest',
  });
  const current = await records.loadCandidates(recordId);
  await records.updateCandidates(recordId, current, (doc) => ({ ...doc, candidates }));
  return { root, rules: new RulesRepository(root), records, recordId, workspace };
}

async function addRecord(fx: Fixture, sessionId: string, candidates: Candidate[]): Promise<string> {
  const { recordId } = await fx.records.register({
    host: 'codex',
    canonicalWorkspace: fx.workspace,
    sessionId,
    transcriptPath: path.join(fx.workspace, 'rollout.jsonl'),
    analyzerVersion: '0.1.0',
    trigger: 'manual_skill',
  });
  const current = await fx.records.loadCandidates(recordId);
  await fx.records.updateCandidates(recordId, current, (doc) => ({ ...doc, candidates }));
  return recordId;
}

async function approve(fx: Fixture, candidateId = 'learning-001', requestId = 'approve-1'): Promise<Candidate> {
  if ((await fx.rules.read()).state === 'absent') {
    try { await fx.rules.initialize(); } catch (error) { if ((error as ScaError).code !== 'migration_required') throw error; }
  }
  const revision = (await fx.records.loadCandidates(fx.recordId)).doc.revision;
  const outcome = await applyDecision(fx.records, fx.recordId, {
    request_id: requestId,
    candidate_id: candidateId,
    action: 'approve',
    expected_revision: revision,
  });
  return outcome.candidate;
}

async function adoptRequest(
  fx: Fixture,
  candidate: Candidate,
  overrides: Partial<RuleAdoptRequest> = {},
  recordId = fx.recordId,
): Promise<RuleAdoptRequest> {
  const revision = (await fx.records.loadCandidates(recordId)).doc.revision;
  return {
    request_id: 'adopt-1',
    record_id: recordId,
    candidate_id: candidate.id,
    expected_revision: revision,
    expected_candidate_content_hash: contentVersionHash(candidate),
    scope: { kind: 'project', canonical_workspace: fx.workspace, project_name: 'mytest' },
    confirmed: true,
    ...overrides,
  };
}

async function failWith(code: ErrorCode, fn: () => Promise<unknown>): Promise<ScaError> {
  try {
    await fn();
  } catch (err) {
    const error = err as ScaError;
    assert.equal(error.name, 'ScaError', `${code} expected, got ${String(error.message)}`);
    assert.equal(error.code, code);
    assert.ok(error.nextStep.length > 0, 'every error carries a next step');
    return error;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

async function registryDoc(fx: Fixture): Promise<AcceptedRulesDocument> {
  const read = await fx.rules.read();
  if (read.state !== 'ok') {
    throw new Error(`registry is ${read.state}`);
  }
  return read.doc;
}

function ruleOf(doc: AcceptedRulesDocument, recordId: string, candidateId: string): Rule {
  const rule = doc.rules.find((entry) => entry.rule_id === computeRuleId(recordId, candidateId));
  if (rule === undefined) {
    throw new Error(`no rule for ${candidateId}`);
  }
  return rule;
}

/** Runs the adoption with a thrown crash point, leaving the durable half-state. */
async function adoptCrashing(
  fx: Fixture,
  candidate: Candidate,
  point: AdoptionCrashPoint,
  overrides: Partial<RuleAdoptRequest> = {},
): Promise<void> {
  const request = await adoptRequest(fx, candidate, overrides);
  setAcceptanceCrashHook((fired) => {
    if (fired === point) {
      setAcceptanceCrashHook(undefined);
      throw new Error(`crash at ${point}`);
    }
  });
  try {
    await adoptApprovedCandidate({ rules: fx.rules, records: fx.records }, request);
  } catch (err) {
    if (!(err instanceof Error) || !/^crash at/.test(err.message)) {
      throw err;
    }
    return;
  } finally {
    setAcceptanceCrashHook(undefined);
  }
  throw new Error(`the crash hook at ${point} never fired`);
}

// --- registry storage --------------------------------------------------------

describe('accepted-rules registry storage', () => {
  it('reports a missing registry as uninitialized, never as zero rules', async () => {
    const fx = await fixture();
    assert.deepEqual(await fx.rules.read(), { state: 'absent' });
    const health = await fx.rules.status();
    assert.equal(health.state, 'absent');
    assert.equal(health.rule_count, null, 'a missing file must not be reported as an empty rule set');
    await failWith('rules_registry_missing', async () => fx.rules.readCommitted());
    assert.equal(await fs.stat(acceptedRulesPath(fx.rules.paths)).then(() => true, () => false), false);
  });

  it('creates an empty registry only on an explicit initialize', async () => {
    const fx = await fixture();
    const first = await fx.rules.initialize();
    assert.equal(first.created, true);
    assert.equal(first.doc.rules.length, 0);
    const second = await fx.rules.initialize();
    assert.equal(second.created, false, 'initialize never clobbers an existing registry');
    const health = await fx.rules.status();
    assert.equal(health.state, 'ok');
    assert.equal(health.rule_count, 0);
  });

  it('keeps the registry in the data root, never under runtime/', async () => {
    const fx = await fixture();
    await fx.rules.initialize();
    const filePath = acceptedRulesPath(fx.rules.paths);
    assert.equal(path.dirname(filePath), fx.rules.paths.root);
    assert.ok(!filePath.startsWith(fx.rules.paths.runtimeDir));
    assert.ok((await fs.readFile(filePath, 'utf8')).startsWith('---\n'));
  });

  it('treats an unparseable registry as corrupt instead of an empty set', async () => {
    const fx = await fixture();
    await fs.writeFile(acceptedRulesPath(fx.rules.paths), '---\nschema: broken\n  : :\n---\n\nbody\n', 'utf8');
    const health = await fx.rules.status();
    assert.equal(health.state, 'corrupt');
    assert.equal(health.rule_count, null);
    assert.equal(health.error?.code, 'schema_invalid');
    await failWith('schema_invalid', async () => fx.rules.readCommitted());
    await failWith('schema_invalid', async () => fx.rules.initialize());
    const still = await fs.readFile(acceptedRulesPath(fx.rules.paths), 'utf8');
    assert.match(still, /schema: broken/, 'a corrupt registry is never overwritten by an initializer');
  });

  it('refuses to write a registry whose schema id it does not know', async () => {
    const fx = await fixture();
    const doc = { ...initialRulesDocument(NOW), schema: 'session-correction-analysis/accepted-rules/v2' } as unknown as AcceptedRulesDocument;
    await fs.writeFile(acceptedRulesPath(fx.rules.paths), renderDocument(doc, '# x\n'), 'utf8');
    const health = await fx.rules.status();
    assert.equal(health.state, 'corrupt');
    assert.match(health.error?.message ?? '', /accepted-rules\/v2/);
    await failWith('schema_invalid', async () => fx.rules.transact((current) => ({ write: true, doc: current, result: null })));
  });

  it('refuses an oversized registry before parsing it, and never reads it as empty', async () => {
    const fx = await fixture();
    await fx.rules.initialize();
    const tooBig = await tempDir('sca-rules-big-');
    const repo = new RulesRepository(tooBig);
    await fs.writeFile(
      acceptedRulesPath(repo.paths),
    `---\nschema: ${ACCEPTED_RULES_SCHEMA_ID}\nrevision: 1\nupdated_at: ${NOW}\nrules: []\nrequest_log: []\npending_acceptance: null\npadding: "${'x'.repeat(4096)}"\n---\n\n# x\n`,
      'utf8',
    );
    const read = await repo.read({ maxBytes: 256 });
    assert.equal(read.state, 'corrupt');
    assert.ok(read.state === 'corrupt' && read.error.code === 'payload_too_large');
    const health = await repo.status({ maxBytes: 256 });
    assert.equal(health.rule_count, null);
    assert.deepEqual((await fx.rules.status()).state, 'ok');
  });

  it('regenerates the projection deterministically and keeps User Notes', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const outcome = await adoptApprovedCandidate(
      { rules: fx.rules, records: fx.records },
      await adoptRequest(fx, candidate),
    );
    const filePath = acceptedRulesPath(fx.rules.paths);
    const committed = await fs.readFile(filePath, 'utf8');
    assert.match(committed, /# Accepted Rules/);
    assert.match(committed, new RegExp(`## ${outcome.rule.rule_id}`));
    assert.match(committed, /历史/);

    await fs.writeFile(
      filePath,
      `${committed.split('## User Notes')[0]}## User Notes\n\n手工备注：保留我。\n`,
      'utf8',
    );
    const rewritten = await fx.rules.transact((doc) => ({
      write: true,
      doc: { ...doc, extensions: { note: 'touched' } },
      result: null,
    }));
    const body = splitFrontmatter(await fs.readFile(filePath, 'utf8')).body;
    assert.match(body, /手工备注：保留我。/);
    assert.equal(rewritten.file.doc.revision, 3, 'pending marker write keeps the revision, the commit bumps it');
    // The projection is a pure function of the frontmatter: same doc, same bytes.
    const again = await fx.rules.transact((doc) => ({ write: true, doc, result: null }));
    const first = splitFrontmatter(await fs.readFile(filePath, 'utf8')).body;
    await fx.rules.transact((doc) => ({ write: true, doc: { ...doc, extensions: { note: 'touched' } }, result: null }));
    const second = splitFrontmatter(await fs.readFile(filePath, 'utf8')).body;
    const omitMutableHeader = (body: string) => body.split('\n').filter(line => !line.startsWith('- 清单版本：') && !line.startsWith('- 最近更新：')).join('\n');
    assert.equal(omitMutableHeader(first), omitMutableHeader(second));
    assert.ok(again.file.doc.rules.length === 1);
  });

  it('refuses a registry write that does not hold the registry lock', async () => {
    const fx = await fixture();
    await fx.rules.initialize();
    const doc = await registryDoc(fx);
    await failWith('internal_error', async () => fx.rules.writeUnlocked(doc));
    await assert.rejects(withSessionLock(fx.rules.paths, fx.recordId, () => fx.rules.loadUnlocked()), /lock/i);
  });

  it('refuses to take the registry lock while the session lock is held', async () => {
    const fx = await fixture();
    await fx.rules.initialize();
    const error = await failWith('internal_error', async () =>
      withSessionLock(fx.rules.paths, fx.recordId, () => withRegistryLock(fx.rules.paths, () => 1)),
    );
    assert.match(error.message, /lock order/);
    // The legal nesting order (registry -> session -> target) stays available.
    const nested = await withRegistryLock(fx.rules.paths, () =>
      withSessionLock(fx.rules.paths, fx.recordId, () => 1),
    );
    assert.equal(nested, 1);
  });
});

// --- adoption transaction ----------------------------------------------------

describe('adopting an approved candidate into the registry', () => {
  it('commits one active rule, links the candidate and clears the pending marker', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const outcome = await adoptApprovedCandidate(
      { rules: fx.rules, records: fx.records },
      await adoptRequest(fx, candidate),
    );

    assert.equal(outcome.receipt.result, 'applied');
    assert.equal(outcome.replayed, false);
    const doc = await registryDoc(fx);
    assert.equal(doc.rules.length, 1);
    assert.equal(doc.pending_acceptance, null);
    assert.equal(doc.request_log.length, 1);

    const rule = outcome.rule;
    assert.equal(rule.rule_id, computeRuleId(fx.recordId, candidate.id));
    assert.equal(rule.status, 'active');
    assert.equal(rule.version, 1);
    assert.equal(rule.content, candidate.proposed_content);
    assert.equal(rule.title, candidate.title);
    assert.equal(rule.content_hash, ruleContentHash({ content: candidate.proposed_content, scope: rule.scope }));
    assert.equal(rule.accepted_at, candidate.decision?.at, 'accepted_at is the real approval time');
    assert.equal(rule.delivery, null, 'adoption is not persistence');
    assert.equal(rule.source.record_id, fx.recordId);
    assert.equal(rule.source.candidate_id, candidate.id);
    assert.equal(rule.source.candidate_path, `records/${fx.recordId}/learning_candidates.md`);
    assert.equal(rule.source.candidate_content_hash, contentVersionHash(candidate));
    assert.equal(rule.source.accepted_request_id, 'adopt-1');
    assert.equal(rule.history[0]?.action, 'accepted');
    assert.equal(rule.history[0]?.version, 1);
    assert.equal(rule.history[0]?.request_id, 'adopt-1');

    const stored = ruleOf(doc, fx.recordId, candidate.id);
    assert.deepEqual(stored, rule);
    assert.ok(await fx.rules.read().then((r) => r.state === 'ok'));

    const after = (await fx.records.loadCandidates(fx.recordId)).doc;
    const linked = after.candidates.find((entry) => entry.id === candidate.id);
    assert.equal(linked?.rule_ref?.rule_id, rule.rule_id);
    assert.equal(linked?.rule_ref?.accepted_version, 1);
    assert.equal(linked?.rule_ref?.candidate_content_hash, contentVersionHash(candidate));
    assert.equal(linked?.rule_ref?.request_id, 'adopt-1');
    assert.equal(linked?.status, 'approved', 'adoption never changes the candidate review status');
    assert.equal(linked?.decision?.action, 'approve', 'the approve decision record stays in place');
  });

  it('adopts the first rule into an explicitly initialized registry', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    assert.equal((await fx.rules.read()).state, 'ok');
    const outcome = await adoptApprovedCandidate(
      { rules: fx.rules, records: fx.records },
      await adoptRequest(fx, candidate),
    );
    assert.equal(outcome.receipt.result, 'applied');
    assert.equal((await registryDoc(fx)).rules.length, 1);
  });

  it('replays the same request id with the same payload without a second rule', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const request = await adoptRequest(fx, candidate);
    const deps = { rules: fx.rules, records: fx.records };
    const first = await adoptApprovedCandidate(deps, request);
    const second = await adoptApprovedCandidate(deps, request);

    assert.equal(second.receipt.result, 'duplicate');
    assert.equal(second.receipt.at, first.receipt.at);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.rule, first.rule);
    const doc = await registryDoc(fx);
    assert.equal(doc.rules.length, 1);
    assert.equal(doc.request_log.length, 1);
    const candidates = await fx.records.loadCandidates(fx.recordId);
    assert.equal(candidates.doc.revision, first.candidateRevision, 'a replay never bumps the session revision');
  });

  it('rejects the same request id with a different payload and writes nothing', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const deps = { rules: fx.rules, records: fx.records };
    const request = await adoptRequest(fx, candidate);
    await adoptApprovedCandidate(deps, request);
    const before = await registryDoc(fx);

    await failWith('request_conflict', async () =>
      adoptApprovedCandidate(deps, { ...request, note: '换一个 payload 重试' }),
    );
    const after = await registryDoc(fx);
    assert.deepEqual(after.rules, before.rules);
    assert.equal(after.request_log.length, before.request_log.length);
  });

  it('checks idempotency before the revision, so a replay survives a later session edit', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const deps = { rules: fx.rules, records: fx.records };
    const request = await adoptRequest(fx, candidate);
    await adoptApprovedCandidate(deps, request);

    // An unrelated decision moves the candidate revision after the adoption.
    const current = await fx.records.loadCandidates(fx.recordId);
    await fx.records.updateCandidates(fx.recordId, current, doc => ({ ...doc, extensions: { test_note: 'unrelated' } }));
    const second = await adoptApprovedCandidate(deps, request);
    assert.equal(second.receipt.result, 'duplicate');
    assert.equal(second.replayed, true);
  });

  it('refuses a stale expected_revision before any write', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const request = await adoptRequest(fx, candidate, { expected_revision: 1 });
    await failWith('revision_conflict', async () =>
      adoptApprovedCandidate({ rules: fx.rules, records: fx.records }, request),
    );
    assert.equal((await registryDoc(fx)).rules.length, 0, 'rejected request added no rules');
  });

  it('refuses to adopt a candidate that is not approved', async () => {
    const fx = await fixture();
    await fx.rules.initialize();
    const proposed = (await fx.records.loadCandidates(fx.recordId)).doc.candidates[0];
    if (proposed === undefined) {
      throw new Error('fixture lost its candidate');
    }
    await failWith('approval_missing', async () =>
      adoptApprovedCandidate(
        { rules: fx.rules, records: fx.records },
        await adoptRequest(fx, proposed),
      ),
    );
  });

  it('refuses when the approval no longer binds the content being adopted', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const revision = (await fx.records.loadCandidates(fx.recordId)).doc.revision;
    await applyDecision(fx.records, fx.recordId, {
      request_id: 'edit-1',
      candidate_id: candidate.id,
      action: 'edit_content',
      expected_revision: revision,
      content: '改写后的新内容',
    });
    const edited = (await fx.records.loadCandidates(fx.recordId)).doc.candidates[0];
    if (edited === undefined) {
      throw new Error('fixture lost its candidate');
    }
    await failWith('approval_missing', async () =>
      adoptApprovedCandidate(
        { rules: fx.rules, records: fx.records },
        await adoptRequest(fx, edited, { expected_candidate_content_hash: contentVersionHash(edited) }),
      ),
    );
    // And a request pinned to the *old* content version is refused as stale too.
    await failWith('approval_missing', async () =>
      adoptApprovedCandidate(
        { rules: fx.rules, records: fx.records },
        await adoptRequest(fx, candidate),
      ),
    );
    assert.equal((await registryDoc(fx)).rules.length, 0);
  });

  it('refuses a project scope that the session cannot prove', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    await failWith('rule_scope_unknown', async () =>
      adoptApprovedCandidate(
        { rules: fx.rules, records: fx.records },
        await adoptRequest(fx, candidate, {
          scope: { kind: 'project', canonical_workspace: '/somewhere/else' },
        }),
      ),
    );
    // An explicit user scope is the user's own statement, so it is accepted.
    const outcome = await adoptApprovedCandidate(
      { rules: fx.rules, records: fx.records },
      await adoptRequest(fx, candidate, { scope: { kind: 'user', note: '所有项目通用' } }),
    );
    assert.equal(outcome.rule.scope.kind, 'user');
  });

  it('rejects an unconfirmed request and an unknown candidate', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const deps = { rules: fx.rules, records: fx.records };
    await failWith('schema_invalid', async () =>
      adoptApprovedCandidate(deps, { ...(await adoptRequest(fx, candidate)), confirmed: false }),
    );
    await failWith('schema_invalid', async () =>
      adoptApprovedCandidate(deps, { ...(await adoptRequest(fx, candidate)), candidate_id: 'learning-999' }),
    );
    await failWith('schema_invalid', async () => adoptApprovedCandidate(deps, { request_id: 'x' }));
  });

  it('refuses to update an adopted rule through the historical candidate', async () => {
    const fx = await fixture();
    const first = await approve(fx);
    const deps = { rules: fx.rules, records: fx.records };
    const v1 = await adoptApprovedCandidate(deps, await adoptRequest(fx, first));

    const revision = (await fx.records.loadCandidates(fx.recordId)).doc.revision;
    await failWith('unsupported_operation', () => applyDecision(fx.records, fx.recordId, {
      request_id: 'edit-2',
      candidate_id: first.id,
      action: 'edit_content',
      expected_revision: revision,
      content: '第二次批准的内容',
    }));
    await failWith('unsupported_operation', () => memoryContent(fx.records, fx.recordId, first.id, 'copy_content'));
    await failWith('unsupported_operation', () => createPreview(fx.records, fx.recordId, { candidateId: first.id }));
    assert.equal((await fx.records.loadCandidates(fx.recordId)).doc.candidates[0]?.proposed_content, first.proposed_content);
    assert.deepEqual((await registryDoc(fx)).rules, [v1.rule]);
  });

  it('adopts two approved candidates from one record as two rules', async () => {
    const fx = await fixture([
      makeCandidate(),
      makeCandidate({ id: 'learning-002', title: '第二条', proposed_content: '另一条规则内容' }),
    ]);
    const one = await approve(fx, 'learning-001', 'approve-1');
    const two = await approve(fx, 'learning-002', 'approve-2');
    const deps = { rules: fx.rules, records: fx.records };
    const a = await adoptApprovedCandidate(deps, await adoptRequest(fx, one, { request_id: 'adopt-1' }));
    const b = await adoptApprovedCandidate(deps, await adoptRequest(fx, two, { request_id: 'adopt-2' }));
    assert.notEqual(a.rule.rule_id, b.rule.rule_id);
    const doc = await registryDoc(fx);
    assert.equal(doc.rules.length, 2);
    assert.equal(doc.request_log.length, 2);
    assert.equal(doc.revision, 3, 'each committed adoption is one revision');
  });
});

// --- durable pending recovery ------------------------------------------------

describe('recovering an interrupted adoption', () => {
  it('leaves nothing durable when it dies before the pending marker', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const request = await adoptRequest(fx, candidate);
    setAcceptanceCrashHook((point) => {
      if (point === 'before_pending') {
        setAcceptanceCrashHook(undefined);
        throw new Error('crash at before_pending');
      }
    });
    await assert.rejects(() =>
      adoptApprovedCandidate({ rules: fx.rules, records: fx.records }, request),
    );
    setAcceptanceCrashHook(undefined);
    assert.equal((await registryDoc(fx)).rules.length, 0);
    assert.equal((await fx.records.loadCandidates(fx.recordId)).doc.candidates[0]?.rule_ref, undefined);

    const outcome = await adoptApprovedCandidate({ rules: fx.rules, records: fx.records }, request);
    assert.equal(outcome.receipt.result, 'applied');
    assert.equal(outcome.recovered, false, 'nothing was durable, so the retry is a fresh apply');
    assert.equal((await registryDoc(fx)).rules.length, 1);
  });

  it('finishes both sides when it dies right after the pending marker', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    await adoptCrashing(fx, candidate, 'after_pending');

    const stuck = await registryDoc(fx);
    assert.equal(stuck.rules.length, 0, 'the pending delta is not exposed as committed');
    assert.equal(stuck.pending_acceptance?.rule_id, computeRuleId(fx.recordId, candidate.id));
    assert.equal(
      stuck.pending_acceptance?.delta.rule.content_hash,
      ruleContentHash({ content: candidate.proposed_content, scope: { kind: 'project', canonical_workspace: fx.workspace, project_name: 'mytest' } }),
    );
    assert.equal(stuck.pending_acceptance?.delta.kind, 'add');
    assert.equal(stuck.pending_acceptance?.candidate_expected_revision, (await fx.records.loadCandidates(fx.recordId)).doc.revision);
    assert.equal(stuck.revision, 1, 'the marker write keeps the committed revision');
    assert.equal(
      (await fx.records.loadCandidates(fx.recordId)).doc.candidates[0]?.rule_ref,
      undefined,
    );
    const health = await fx.rules.status();
    assert.equal(health.state, 'ok');
    assert.equal(health.recoverable, false, 'diagnostic status does not promise recovery without verifying both sides');
    assert.equal(health.pending_rule_id, stuck.pending_acceptance?.rule_id ?? null);

    const report = await recoverPendingAcceptance({ rules: fx.rules, records: fx.records });
    assert.equal(report.state, 'recovered');
    const done = await registryDoc(fx);
    assert.equal(done.pending_acceptance, null);
    assert.equal(done.rules.length, 1);
    assert.equal(done.rules[0]?.content, candidate.proposed_content);
    assert.equal(done.request_log[0]?.request_id, 'adopt-1');
    assert.equal(
      (await fx.records.loadCandidates(fx.recordId)).doc.candidates[0]?.rule_ref?.rule_id,
      done.rules[0]?.rule_id,
    );
    assert.deepEqual(done.rules[0], ruleOf(await registryDoc(fx), fx.recordId, candidate.id));
  });

  it('finishes only the registry when the candidate side already landed', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    await adoptCrashing(fx, candidate, 'after_candidate');

    const stuck = await registryDoc(fx);
    assert.equal(stuck.pending_acceptance?.rule_id, computeRuleId(fx.recordId, candidate.id));
    assert.equal(stuck.rules.length, 0);
    const sessionBefore = await fx.records.loadCandidates(fx.recordId);
    assert.equal(sessionBefore.doc.candidates[0]?.rule_ref?.rule_id, stuck.pending_acceptance?.rule_id);

    const report = await recoverPendingAcceptance({ rules: fx.rules, records: fx.records });
    assert.equal(report.state, 'recovered');
    assert.equal(report.registry_only, true);
    const sessionAfter = await fx.records.loadCandidates(fx.recordId);
    assert.equal(sessionAfter.fileHash, sessionBefore.fileHash, 'recovery never rewrites the session side');
    const done = await registryDoc(fx);
    assert.equal(done.rules.length, 1);
    assert.equal(done.pending_acceptance, null);
  });

  it('is idempotent: recovering a finished adoption reports clean', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const deps = { rules: fx.rules, records: fx.records };
    await adoptApprovedCandidate(deps, await adoptRequest(fx, candidate));
    assert.deepEqual(await recoverPendingAcceptance(deps), { state: 'clean' });
    assert.equal((await registryDoc(fx)).rules.length, 1);
  });

  it('stops and keeps the conflict when the candidate moved on', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    await adoptCrashing(fx, candidate, 'after_pending');
    const before = await fs.readFile(acceptedRulesPath(fx.rules.paths), 'utf8');

    const revision = (await fx.records.loadCandidates(fx.recordId)).doc.revision;
    await applyDecision(fx.records, fx.recordId, {
      request_id: 'edit-later',
      candidate_id: candidate.id,
      action: 'edit_content',
      expected_revision: revision,
      content: '用户在崩溃窗口里改了内容',
    });

    await failWith('rule_acceptance_recovery_failed', async () =>
      recoverPendingAcceptance({ rules: fx.rules, records: fx.records }),
    );
    assert.equal(await fs.readFile(acceptedRulesPath(fx.rules.paths), 'utf8'), before);
    const health = await fx.rules.status();
    assert.notEqual(health.pending_rule_id, null, 'the pending marker is kept for a human to resolve');
    assert.equal(health.recoverable, false, 'a reader must be able to tell maintenance from a resumable pending');
    assert.equal(health.error?.code, 'rule_acceptance_recovery_failed');
    const stored = (await fx.records.loadCandidates(fx.recordId)).doc.candidates[0];
    assert.equal(stored?.rule_ref, undefined, 'the user edit was never overwritten');
    assert.equal(stored?.proposed_content, '用户在崩溃窗口里改了内容');
  });

  it('stops when an external edit broke the registry baseline', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    await adoptCrashing(fx, candidate, 'after_pending');
    const stuck = await registryDoc(fx);
    const intruderContent = '与本次采纳无关的外部规则';
    const intruderHash = ruleContentHash({ content: intruderContent, scope: { kind: 'user' } });
    const intruder: Rule = {
      rule_id: computeRuleId('f'.repeat(64), 'learning-001'),
      title: '外部插入的规则',
      content: intruderContent,
      scope: { kind: 'user' },
      status: 'active',
      version: 1,
      content_hash: intruderHash,
      accepted_at: NOW,
      version_effective_at: NOW,
      source: {
        record_id: 'f'.repeat(64),
        candidate_id: 'learning-001',
        candidate_path: 'records/other/learning_candidates.md',
        candidate_content_hash: stableHash('other record'),
      },
      delivery: null,
      history: [{ at: NOW, action: 'accepted', version: 1, content_hash: intruderHash }],
      updated_at: NOW,
    };
    const edited: AcceptedRulesDocument = { ...stuck, rules: [intruder] };
    await fs.writeFile(acceptedRulesPath(fx.rules.paths), renderDocument(edited, '# hand edited\n'), 'utf8');

    await failWith('registry_changed', async () =>
      recoverPendingAcceptance({ rules: fx.rules, records: fx.records }),
    );
    const after = await registryDoc(fx);
    assert.equal(after.rules.length, 1, 'the external rule survives');
    assert.equal(after.rules[0]?.rule_id, intruder.rule_id);
    assert.equal(after.pending_acceptance?.rule_id, stuck.pending_acceptance?.rule_id);
  });

  it('refuses every further adoption write while a pending is unrecoverable', async () => {
    const fx = await fixture([
      makeCandidate(),
      makeCandidate({ id: 'learning-002', proposed_content: '另一条内容' }),
    ]);
    const stuck = await approve(fx, 'learning-001', 'approve-1');
    await adoptCrashing(fx, stuck, 'after_pending');
    const revision = (await fx.records.loadCandidates(fx.recordId)).doc.revision;
    await applyDecision(fx.records, fx.recordId, {
      request_id: 'revoke-first',
      candidate_id: 'learning-001',
      action: 'revoke',
      expected_revision: revision,
    });

    const other = await approve(fx, 'learning-002', 'approve-2');
    await failWith('rule_acceptance_recovery_failed', async () =>
      adoptApprovedCandidate(
        { rules: fx.rules, records: fx.records },
        await adoptRequest(fx, other, { request_id: 'adopt-2' }),
      ),
    );
    assert.equal((await registryDoc(fx)).rules.length, 0);
  });

  it('recovers the historical pending first, then applies the new request', async () => {
    const fx = await fixture([
      makeCandidate(),
      makeCandidate({ id: 'learning-002', proposed_content: '另一条内容' }),
    ]);
    const first = await approve(fx, 'learning-001', 'approve-1');
    const second = await approve(fx, 'learning-002', 'approve-2');
    await adoptCrashing(fx, first, 'after_pending');
    await recoverPendingAcceptance({ rules: fx.rules, records: fx.records });
    const outcome = await adoptApprovedCandidate(
      { rules: fx.rules, records: fx.records },
      await adoptRequest(fx, second, { request_id: 'adopt-2' }),
    );
    assert.equal(outcome.recovered, false, 'reader already recovered before preparing the new request');
    const doc = await registryDoc(fx);
    assert.equal(doc.rules.length, 2);
    assert.equal(doc.pending_acceptance, null);
    assert.ok(doc.rules.some((rule) => rule.rule_id === computeRuleId(fx.recordId, 'learning-001')));
    assert.ok(doc.rules.some((rule) => rule.rule_id === computeRuleId(fx.recordId, 'learning-002')));
  });
});

// --- explicit migration ------------------------------------------------------

describe('rules migrate', () => {
  it('plans every legacy disposition without writing anything', async () => {
    const fx = await fixture([
      makeCandidate(),
      makeCandidate({ id: 'learning-002', proposed_content: '未批准的内容' }),
      makeCandidate({ id: 'learning-003', proposed_content: '批准失效的内容' }),
      makeCandidate({
        id: 'learning-004',
        proposed_content: '有回执无批准时间',
        status: 'published',
        decision: null,
        publication: { published: true, result: 'success', published_at: NOW, attempts: [] },
      }),
    ]);
    const approved = await approve(fx, 'learning-001', 'approve-1');
    const rev = (await fx.records.loadCandidates(fx.recordId)).doc.revision;
    await applyDecision(fx.records, fx.recordId, {
      request_id: 'approve-3',
      candidate_id: 'learning-003',
      action: 'approve',
      expected_revision: rev,
    });
    // A legacy record whose body moved after the approval: the approval no longer binds it.
    const stale = await fx.records.loadCandidates(fx.recordId);
    await fx.records.updateCandidates(fx.recordId, stale, (doc) => ({
      ...doc,
      candidates: doc.candidates.map((entry) =>
        entry.id === 'learning-003' ? { ...entry, proposed_content: '批准之后又被改写的正文' } : entry,
      ),
    }));

    const plan = await planRuleMigration(
      { rules: fx.rules, records: fx.records },
      { mode: 'dry_run', expected_revision: 1 },
    );
    const byId = new Map(plan.items.map((item) => [item.candidate_id, item]));
    assert.equal(byId.size, 4);
    const imported = byId.get('learning-001');
    assert.equal(imported?.disposition, 'import');
    assert.equal(imported?.rule_id, computeRuleId(fx.recordId, 'learning-001'));
    assert.equal(imported?.accepted_at, approved.decision?.at);
    assert.equal(imported?.candidate_content_hash, contentVersionHash(approved));
    if (imported?.proposed_scope?.kind !== 'project') {
      throw new Error('a session workspace proves a project scope');
    }
    assert.equal(imported.proposed_scope.canonical_workspace, fx.workspace);
    assert.equal(imported.proposed_scope.project_name, 'mytest');
    assert.equal(byId.get('learning-002')?.disposition, 'skip_unapproved');
    assert.equal(byId.get('learning-002')?.rule_id, undefined);
    assert.equal(byId.get('learning-003')?.disposition, 'skip_approval_stale');
    assert.equal(byId.get('learning-004')?.disposition, 'needs_review_missing_time');
    assert.equal(byId.get('learning-004')?.rule_id, undefined);
    assert.equal(byId.get('learning-004')?.proposed_scope, undefined);
    assert.deepEqual(plan.counts, { import: 1, skipped: 2, needs_review: 1 });
    assert.equal(plan.mode, 'dry_run');
    assert.equal(plan.backup_dir, undefined);

    assert.equal((await fx.rules.read()).state, 'absent');
    const after = await fx.records.loadCandidates(fx.recordId);
    assert.ok(after.doc.candidates.every((entry) => entry.rule_ref === undefined));
  });

  it('single-lines a record whose project scope cannot be proven instead of inventing one', async () => {
    const fx = await fixture();
    await approve(fx);
    const strip = await fx.records.loadAnalyze(fx.recordId);
    await fx.records.updateAnalyze(fx.recordId, strip, (doc) => {
      const { workspace: _drop, project_name: _dropName, ...rest } = doc;
      return rest;
    });
    const plan = await planRuleMigration(
      { rules: fx.rules, records: fx.records },
      { mode: 'dry_run', expected_revision: 1 },
    );
    assert.equal(plan.items[0]?.disposition, 'needs_review_missing_scope');
    assert.equal(plan.items[0]?.rule_id, undefined);
    assert.equal(plan.items[0]?.proposed_scope, undefined);
    assert.equal(plan.counts.import, 0);
  });

  it('lists an adopted candidate as already migrated and never re-imports it', async () => {
    const fx = await fixture([makeCandidate(), makeCandidate({ id: 'learning-002' })]);
    const deps = { rules: fx.rules, records: fx.records };
    const adopted = await adoptApprovedCandidate(
      deps,
      await adoptRequest(fx, await approve(fx, 'learning-001', 'approve-1')),
    );
    const plan = await planRuleMigration(deps, {
      mode: 'dry_run',
      expected_revision: (await registryDoc(fx)).revision,
    });
    const byId = new Map(plan.items.map((item) => [item.candidate_id, item]));
    assert.equal(byId.get('learning-001')?.disposition, 'skip_already_migrated');
    assert.equal(byId.get('learning-001')?.rule_id, adopted.rule.rule_id);
    assert.equal(byId.get('learning-002')?.disposition, 'skip_unapproved');
    assert.equal(plan.counts.import, 0);
  });

  it('applies the plan in batches, backs the affected records up and keeps old receipts', async () => {
    const fx = await fixture([
      makeCandidate(),
      makeCandidate({ id: 'learning-002', proposed_content: '第二条内容' }),
      makeCandidate({ id: 'learning-003', proposed_content: '第三条内容' }),
    ]);
    const approvedOne = await approve(fx, 'learning-001', 'approve-1');
    const approvedTwo = await approve(fx, 'learning-002', 'approve-2');
    const approvedThree = await approve(fx, 'learning-003', 'approve-3');
    const approvalTimes = new Map(
      [approvedOne, approvedTwo, approvedThree].map((c) => [c.id, c.decision?.at]),
    );
    const deps = { rules: fx.rules, records: fx.records };
    const candidatesPath = fx.records.candidatesPath(fx.recordId);
    const beforeText = await fs.readFile(candidatesPath, 'utf8');
    const backup = await tempDir('sca-migrate-backup-');

    const applied = await applyRuleMigration(deps, {
      mode: 'apply',
      expected_revision: 1,
      backup_dir: backup,
      batch_size: 2,
    });
    assert.equal(applied.plan.counts.import, 3);
    assert.equal(applied.imported.length, 3);
    assert.equal(applied.batches, 2, '3 imports at batch_size 2 commit in two rounds');

    const doc = await registryDoc(fx);
    assert.equal(doc.rules.length, 3);
    assert.equal(doc.pending_acceptance, null);
    assert.equal(doc.request_log.length, 3);
    for (const rule of doc.rules) {
      assert.equal(rule.accepted_at, approvalTimes.get(rule.source.candidate_id), 'every imported rule carries a real approval time');
      assert.equal(rule.delivery, null);
      assert.equal(rule.source.candidate_path, `records/${fx.recordId}/learning_candidates.md`);
    }

    assert.equal(
      await fs.readFile(path.join(backup, 'records', fx.recordId, 'learning_candidates.md'), 'utf8'),
      beforeText,
      'the backup holds the exact pre-migration Markdown',
    );
    const after = await fx.records.loadCandidates(fx.recordId);
    for (const candidate of after.doc.candidates) {
      assert.notEqual(candidate.rule_ref, undefined);
      assert.equal(candidate.decision?.action, 'approve', 'migration never rewrites the approval');
      assert.equal(candidate.evidence.length, 1, 'old evidence ids survive');
      assert.equal(candidate.publication.published, false);
    }
  });

  it('runs twice without importing anything twice', async () => {
    const fx = await fixture();
    await approve(fx);
    const deps = { rules: fx.rules, records: fx.records };
    const first = await applyRuleMigration(deps, {
      mode: 'apply',
      expected_revision: 1,
      backup_dir: await tempDir('sca-migrate-backup-'),
    });
    assert.equal(first.imported.length, 1);
    const revision = (await registryDoc(fx)).revision;

    const second = await planRuleMigration(deps, { mode: 'dry_run', expected_revision: revision });
    assert.equal(second.counts.import, 0);
    assert.equal(second.items[0]?.disposition, 'skip_already_migrated');
    assert.equal(second.items[0]?.rule_id, first.imported[0]?.rule_id);

    const appliedAgain = await applyRuleMigration(deps, {
      mode: 'apply',
      expected_revision: revision,
      backup_dir: await tempDir('sca-migrate-backup-'),
    });
    assert.equal(appliedAgain.imported.length, 0);
    assert.equal((await registryDoc(fx)).rules.length, 1);
    assert.equal((await registryDoc(fx)).revision, revision, 'a no-op migration never writes the registry');
  });

  it('filters by record_ids and refuses a stale apply', async () => {
    const fx = await fixture([makeCandidate(), makeCandidate({ id: 'learning-002' })]);
    const other = await addRecord(fx, 'rules-session-2', [makeCandidate({ id: 'learning-009' })]);
    await approve(fx, 'learning-001', 'approve-1');
    await approve(fx, 'learning-002', 'approve-2');
    const deps = { rules: fx.rules, records: fx.records };

    const scoped = await planRuleMigration(deps, {
      mode: 'dry_run',
      expected_revision: 1,
      record_ids: [fx.recordId],
    });
    assert.equal(scoped.items.length, 2);
    assert.ok(scoped.items.every((item) => item.record_id === fx.recordId));
    const whole = await planRuleMigration(deps, { mode: 'dry_run', expected_revision: 1 });
    assert.ok(whole.items.some((item) => item.record_id === other));

    await applyRuleMigration(deps, {
      mode: 'apply',
      expected_revision: 1,
      backup_dir: await tempDir('sca-migrate-backup-'),
      record_ids: [fx.recordId],
    });
    assert.equal((await registryDoc(fx)).rules.length, 2);
    await failWith('revision_conflict', async () =>
      applyRuleMigration(deps, {
        mode: 'apply',
        expected_revision: 1,
        backup_dir: await tempDir('sca-migrate-backup-'),
        record_ids: [other],
      }),
    );
    assert.equal((await registryDoc(fx)).rules.length, 2);
  });

  it('reports a record whose analysis file is gone as needs_review_source_missing', async () => {
    const fx = await fixture();
    await approve(fx);
    const deps = { rules: fx.rules, records: fx.records };
    await fs.rm(fx.records.analyzePath(fx.recordId));
    const plan = await planRuleMigration(deps, { mode: 'dry_run', expected_revision: 1 });
    assert.equal(plan.items[0]?.disposition, 'needs_review_source_missing');
    assert.equal(plan.items[0]?.rule_id, undefined);
    assert.equal(plan.items[0]?.proposed_scope, undefined);
    assert.equal(plan.counts.import, 0);

    const applied = await applyRuleMigration(deps, {
      mode: 'apply',
      expected_revision: 1,
      backup_dir: await tempDir('sca-migrate-backup-'),
    });
    assert.deepEqual(applied.imported, []);
    assert.equal((await registryDoc(fx)).rules.length, 0, 'nothing importable means no new rules');
  });
});

describe('registry write boundaries', () => {
  it('does not rebuild a deleted authoritative registry from existing approvals', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    await fs.unlink(acceptedRulesPath(fx.rules.paths));
    await failWith('migration_required', () => fx.rules.initialize());
    await failWith('migration_required', async () => adoptApprovedCandidate({ rules: fx.rules, records: fx.records }, await adoptRequest(fx, candidate)));
    assert.deepEqual(await fx.rules.read(), { state: 'absent' });
  });

  it('refuses a foreign registry lock and preserves a hand-edited projection', async () => {
    const fx = await fixture();
    await fx.rules.initialize();
    const other = new RulesRepository(await tempDir('sca-other-registry-'));
    await failWith('internal_error', () => withRegistryLock(other.paths, () => fx.rules.writeUnlocked(initialRulesDocument(NOW))));
    const file = acceptedRulesPath(fx.rules.paths);
    const edited = (await fs.readFile(file, 'utf8')).replace('# Accepted Rules', '# Hand edit');
    await fs.writeFile(file, edited);
    await failWith('registry_changed', () => fx.rules.transact(doc => ({ write: true, doc, result: null })));
    assert.equal(await fs.readFile(file, 'utf8'), edited);
  });

  it('rejects a linked source outside the data root without modifying it', async () => {
    const fx = await fixture();
    const candidate = await approve(fx);
    const request = await adoptRequest(fx, candidate);
    const file = fx.records.candidatesPath(fx.recordId);
    const external = path.join(await tempDir('sca-outside-'), 'source.md');
    await fs.rename(file, external);
    await fs.symlink(external, file);
    const before = await fs.readFile(external, 'utf8');
    await failWith('schema_invalid', () => adoptApprovedCandidate({ rules: fx.rules, records: fx.records }, request));
    assert.equal(await fs.readFile(external, 'utf8'), before);
    assert.equal((await registryDoc(fx)).pending_acceptance, null);
  });

  it('refuses oversized rule content before creating a pending acceptance', async () => {
    const fx = await fixture([makeCandidate({ proposed_content: '中'.repeat(1400) })]);
    const candidate = await approve(fx);
    const before = (await fx.records.loadCandidates(fx.recordId)).fileHash;
    await failWith('schema_invalid', async () => adoptApprovedCandidate({ rules: fx.rules, records: fx.records }, await adoptRequest(fx, candidate)));
    assert.equal((await registryDoc(fx)).pending_acceptance, null);
    assert.equal((await fx.records.loadCandidates(fx.recordId)).fileHash, before);
  });

  it('rejects a backup symlink pointing into live data before migration writes', async () => {
    const fx = await fixture();
    await approve(fx);
    const link = path.join(await tempDir('sca-backup-link-'), 'backup');
    await fs.symlink(fx.root, link);
    const before = (await fx.records.loadCandidates(fx.recordId)).fileHash;
    await failWith('schema_invalid', () => applyRuleMigration({ rules: fx.rules, records: fx.records }, { mode: 'apply', expected_revision: 1, backup_dir: link }));
    assert.equal((await fx.records.loadCandidates(fx.recordId)).fileHash, before);
    assert.equal((await registryDoc(fx)).rules.length, 0);
  });
});
