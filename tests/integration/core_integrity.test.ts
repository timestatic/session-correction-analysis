import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { prepareRecord, packetInputHash, type PreparePacket } from '../../src/analysis/prepare.js';
import { ingestSubmission } from '../../src/analysis/ingest.js';
import { RecordRepository } from '../../src/store/repository.js';
import { runCli } from '../../src/cli.js';
import { PENDING_COMMIT_MAX_BYTES } from '../../src/domain/limits.js';

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }); });

async function setup(results: boolean, secondPath = 'a.ts') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-integrity-'));
  dirs.push(root);
  const transcriptPath = path.join(root, 'source.jsonl');
  const records: object[] = [{ type: 'meta', host: 'codex', source_session_id: 'session', workspace: root }];
  records.push({ type: 'event', id: 'before', kind: 'file_edit', call_id: 'c1', text: '*** Update File: a.ts\n-old\n+new' });
  if (results) records.push({ type: 'event', id: 'r1', kind: 'tool_result', call_id: 'c1', text: 'Script completed' });
  records.push({ type: 'event', id: 'user', kind: 'user_message', text: '方向错了，请修改回来' });
  records.push({ type: 'event', id: 'after', kind: 'file_edit', call_id: 'c2', text: `*** Update File: ${secondPath}\n-new\n+old` });
  if (results) records.push({ type: 'event', id: 'r2', kind: 'tool_result', call_id: 'c2', text: 'Script completed' });
  await fs.writeFile(transcriptPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const repo = new RecordRepository(path.join(root, 'data'));
  const { recordId } = await repo.register({ host: 'codex', canonicalWorkspace: root, sessionId: 'session', transcriptPath, trigger: 'manual_skill', analyzerVersion: 'test' });
  const prepared = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-integrity' });
  return { root, repo, recordId, prepared };
}

function submission(packet: PreparePacket) {
  const user = packet.evidence.find((item) => item.kind === 'user_text')!;
  const changes = packet.evidence.filter((item) => item.kind === 'file_edit');
  return { processed_users: [{ evidence_id: user.id, status: 'reviewed' }],
    episodes: [{ anchor_event_id: user.id, issue_anchor: 'direction',
      correction: { detected: true, confidence: 'high', explanation: '用户纠正方向', prior_agent_behavior: [changes[0]!.id], agent_behavior_after: [changes[1]!.id], rework: { outcome: 'fixed', evidence: changes.map((item) => item.id) } },
      intervention: { detected: false, confidence: 'high', explanation: '无', evidence: [] },
      citations: [{ evidence_id: user.id, quote: '方向错了' }] }], candidates: [] };
}

it('rejects changed excerpts even if the attacker recomputes the packet digest', async () => {
  const { repo, recordId, prepared } = await setup(true);
  const original = (await repo.loadCandidates(recordId)).fileHash;
  const packet = JSON.parse(await fs.readFile(prepared.packetPath, 'utf8')) as PreparePacket;
  packet.evidence[0]!.excerpt = 'fabricated evidence';
  await fs.writeFile(prepared.packetPath, JSON.stringify(packet));
  await assert.rejects(ingestSubmission(repo, recordId, packet.run_id, JSON.stringify(submission(prepared.packet))), /integrity mismatch/);
  packet.input_hash = packetInputHash(packet);
  await fs.writeFile(prepared.packetPath, JSON.stringify(packet));
  await assert.rejects(ingestSubmission(repo, recordId, packet.run_id, JSON.stringify(submission(prepared.packet))), /digest pinned/);
  assert.equal((await repo.loadCandidates(recordId)).fileHash, original);
});

it('requires real paired success on both sides of a correction, with overlapping paths', async () => {
  for (const [results, secondPath, expected] of [[false, 'a.ts', /both sides/], [true, 'b.ts', /disjoint paths/]] as const) {
    const { repo, recordId, prepared } = await setup(results, secondPath);
    await assert.rejects(ingestSubmission(repo, recordId, prepared.packet.run_id, JSON.stringify(submission(prepared.packet))), expected);
  }
  const { repo, recordId, prepared } = await setup(true);
  await ingestSubmission(repo, recordId, prepared.packet.run_id, JSON.stringify(submission(prepared.packet)));
  assert.equal((await repo.loadAnalyze(recordId)).doc.facts?.episodes[0]?.correction.rework?.outcome, 'fixed');
});

it('rejects oversized submissions at core and CLI boundaries without mutating the record', async () => {
  const { repo, recordId, prepared, root } = await setup(true);
  const raw = 'x'.repeat(PENDING_COMMIT_MAX_BYTES + 1);
  const before = (await repo.loadAnalyze(recordId)).fileHash;
  await assert.rejects(ingestSubmission(repo, recordId, prepared.packet.run_id, raw), /exceeds/);
  const file = path.join(root, 'oversized.json');
  await fs.writeFile(file, raw);
  for (const input of [file, '-']) {
    const out: string[] = [];
    const code = await runCli(['ingest', recordId, '--run', prepared.packet.run_id, '--submission', input, '--data-root', repo.paths.root], {
      env: {}, stdout: (line) => out.push(line), stderr: () => undefined, readStdin: () => Promise.resolve(raw),
    });
    assert.equal(code, 2);
    assert.match(out.join(''), /payload_too_large/);
  }
  assert.equal((await repo.loadAnalyze(recordId)).fileHash, before);
});
