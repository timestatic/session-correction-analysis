import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { buildPacket, prepareRecord, type PreparePacket } from '../../src/analysis/prepare.js';
import { ingestSubmission } from '../../src/analysis/ingest.js';
import { RecordRepository } from '../../src/store/repository.js';
import { applyDecision, hasCurrentApproval } from '../../src/review/decide.js';
import { runCli } from '../../src/cli.js';

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }); });

async function setup(text = '不要改错文件，先检查配置') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-review-regression-'));
  dirs.push(dir);
  const transcript = path.join(dir, 'input.jsonl');
  await fs.writeFile(transcript, [
    { type: 'meta', host: 'codex', source_session_id: 'actual', workspace: dir },
    { type: 'event', id: 'u1', kind: 'user_message', text: '检查代码' },
    { type: 'event', id: 'a1', kind: 'assistant_message', text: '我修改了错误文件' },
    { type: 'event', id: 'u2', kind: 'user_message', text },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const repo = new RecordRepository(path.join(dir, 'data'));
  const { recordId } = await repo.register({ host: 'codex', sessionId: 'actual', canonicalWorkspace: dir,
    transcriptPath: transcript, trigger: 'manual_skill', analyzerVersion: 'test' });
  return { dir, transcript, repo, recordId };
}

function submission(packet: PreparePacket) {
  const user = packet.evidence.find((item) => item.kind === 'user_text' && item.excerpt.includes('不要'))!;
  return {
    processed_users: packet.user_coverage.map((entry) => ({ evidence_id: entry.evidence_id, status: 'reviewed' as const })),
    episodes: [{ anchor_event_id: user.id, issue_anchor: 'wrong-file',
      correction: { detected: true, confidence: 'high', prior_agent_behavior: [], agent_behavior_after: [], explanation: '纠正修改对象' },
      intervention: { detected: false, confidence: 'high', evidence: [], explanation: '无' },
      citations: [{ evidence_id: user.id, quote: '不要' }] }],
    candidates: [{ title: '检查配置', category: 'process', confidence: 'high', proposed_content: '修改前先检查配置',
      evidence: [user.id], source_episode_anchor: user.id, source_issue_anchor: 'wrong-file' }],
  };
}

it('retains approved candidate provenance across empty reanalysis and runtime deletion', async () => {
  const { repo, recordId } = await setup();
  const first = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-first' });
  const legacy = submission(first.packet);
  Reflect.deleteProperty(legacy.candidates[0]!, 'source_issue_anchor');
  await ingestSubmission(repo, recordId, 'run-first', JSON.stringify(legacy));
  const initial = await repo.loadCandidates(recordId);
  await applyDecision(repo, recordId, { candidate_id: 'learning-001', action: 'approve', request_id: 'approve-one', expected_revision: initial.doc.revision });
  const before = await repo.loadRecord(recordId);
  const repeat = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-repeat' });
  const repeated = await ingestSubmission(repo, recordId, 'run-repeat', JSON.stringify(submission(repeat.packet)));
  assert.equal(repeated.duplicate_candidates_skipped, 1, 'adding an exact issue discriminator must not duplicate a legacy candidate');
  const second = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-second' });
  await ingestSubmission(repo, recordId, 'run-second', JSON.stringify({ ...submission(second.packet), episodes: [], candidates: [] }));
  await fs.rm(repo.paths.runtimeDir, { recursive: true, force: true });
  const loaded = await repo.loadRecord(recordId);
  assert.equal(loaded.analyze.doc.facts?.episodes.length, 0, 'historical detections must not pollute the latest run');
  assert.deepEqual(loaded.candidates.doc.candidates, before.candidates.doc.candidates);
  assert.ok(hasCurrentApproval(loaded.candidates.doc.candidates[0]!));
  const source = loaded.analyze.doc.facts?.candidate_sources[0];
  assert.ok(source);
  assert.equal(source.candidate_id, 'learning-001');
  assert.deepEqual(source.episodes.map((episode) => episode.id), loaded.candidates.doc.candidates[0]!.source_episodes);
  for (const id of loaded.candidates.doc.candidates[0]!.evidence) assert.ok(source.evidence.some((item) => item.id === id));
});

it('keeps transcript excerpts out of default candidate review and exposes them only with --full', async () => {
  const privateExcerpt = 'https://internal.example/cooper/secret-' + 'x'.repeat(8000);
  const { repo, recordId } = await setup(`不要改错文件，${privateExcerpt}`);
  const prepared = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-review-output' });
  const payload = submission(prepared.packet);
  const anchor = prepared.packet.evidence.find((item) => item.kind === 'user_text' && item.excerpt.includes('不要'))!;
  payload.episodes[0]!.correction.explanation = '分析者判断：纠正了修改对象。';
  Object.assign(payload.episodes[0]!.correction, { rework: { outcome: 'unknown', evidence: [] } });
  payload.episodes[0]!.citations[0]!.quote = anchor.excerpt;
  await ingestSubmission(repo, recordId, prepared.packet.run_id, JSON.stringify(payload));
  const review = async (full: boolean): Promise<string> => {
    const output: string[] = [];
    const code = await runCli(['review', recordId, '--candidate', 'learning-001', ...(full ? ['--full'] : []), '--data-root', repo.paths.root],
      { env: {}, stdout: (line) => output.push(line), stderr: (line) => output.push(line) });
    assert.equal(code, 0, output.join('\n'));
    return output.join('\n');
  };
  const compact = await review(false);
  assert.ok(!compact.includes(privateExcerpt));
  assert.match(compact, /"status":"available"/);
  assert.match(compact, /"issue_anchor":"wrong-file"/);
  assert.match(compact, /分析者判断：纠正了修改对象/);
  assert.match(compact, /"prior_agent_behavior":\[\]/);
  assert.match(compact, /"outcome":"unknown"/);
  assert.match(compact, /"quote":\{"text":"不要改错文件/);
  assert.match(compact, /"truncated":true/);
  assert.ok((await review(true)).includes(privateExcerpt));
});

it('commits small submissions with shared long evidence without inflating pending provenance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-shared-evidence-'));
  dirs.push(dir);
  const transcript = path.join(dir, 'input.jsonl');
  const rows = [{ type: 'meta', host: 'codex', source_session_id: 'shared', workspace: dir },
    ...Array.from({ length: 12 }, (_, index) => ({ type: 'event', id: `u${index}`, kind: 'user_message', text: `证据 ${index}: ${'x'.repeat(8000)}` }))];
  await fs.writeFile(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const repo = new RecordRepository(path.join(dir, 'data'));
  const { recordId } = await repo.register({ host: 'codex', sessionId: 'shared', canonicalWorkspace: dir,
    transcriptPath: transcript, trigger: 'manual_skill', analyzerVersion: 'test' });
  const prepared = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-shared' });
  const users = prepared.packet.user_coverage.map((entry) => entry.evidence_id);
  const anchor = prepared.packet.evidence.find((item) => item.id === users[0])!;
  const payload = {
    processed_users: users.map((evidence_id) => ({ evidence_id, status: 'reviewed' })),
    episodes: [{ anchor_event_id: anchor.id, issue_anchor: 'shared-evidence',
      correction: { detected: true, confidence: 'high', prior_agent_behavior: [], agent_behavior_after: [], explanation: '纠正了处理范围' },
      intervention: { detected: false, confidence: 'high', evidence: [], explanation: '无' },
      citations: [{ evidence_id: anchor.id, quote: '证据 0' }] }],
    candidates: Array.from({ length: 4 }, (_, index) => ({ title: `规则 ${index}`, category: 'process', confidence: 'high',
      proposed_content: `逐项检查 ${index}`, evidence: users, source_episode_anchor: anchor.id, source_issue_anchor: 'shared-evidence' })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < 30_000);
  const result = await ingestSubmission(repo, recordId, prepared.packet.run_id, JSON.stringify(payload));
  assert.equal(result.new_candidate_ids.length, 4);
  const loaded = await repo.loadRecord(recordId);
  assert.equal(loaded.analyze.doc.facts?.candidate_sources.length, 4);
  assert.ok(loaded.analyze.doc.facts?.candidate_sources.every((source) => source.evidence.length === 12));
  const rerun = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-shared-rerun' });
  await ingestSubmission(repo, recordId, rerun.packet.run_id, JSON.stringify({ episodes: [], candidates: [],
    processed_users: rerun.packet.user_coverage.map((entry) => ({ evidence_id: entry.evidence_id, status: 'reviewed' })) }));
  assert.equal((await repo.loadAnalyze(recordId)).doc.facts?.candidate_sources.length, 4);
});

it('routes multiple issues exactly and rejects legacy ambiguous candidate anchors', async () => {
  const { repo, recordId } = await setup();
  const first = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-multi' });
  const payload = submission(first.packet);
  payload.episodes.push({ ...payload.episodes[0]!, issue_anchor: 'other-issue' });
  const legacy = JSON.parse(JSON.stringify(payload)) as typeof payload;
  Reflect.deleteProperty(legacy.candidates[0]!, 'source_issue_anchor');
  await assert.rejects(ingestSubmission(repo, recordId, 'run-multi', JSON.stringify(legacy)), /multiple issues require/);
  await ingestSubmission(repo, recordId, 'run-multi', JSON.stringify(payload));
  const loaded = await repo.loadRecord(recordId);
  assert.equal(loaded.candidates.doc.candidates[0]?.source_episodes[0], loaded.analyze.doc.facts?.episodes.find((episode) => episode.issue_anchor === 'wrong-file')?.id);
});

it('keeps short-turn user ownership unique and downgrades oversized evidence', async () => {
  const { repo, recordId } = await setup('a'.repeat(10000) + '不要修改文件');
  const { packet } = await prepareRecord(repo, recordId, { owner: 'test' });
  assert.equal(packet.snapshot.coverage, 'partial');
  assert.equal(packet.user_coverage.length, 2);
  assert.equal(new Set(packet.blocks.flatMap((block) => block.primary_user_event_ids)).size, 2);
  assert.equal(packet.blocks.flatMap((block) => block.primary_user_event_ids).length, 2);
});

it('refuses host, session and workspace mismatches before claiming a lease or creating CLI records', async () => {
  const { dir, transcript, repo, recordId } = await setup();
  for (const expectedIdentity of [
    { host: 'claude' as const, sessionId: 'actual', workspace: dir },
    { host: 'codex' as const, sessionId: 'wrong', workspace: dir },
    { host: 'codex' as const, sessionId: 'actual', workspace: path.join(dir, 'wrong') },
  ]) await assert.rejects(buildPacket({ recordId, runId: 'run-x', analysisId: 'a-x', transcriptPath: transcript, ruleVersion: 'test', expectedIdentity }), /does not match/);
  const invalid = await repo.register({ host: 'codex', sessionId: 'wrong', canonicalWorkspace: dir,
    transcriptPath: transcript, trigger: 'manual_skill', analyzerVersion: 'test' });
  await assert.rejects(prepareRecord(repo, invalid.recordId, { owner: 'test' }), /does not match/);
  assert.ok(!(await repo.loadAnalyze(invalid.recordId)).doc.lease);
  const output: string[] = [];
  const root = path.join(dir, 'cli-data');
  const code = await runCli(['register', '--host', 'codex', '--session', 'wrong', '--workspace', dir, '--transcript', transcript, '--data-root', root],
    { env: {}, stdout: (line) => output.push(line), stderr: () => undefined });
  assert.equal(code, 2);
  assert.match(output.join(''), /record_identity_mismatch/);
  await assert.rejects(fs.access(path.join(root, 'records')));
});

it('rejects incomplete processing receipts and marks legacy receipt-less submissions partial', async () => {
  const { repo, recordId } = await setup();
  const first = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-receipts' });
  const payload = submission(first.packet);
  for (const processed_users of [payload.processed_users.slice(0, 1), [payload.processed_users[0], payload.processed_users[0]], [{ evidence_id: 'unknown', status: 'reviewed' }]]) {
    await assert.rejects(ingestSubmission(repo, recordId, 'run-receipts', JSON.stringify({ ...payload, processed_users })), /processed_users/);
  }
  Reflect.deleteProperty(payload, 'processed_users');
  await ingestSubmission(repo, recordId, 'run-receipts', JSON.stringify(payload));
  assert.equal((await repo.loadAnalyze(recordId)).doc.facts?.snapshot.coverage, 'partial');
});
