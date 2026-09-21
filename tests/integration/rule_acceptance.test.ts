import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { computeRuleId, ruleContentHash, type AcceptedRulesDocument } from '../../src/domain/rules.js';
import { RecordRepository } from '../../src/store/repository.js';
import { RulesRepository } from '../../src/store/rules.js';
import { acceptedRulesPath } from '../../src/store/paths.js';
import { applyDecision } from '../../src/review/decide.js';
import { makeCandidate } from '../unit/domain/helpers.js';

/**
 * LC-02 real-process matrix: a child SIGKILLs itself at each durable adoption
 * boundary and a *fresh* process finishes the job from Markdown alone. Locks of
 * a verifiably dead holder are removed by the parent instead of waiting out the
 * 30s stale window, and nothing here touches a real data root.
 */

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CHILD = path.join(REPO_ROOT, 'dist', 'tests', 'integration', 'rule_acceptance_child.js');

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

interface Run {
  code: number | null;
  json: Record<string, unknown>;
  out: string;
  err: string;
}

async function runChild(
  root: string,
  mode: string,
  args: string[],
  crashPoint?: string,
): Promise<Run> {
  const child = spawn(process.execPath, [CHILD, mode, ...args], {
    env: { ...process.env, SCA_DATA_ROOT: root, ...(crashPoint !== undefined ? { SCA_CRASH_POINT: crashPoint } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', (c) => resolve(c)); });
  let json: Record<string, unknown> = {};
  const line = out.trim().split('\n').at(-1) ?? '';
  try {
    json = JSON.parse(line) as Record<string, unknown>;
  } catch {
    /* the process died before printing anything, which is the point */
  }
  return { code, json, out, err };
}

interface Scenario {
  root: string;
  rules: RulesRepository;
  records: RecordRepository;
  recordId: string;
  workspace: string;
  candidateId: string;
}

async function scenarioIn(root: string, sessionId: string): Promise<Scenario> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-rule-crash-ws-'));
  dirs.push(workspace);
  const records = new RecordRepository(root);
  const rules = new RulesRepository(root);
  await rules.initialize();
  const { recordId } = await records.register({
    host: 'codex',
    canonicalWorkspace: workspace,
    sessionId,
    transcriptPath: path.join(workspace, 'rollout.jsonl'),
    analyzerVersion: '0.1.0',
    trigger: 'manual_skill',
  });
  const current = await records.loadCandidates(recordId);
  const candidates =
    sessionId === 'crash-session-1'
      ? [makeCandidate(), makeCandidate({ id: 'learning-002', proposed_content: '第二条内容' })]
      : [makeCandidate({ id: 'learning-009', proposed_content: '另一个会话的内容' })];
  await records.updateCandidates(recordId, current, (doc) => ({ ...doc, candidates }));
  const revision = (await records.loadCandidates(recordId)).doc.revision;
  await applyDecision(records, recordId, {
    request_id: 'approve-1',
    candidate_id: candidates[0]?.id ?? 'learning-001',
    action: 'approve',
    expected_revision: revision,
  });
  return { root, rules, records, recordId, workspace, candidateId: candidates[0]?.id ?? 'learning-001' };
}

async function newRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-rule-crash-'));
  dirs.push(root);
  return root;
}

async function scenario(sessionId = 'crash-session-1'): Promise<Scenario> {
  return scenarioIn(await newRoot(), sessionId);
}

/** A second live process can only be observed once the dead holder's lock dir is gone. */
async function releaseDeadLocks(sc: Scenario): Promise<void> {
  await fs.rm(sc.rules.paths.locksDir, { recursive: true, force: true });
}

async function registry(sc: Scenario): Promise<AcceptedRulesDocument> {
  const read = await sc.rules.read();
  if (read.state !== 'ok') {
    throw new Error(`registry is ${read.state}`);
  }
  return read.doc;
}

function adoptArgs(sc: Scenario, requestId: string, recordId = sc.recordId): string[] {
  return [recordId, sc.candidateId, requestId];
}

describe('adoption crash recovery with real processes', () => {
  it('kill before the pending marker leaves nothing behind and the retry just works', async () => {
    const sc = await scenario();
    const killed = await runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1'), 'before_pending');
    assert.equal(killed.code, null, 'SIGKILL leaves no exit code');
    await releaseDeadLocks(sc);

    assert.equal((await registry(sc)).rules.length, 0);
    assert.equal((await sc.records.loadCandidates(sc.recordId)).doc.candidates[0]?.rule_ref, undefined);

    const again = await runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1'));
    assert.equal(again.code, 0, again.out + again.err);
    assert.equal(again.json.result, 'applied');
    assert.equal(again.json.recovered, false);
    const doc = await registry(sc);
    assert.equal(doc.rules.length, 1);
    assert.equal(doc.pending_acceptance, null);
  });

  it('kill after the pending marker: a reader sees the unfinished adoption, a new process finishes it', async () => {
    const sc = await scenario();
    const killed = await runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1'), 'after_pending');
    assert.equal(killed.code, null);
    assert.equal(killed.out, '', 'a killed process never prints a success receipt');
    await releaseDeadLocks(sc);

    const stuck = await registry(sc);
    assert.equal(stuck.rules.length, 0);
    assert.equal(stuck.pending_acceptance?.request_id, 'adopt-1');

    const seen = await runChild(sc.root, 'status', [sc.recordId]);
    assert.equal(seen.code, 0);
    assert.equal(seen.json.pending_rule_id, stuck.pending_acceptance?.rule_id);
    assert.equal(seen.json.recoverable, false, 'diagnostic status does not promise safe recovery');
    assert.equal(seen.json.rule_count, null, 'pending is not a committed empty registry');

    const healed = await runChild(sc.root, 'recover', [sc.recordId]);
    assert.equal(healed.code, 0, healed.out + healed.err);
    assert.equal(healed.json.state, 'recovered');
    const done = await registry(sc);
    assert.equal(done.pending_acceptance, null);
    assert.equal(done.rules.length, 1);
    assert.equal(done.rules[0]?.rule_id, computeRuleId(sc.recordId, sc.candidateId));
    assert.equal((await sc.records.loadCandidates(sc.recordId)).doc.candidates[0]?.rule_ref?.rule_id, done.rules[0]?.rule_id);
  });

  it('kill after the candidate side landed: the same request finishes the registry without a second write', async () => {
    const sc = await scenario();
    assert.equal((await runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1'), 'after_candidate')).code, null);
    await releaseDeadLocks(sc);

    const stuck = await registry(sc);
    assert.equal(stuck.rules.length, 0);
    const interrupted = await sc.records.loadCandidates(sc.recordId);
    assert.equal(interrupted.doc.candidates[0]?.rule_ref?.rule_id, stuck.pending_acceptance?.rule_id);

    const retried = await runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1'));
    assert.equal(retried.code, 0, retried.out + retried.err);
    assert.equal(retried.json.recovered, true, 'the durable pending was rolled forward, not redone');
    assert.equal(retried.json.rule_id, stuck.pending_acceptance?.rule_id);
    const done = await registry(sc);
    assert.equal(done.rules.length, 1);
    assert.equal(done.request_log.length, 1);
    const after = await sc.records.loadCandidates(sc.recordId);
    assert.equal(after.fileHash, interrupted.fileHash, 'recovery never rewrites the session side');
  });

  it('an external edit inside the crash window stops recovery and keeps every file', async () => {
    const sc = await scenario();
    assert.equal((await runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1'), 'after_pending')).code, null);
    await releaseDeadLocks(sc);
    const registryBefore = await fs.readFile(acceptedRulesPath(sc.rules.paths), 'utf8');

    const revision = (await sc.records.loadCandidates(sc.recordId)).doc.revision;
    await applyDecision(sc.records, sc.recordId, {
      request_id: 'edit-during',
      candidate_id: sc.candidateId,
      action: 'edit_content',
      expected_revision: revision,
      content: '用户在崩溃窗口改写了正文',
    });

    const healed = await runChild(sc.root, 'recover', [sc.recordId]);
    assert.equal(healed.code, 1);
    assert.equal(healed.json.error, 'rule_acceptance_recovery_failed');
    assert.equal(await fs.readFile(acceptedRulesPath(sc.rules.paths), 'utf8'), registryBefore);
    const doc = await registry(sc);
    assert.equal(doc.rules.length, 0);
    assert.notEqual(doc.pending_acceptance, null);
    assert.equal(
      (await sc.records.loadCandidates(sc.recordId)).doc.candidates.find((c) => c.id === sc.candidateId)
        ?.proposed_content,
      '用户在崩溃窗口改写了正文',
      'recovery must never overwrite the user edit',
    );

    // Maintenance blocks every further adoption write until a human resolves it.
    const blocked = await runChild(sc.root, 'adopt', [sc.recordId, 'learning-002', 'adopt-2']);
    assert.equal(blocked.code, 1);
    assert.equal(blocked.json.error, 'rule_acceptance_recovery_failed');
  });

  it('two processes adopting the same candidate produce exactly one rule', async () => {
    const sc = await scenario();
    const [a, b] = await Promise.all([
      runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1')),
      runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-2')),
    ]);
    assert.equal([a, b].filter(result => result.code === 0).length, 1, 'one request adopts; the other must use the existing rule');
    const doc = await registry(sc);
    assert.equal(doc.rules.length, 1);
    assert.equal(doc.pending_acceptance, null);
    assert.equal(doc.request_log.length, 1);
    assert.equal((await sc.records.loadCandidates(sc.recordId)).doc.candidates[0]?.rule_ref?.rule_id, doc.rules[0]?.rule_id);
  });

  it('two sessions adopting at the same time keep both rules', async () => {
    const root = await newRoot();
    const one = await scenarioIn(root, 'race-session-1');
    const two = await scenarioIn(root, 'race-session-2');
    const [a, b] = await Promise.all([
      runChild(root, 'adopt', [one.recordId, one.candidateId, 'adopt-one']),
      runChild(root, 'adopt', [two.recordId, two.candidateId, 'adopt-two']),
    ]);
    assert.equal(a.code, 0, a.out + a.err);
    assert.equal(b.code, 0, b.out + b.err);
    assert.notEqual(a.json.rule_id, b.json.rule_id);

    const doc = await registry(one);
    assert.equal(doc.rules.length, 2, 'the later committer must not lose the earlier rule');
    assert.equal(doc.pending_acceptance, null);
    assert.deepEqual(
      new Set(doc.rules.map((rule) => rule.source.record_id)),
      new Set([one.recordId, two.recordId]),
    );
    assert.equal(doc.request_log.length, 2);
  });

  it('an analysis holding the session lock is waited for, never raced', async () => {
    const sc = await scenario();
    const holder = runChild(sc.root, 'hold-analyze', [sc.recordId, '', 'analyzer', '400']);
    const adopter = runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1'));
    const [h, a] = await Promise.all([holder, adopter]);
    assert.equal(h.code, 0, h.out + h.err);
    assert.equal(a.code, 0, a.out + a.err);
    assert.equal(a.json.result, 'applied');
    const doc = await registry(sc);
    assert.equal(doc.rules.length, 1);
    const analyze = await sc.records.loadAnalyze(sc.recordId);
    assert.equal(analyze.doc.extensions?.held_by, 'analyzer', 'the analyzer write survived');
    assert.equal((await sc.records.loadCandidates(sc.recordId)).doc.candidates[0]?.rule_ref?.rule_id, doc.rules[0]?.rule_id);
  });

  it('a wiped runtime directory costs nothing but locks: the Markdown still recovers', async () => {
    const sc = await scenario();
    assert.equal((await runChild(sc.root, 'adopt', adoptArgs(sc, 'adopt-1'), 'after_pending')).code, null);
    await fs.rm(sc.rules.paths.runtimeDir, { recursive: true, force: true });

    const healed = await runChild(sc.root, 'recover', [sc.recordId]);
    assert.equal(healed.code, 0, healed.out + healed.err);
    const doc = await registry(sc);
    assert.equal(doc.rules.length, 1);
    assert.equal(doc.pending_acceptance, null);
    const content = await fs.readFile(acceptedRulesPath(sc.rules.paths), 'utf8');
    assert.match(content, new RegExp(String(computeRuleId(sc.recordId, sc.candidateId))));
    assert.equal(
      ruleOf(sc, doc).content_hash,
      ruleContentHash({
        content: (await sc.records.loadCandidates(sc.recordId)).doc.candidates[0]?.proposed_content ?? '',
        scope: ruleOf(sc, doc).scope,
      }),
    );
  });
});

function ruleOf(sc: Scenario, doc: AcceptedRulesDocument) {
  const rule = doc.rules.find((entry) => entry.rule_id === computeRuleId(sc.recordId, sc.candidateId));
  if (rule === undefined) {
    throw new Error('rule vanished');
  }
  return rule;
}
