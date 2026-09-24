import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { runCli } from '../../src/cli.js';
import { RecordRepository } from '../../src/store/repository.js';
import { prepareRecord } from '../../src/analysis/prepare.js';
import { ingestSubmission } from '../../src/analysis/ingest.js';
import { parseFrontmatterYaml, renderDocument, splitFrontmatter } from '../../src/store/frontmatter.js';
import { z } from 'zod';
import { applyDecision } from '../../src/review/decide.js';

async function scenario(root: string) {
  const transcript = path.join(root, 'input.jsonl');
  await fs.writeFile(transcript, [
    { type: 'meta', host: 'codex', source_session_id: 'phase1', workspace: root },
    { type: 'event', id: 'u1', kind: 'user_message', text: '检查配置' },
    { type: 'event', id: 'a1', kind: 'assistant_message', text: '我准备修改代码' },
    { type: 'event', id: 'u2', kind: 'user_message', text: '不要修改，先解释配置' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const repo = new RecordRepository(path.join(root, 'data'));
  const { recordId } = await repo.register({ host: 'codex', sessionId: 'phase1', canonicalWorkspace: root,
    transcriptPath: transcript, trigger: 'manual_skill', analyzerVersion: 'test' });
  const prepared = await prepareRecord(repo, recordId, { owner: 'test' });
  const user = prepared.packet.evidence.find(e => e.excerpt === '不要修改，先解释配置')!;
  const submission = {
    processed_users: prepared.packet.user_coverage.map(u => ({ evidence_id: u.evidence_id, status: 'reviewed' })),
    episodes: [{ anchor_event_id: user.id, issue_anchor: 'explain-first',
      correction: { detected: true, confidence: 'high', prior_agent_behavior: [], agent_behavior_after: [], explanation: '先解释' },
      intervention: { detected: true, kind: 'forbid_action', confidence: 'high', evidence: [user.id], explanation: '禁止修改' },
      citations: [{ evidence_id: user.id, quote: '不要修改' }] }],
    candidates: [{ title: '先解释', category: 'process', confidence: 'high', proposed_content: '修改前解释配置',
      evidence: [user.id], source_episode_anchor: user.id, source_issue_anchor: 'explain-first' }],
  };
  await ingestSubmission(repo, recordId, prepared.packet.run_id, JSON.stringify(submission));
  return { repo, recordId, submission };
}

async function cli(root: string, args: string[], expected = 0) {
  const lines: string[] = [];
  const code = await runCli([...args, '--data-root', root], { env: {}, stdout: line => lines.push(line), stderr: line => lines.push(line) });
  assert.equal(code, expected, lines.join('\n'));
  return lines.join('\n');
}

it('phase1 review shows provenance, edits/approves, exports once and retains decisions on reanalysis', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-phase1-'));
  try {
    const { repo, recordId } = await scenario(root);
    const review = ['review', recordId, '--candidate', 'learning-001'];
    const detail = await cli(repo.paths.root, review);
    assert.match(detail, /修改前解释配置/);
    assert.match(detail, /"issue_anchor":"explain-first"/);
    assert.match(detail, /"quote":\{"text":"不要修改","truncated":false\}/);
    assert.match(await cli(repo.paths.root, [...review, '--full']), /不要修改/);
    await cli(repo.paths.root, [...review, '--action', 'copy_content'], 2);
    const contentFile = path.join(root, 'edit.md');
    await fs.writeFile(contentFile, '只解释配置，修改前先征求明确授权');
    const revision = (await repo.loadCandidates(recordId)).doc.revision;
    await cli(repo.paths.root, [...review, '--action', 'edit_content', '--request', 'edit-1', '--expected-revision', String(revision), '--content-file', contentFile]);
    const approve = [...review, '--action', 'approve', '--request', 'approve-1', '--expected-revision', String(revision + 1)];
    await cli(repo.paths.root, approve);
    await cli(repo.paths.root, approve);
    const before = await repo.loadRecord(recordId);
    assert.match(await cli(repo.paths.root, [...review, '--action', 'copy_content']), /只解释配置/);
    const output = path.join(root, 'rule.md');
    await cli(repo.paths.root, [...review, '--action', 'export_content', '--out', output]);
    const exported = await fs.readFile(output, 'utf8');
    await cli(repo.paths.root, [...review, '--action', 'export_content', '--out', output], 2);
    assert.equal(await fs.readFile(output, 'utf8'), exported);
    assert.deepEqual((await repo.loadRecord(recordId)).candidates, before.candidates);
    const repeated = await prepareRecord(repo, recordId, { owner: 'test' });
    await ingestSubmission(repo, recordId, repeated.packet.run_id, JSON.stringify({ episodes: [], candidates: [],
      processed_users: repeated.packet.user_coverage.map(u => ({ evidence_id: u.evidence_id, status: 'reviewed' })) }));
    assert.deepEqual((await repo.loadCandidates(recordId)).doc.candidates, before.candidates.doc.candidates);
    assert.match(await cli(repo.paths.root, review), /"issue_anchor":"explain-first"/);
    await cli(repo.paths.root, ['publish', 'targets'], 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('legacy rule and publication records are refused without changing either business file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-phase1-legacy-'));
  try {
    const { repo, recordId } = await scenario(root);
    const analyzePath = repo.analyzePath(recordId);
    const candidatesPath = repo.candidatesPath(recordId);
    const originals = [await fs.readFile(analyzePath, 'utf8'), await fs.readFile(candidatesPath, 'utf8')] as const;
    const candidateDoc = z.record(z.unknown()).parse(parseFrontmatterYaml(splitFrontmatter(originals[1]).yamlText));
    const candidate = z.record(z.unknown()).array().parse(candidateDoc['candidates'])[0]!;
    const analyzeDoc = z.record(z.unknown()).parse(parseFrontmatterYaml(splitFrontmatter(originals[0]).yamlText));
    for (const variant of [
      { ...candidate, rule_ref: { rule_id: 'old-rule' } },
      { ...candidate, status: 'published' },
      { ...candidate, status: 'publish_failed' },
      { ...candidate, publication: { published: false, attempts: [{ result: 'failed' }] } },
    ]) {
      await fs.writeFile(candidatesPath, renderDocument({ ...candidateDoc, candidates: [variant] }, splitFrontmatter(originals[1]).body));
      const before = await fs.readFile(candidatesPath, 'utf8');
      await assert.rejects(repo.loadRecord(recordId), /unsupported|一期|Phase 1/i);
      await assert.rejects(repo.acquireLease(recordId, { runId: 'legacy', owner: 'test', ttlMs: 60000 }), /unsupported|一期|Phase 1/i);
      assert.equal(await fs.readFile(candidatesPath, 'utf8'), before);
      assert.equal(await fs.readFile(analyzePath, 'utf8'), originals[0]);
    }
    await fs.writeFile(candidatesPath, originals[1]);
    await fs.writeFile(analyzePath, renderDocument({ ...analyzeDoc, rule_review: {} }, splitFrontmatter(originals[0]).body));
    const before = await fs.readFile(analyzePath, 'utf8');
    await assert.rejects(repo.transactCandidates(recordId, doc => ({ write: true, doc, result: null })), /unsupported|一期|Phase 1/i);
    assert.equal(await fs.readFile(analyzePath, 'utf8'), before);
    assert.equal(await fs.readFile(candidatesPath, 'utf8'), originals[1]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('refuses legacy transaction artifacts before they have marked a candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-phase1-pending-'));
  try {
    const { repo, recordId } = await scenario(root);
    const candidateFile = await repo.loadCandidates(recordId);
    const originals = [await fs.readFile(repo.analyzePath(recordId), 'utf8'), await fs.readFile(repo.candidatesPath(recordId), 'utf8')];
    for (const artifact of [path.join(repo.paths.root, 'accepted_rules.md'), path.join(repo.paths.runtimeDir, 'publications', 'legacy.json')]) {
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, 'opaque legacy pending transaction');
      const operations = [
        () => applyDecision(repo, recordId, { candidate_id: 'learning-001', action: 'approve', request_id: 'blocked', expected_revision: candidateFile.doc.revision }),
        () => repo.acquireLease(recordId, { runId: 'blocked', owner: 'test', ttlMs: 60000 }),
        () => repo.recoverPending(recordId),
      ];
      for (const operation of operations) await assert.rejects(operation(), /legacy rule\/publication transactions/);
      assert.equal(await fs.readFile(repo.analyzePath(recordId), 'utf8'), originals[0]);
      assert.equal(await fs.readFile(repo.candidatesPath(recordId), 'utf8'), originals[1]);
      assert.equal(await fs.readFile(artifact, 'utf8'), 'opaque legacy pending transaction');
      await fs.unlink(artifact);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
