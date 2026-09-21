import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ScaError } from '../../../src/domain/errors.js';
import { prepareRecord } from '../../../src/analysis/prepare.js';
import type { PreparePacket } from '../../../src/analysis/prepare.js';
import { ingestSubmission } from '../../../src/analysis/ingest.js';
import { RecordRepository } from '../../../src/store/repository.js';
import { runCli, type CliIo } from '../../../src/cli.js';

const REPO = path.join(import.meta.dirname, '../../../..');
const CODEX_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'codex', 'basic.jsonl');
const REWORK_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'codex', 'rework.jsonl');

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

async function preparedRepo(): Promise<{ repo: RecordRepository; recordId: string; root: string }> {
  const root = await tempDir('sca-ingest-');
  const repo = new RecordRepository(root);
  const { recordId } = await repo.register({
    host: 'codex',
    canonicalWorkspace: '/repo/dpp_v3',
    sessionId: 'thr_fixture_1',
    transcriptPath: CODEX_FIXTURE,
    trigger: 'manual_skill',
    analyzerVersion: '0.1.0',
  });
  return { repo, recordId, root };
}

function firstUserAnchor(packet: PreparePacket): { evidenceId: string; excerpt: string } {
  const entry = packet.user_coverage[0];
  if (entry === undefined) {
    throw new Error('fixture must contain a user message');
  }
  const item = packet.evidence.find((e) => e.id === entry.evidence_id);
  if (item === undefined) {
    throw new Error('user coverage must resolve to packet evidence');
  }
  return { evidenceId: item.id, excerpt: item.excerpt };
}

function byKind(packet: PreparePacket, kind: string): string {
  const item = packet.evidence.find((e) => e.kind === kind);
  if (item === undefined) {
    throw new Error(`fixture must contain ${kind} evidence`);
  }
  return item.id;
}

interface SubmissionRework {
  outcome: string;
  evidence: string[];
}

interface SubmissionEpisode {
  [key: string]: unknown;
  anchor_event_id: string;
  issue_anchor: string;
  correction: {
    [key: string]: unknown;
    prior_agent_behavior: string[];
    agent_behavior_after: string[];
    rework?: SubmissionRework;
  };
  citations: { evidence_id: string; quote: string }[];
}

interface SubmissionDoc {
  episodes: SubmissionEpisode[];
  candidates: Record<string, unknown>[];
}

function buildSubmission(packet: PreparePacket): SubmissionDoc {
  const anchor = firstUserAnchor(packet);
  const toolResult = byKind(packet, 'tool_result');
  const assistant = byKind(packet, 'assistant_text');
  return {
    episodes: [
      {
        anchor_event_id: anchor.evidenceId,
        issue_anchor: '流程 key 对照范围错了',
        correction: {
          detected: true,
          subtype: 'wrong_scope',
          confidence: 'high',
          prior_agent_behavior: [],
          agent_behavior_after: [assistant],
          rework: { outcome: 'unknown', evidence: [toolResult] },
          explanation: '用户纠正对照范围后，先前做法被替换。',
        },
        intervention: {
          detected: false,
          confidence: 'medium',
          evidence: [],
          explanation: '无执行介入。',
        },
        citations: [{ evidence_id: anchor.evidenceId, quote: anchor.excerpt.slice(0, 6) }],
      },
    ],
    candidates: [
      {
        title: '核对流程 key 前先读文档定义',
        category: 'process',
        confidence: 'high',
        proposed_content: '先确认文档中定义的流程 key，再对照当前分支代码。',
        applicable_scope: '流程 key 核对任务',
        evidence: [anchor.evidenceId],
        source_episode_anchor: anchor.evidenceId,
      },
    ],
  };
}

async function expectError(run: () => Promise<unknown>, code: string): Promise<ScaError> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof ScaError, `expected ScaError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  throw new assert.AssertionError({ message: `expected ${code} but call succeeded` });
}

describe('ingest submission validation (design 22.3)', () => {
  it('commits episodes and proposed candidates through the two-file protocol', async () => {
    const { repo, recordId } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-ing-1' });
    const manifest = await ingestSubmission(
      repo,
      recordId,
      'run-ing-1',
      JSON.stringify(buildSubmission(prepared.packet)),
    );
    assert.equal(manifest.duplicate, false);
    assert.match(manifest.episode_ids[0] ?? '', /^ep-[0-9a-f]{16}$/);
    assert.deepEqual(manifest.new_candidate_ids, ['learning-001']);

    const loaded = await repo.loadRecord(recordId);
    assert.equal(loaded.analyze.doc.analysis_status, 'completed');
    assert.equal(loaded.analyze.doc.pending_commit, null);
    assert.equal(loaded.analyze.doc.lease, null);
    const facts = loaded.analyze.doc.facts;
    assert.equal(facts?.episodes.length, 1);
    assert.equal(facts?.runs.at(-1)?.status, 'ingested');
    assert.ok((facts?.evidence.length ?? 0) > 0, 'cited evidence is preserved');
    assert.equal(loaded.candidates.doc.candidates.length, 1);
    const candidate = loaded.candidates.doc.candidates[0];
    assert.equal(candidate?.status, 'proposed');
    assert.deepEqual(candidate?.target, { kind: 'harness' });
    assert.equal(candidate?.source_episodes[0], manifest.episode_ids[0]);

    const second = await ingestSubmission(
      repo,
      recordId,
      'run-ing-1',
      JSON.stringify(buildSubmission(prepared.packet)),
    );
    assert.equal(second.duplicate, true);
    const after = await repo.loadCandidates(recordId);
    assert.equal(after.doc.candidates.length, 1, 'duplicate run must not double-insert');
  });

  it('refuses evidence ids outside the frozen packet without writing facts', async () => {
    const { repo, recordId } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-ing-2' });
    const submission = buildSubmission(prepared.packet);
    submission.episodes[0]!.citations[0]!.evidence_id = 'ev-0000000000000000';
    const before = await repo.loadCandidates(recordId);
    await expectError(
      () => ingestSubmission(repo, recordId, 'run-ing-2', JSON.stringify(submission)),
      'evidence_not_found',
    );
    const after = await repo.loadCandidates(recordId);
    assert.equal(after.fileHash, before.fileHash, 'rejected submission must not touch candidates');
    const analyze = await repo.loadAnalyze(recordId);
    assert.equal(analyze.doc.facts, undefined);
  });

  it('refuses quotes that do not match the evidence excerpt', async () => {
    const { repo, recordId } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-ing-3' });
    const submission = buildSubmission(prepared.packet);
    submission.episodes[0]!.citations[0]!.quote = '完全虚构的引文内容';
    await expectError(
      () => ingestSubmission(repo, recordId, 'run-ing-3', JSON.stringify(submission)),
      'citation_mismatch',
    );
  });

  it('refuses a rework claim without file_edit/tool_result evidence', async () => {
    const { repo, recordId } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-ing-4' });
    const submission = buildSubmission(prepared.packet);
    const rework = submission.episodes[0]!.correction.rework;
    assert.ok(rework);
    rework.outcome = 'replaced';
    rework.evidence = [byKind(prepared.packet, 'assistant_text')];
    const err = await expectError(
      () => ingestSubmission(repo, recordId, 'run-ing-4', JSON.stringify(submission)),
      'schema_invalid',
    );
    assert.match(err.message, /file_edit\/tool_result/);
  });

  it('refuses agent behavior that crosses the anchor ordering', async () => {
    const { repo, recordId } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-ing-5' });
    const submission = buildSubmission(prepared.packet);
    submission.episodes[0]!.correction.prior_agent_behavior = [byKind(prepared.packet, 'assistant_text')];
    const err = await expectError(
      () => ingestSubmission(repo, recordId, 'run-ing-5', JSON.stringify(submission)),
      'schema_invalid',
    );
    assert.match(err.message, /ordering/);
  });

  it('rejects authority fields and enforces the one-shot resubmission budget', async () => {
    const { repo, recordId } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-ing-6' });
    const forged = buildSubmission(prepared.packet);
    forged.candidates[0]!.status = 'published';
    const first = await expectError(
      () => ingestSubmission(repo, recordId, 'run-ing-6', JSON.stringify(forged)),
      'schema_invalid',
    );
    assert.match(first.message, /1 corrective resubmission/);

    const second = await expectError(
      () => ingestSubmission(repo, recordId, 'run-ing-6', 'not json at all'),
      'schema_invalid',
    );
    assert.match(second.message, /budget \(1 per run\) exhausted/);

    // Even a fully valid third submission is refused for this run.
    await expectError(
      () => ingestSubmission(repo, recordId, 'run-ing-6', JSON.stringify(buildSubmission(prepared.packet))),
      'schema_invalid',
    );
  });

  it('rejects a stale runner whose lease was taken over by another run', async () => {
    const { repo, recordId } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-old', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await repo.acquireLease(recordId, { runId: 'run-takeover', owner: 'other', ttlMs: 60_000 });
    assert.equal(prepared.packet.lease_generation, 0);
    const err = await expectError(
      () => ingestSubmission(repo, recordId, 'run-old', JSON.stringify(buildSubmission(prepared.packet))),
      'lease_expired',
    );
    assert.match(err.message, /superseded/);
  });

  it('rejects the same run once its expired lease bumps the generation', async () => {
    const { repo, recordId } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-same-old', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await expectError(
      () => ingestSubmission(repo, recordId, 'run-same-old', JSON.stringify(buildSubmission(prepared.packet))),
      'lease_expired',
    );
  });

  it('refuses packets that are missing or lack a lease generation', async () => {
    const { repo, recordId } = await preparedRepo();
    await expectError(
      () => ingestSubmission(repo, recordId, 'run-missing', '{}'),
      'schema_invalid',
    );
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-nogen' });
    const raw = await fs.readFile(prepared.packetPath, 'utf8');
    const stripped = JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), lease_generation: undefined });
    await fs.writeFile(prepared.packetPath, stripped, 'utf8');
    await expectError(
      () => ingestSubmission(repo, recordId, 'run-nogen', '{}'),
      'schema_invalid',
    );
  });
});

describe('rework corroboration with edit signals (design 23.3)', () => {
  async function reworkRepo(): Promise<{ repo: RecordRepository; recordId: string }> {
    const root = await tempDir('sca-rw-');
    const repo = new RecordRepository(root);
    const { recordId } = await repo.register({
      host: 'codex',
      canonicalWorkspace: '/repo/demo',
      sessionId: 'thr_rework_1',
      transcriptPath: REWORK_FIXTURE,
      trigger: 'manual_skill',
      analyzerVersion: '0.1.0',
    });
    return { repo, recordId };
  }

  function evidenceIds(packet: PreparePacket, kind: string): string[] {
    return packet.evidence.filter((item) => item.kind === kind).map((item) => item.id);
  }

  function reworkSubmission(packet: PreparePacket, reworkEvidence: string[]): SubmissionDoc {
    const anchorEntry = packet.user_coverage[1];
    const anchor = packet.evidence.find((item) => item.id === anchorEntry?.evidence_id);
    if (anchor === undefined) {
      throw new Error('fixture must contain a second user message');
    }
    return {
      episodes: [
        {
          anchor_event_id: anchor.id,
          issue_anchor: '方向反了，应保留整体解析',
          correction: {
            detected: true,
            subtype: 'wrong_direction',
            confidence: 'high',
            prior_agent_behavior: [evidenceIds(packet, 'file_edit')[0] ?? ''],
            agent_behavior_after: [evidenceIds(packet, 'assistant_text').at(-1) ?? ''],
            rework: { outcome: 'replaced', evidence: reworkEvidence },
            explanation: '首次修改在用户纠正后被回退重做。',
          },
          intervention: { detected: false, confidence: 'medium', evidence: [], explanation: '无执行介入。' },
          citations: [{ evidence_id: anchor.id, quote: anchor.excerpt.slice(0, 6) }],
        },
      ],
      candidates: [],
    };
  }

  async function rewriteSignals(
    packetPath: string,
    mutate: (signals: Record<string, unknown>[]) => Record<string, unknown>[],
  ): Promise<void> {
    const raw = await fs.readFile(packetPath, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    json['edit_signals'] = mutate((json['edit_signals'] as Record<string, unknown>[]) ?? []);
    await fs.writeFile(packetPath, JSON.stringify(json), 'utf8');
  }

  it('accepts a rework claim that cites a valid change on both sides of the anchor', async () => {
    const { repo, recordId } = await reworkRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-rw-ok' });
    const firstChange = evidenceIds(prepared.packet, 'file_edit')[0] ?? '';
    const manifest = await ingestSubmission(
      repo,
      recordId,
      'run-rw-ok',
      JSON.stringify(reworkSubmission(prepared.packet, [firstChange])),
    );
    assert.equal(manifest.episode_ids.length, 1);
  });

  it('refuses a rework claim that cites only results while edit signals exist', async () => {
    const { repo, recordId } = await reworkRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-rw-nocite' });
    const firstResult = evidenceIds(prepared.packet, 'tool_result')[0] ?? '';
    const err = await expectError(
      () =>
        ingestSubmission(
          repo,
          recordId,
          'run-rw-nocite',
          JSON.stringify(reworkSubmission(prepared.packet, [firstResult])),
        ),
      'schema_invalid',
    );
    assert.match(err.message, /cites no edit signal/);
  });

  it('refuses a rework whose before-anchor side has no successful edit', async () => {
    const { repo, recordId } = await reworkRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-rw-side' });
    const anchorLine =
      prepared.packet.evidence.find((item) => item.id === prepared.packet.user_coverage[1]?.evidence_id)?.source_ref
        .line ?? 0;
    const kept = evidenceIds(prepared.packet, 'file_edit').filter(
      (id) => (prepared.packet.edit_signals?.find((s) => s.evidence_id === id)?.line ?? 0) > anchorLine,
    );
    await rewriteSignals(prepared.packetPath, (signals) =>
      signals.filter((signal) => !(signal['role'] === 'change' && (signal['line'] as number) < anchorLine)),
    );
    const err = await expectError(
      () => ingestSubmission(repo, recordId, 'run-rw-side', JSON.stringify(reworkSubmission(prepared.packet, kept))),
      'schema_invalid',
    );
    assert.match(err.message, /integrity mismatch/);
  });

  it('refuses edits on disjoint paths as the same reworked artifact', async () => {
    const { repo, recordId } = await reworkRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-rw-path' });
    const anchorLine =
      prepared.packet.evidence.find((item) => item.id === prepared.packet.user_coverage[1]?.evidence_id)?.source_ref
        .line ?? 0;
    await rewriteSignals(prepared.packetPath, (signals) =>
      signals.map((signal) =>
        signal['role'] === 'change' && (signal['line'] as number) < anchorLine
          ? { ...signal, paths: ['src/unrelated.ts'] }
          : signal,
      ),
    );
    const firstChange = evidenceIds(prepared.packet, 'file_edit')[0] ?? '';
    const err = await expectError(
      () =>
        ingestSubmission(
          repo,
          recordId,
          'run-rw-path',
          JSON.stringify(reworkSubmission(prepared.packet, [firstChange])),
        ),
      'schema_invalid',
    );
    assert.match(err.message, /integrity mismatch/);
  });

  it('rejects packets whose edit_signals do not match the signal schema', async () => {
    const { repo, recordId } = await reworkRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-rw-bad' });
    await rewriteSignals(prepared.packetPath, (signals) =>
      signals.map((signal, index) => (index === 0 ? { ...signal, role: 'vandal' } : signal)),
    );
    await expectError(
      () => ingestSubmission(repo, recordId, 'run-rw-bad', JSON.stringify(reworkSubmission(prepared.packet, []))),
      'schema_invalid',
    );
  });
});

describe('re-analysis preserves human decisions (design 24.4)', () => {
  it('keeps an approved candidate untouched while a new run appends a new one', async () => {
    const { repo, recordId } = await preparedRepo();
    const first = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-t10-a' });
    await ingestSubmission(repo, recordId, 'run-t10-a', JSON.stringify(buildSubmission(first.packet)));

    const loaded = await repo.loadCandidates(recordId);
    const approved = await repo.updateCandidates(recordId, loaded, (file) => ({
      ...file,
      candidates: file.candidates.map((candidate) => ({
        ...candidate,
        status: 'approved' as const,
        decision: {
          action: 'approve' as const,
          content_hash: candidate.fingerprint,
          target_kind: 'harness' as const,
          at: new Date().toISOString(),
        },
        decision_history: [
          ...candidate.decision_history,
          {
            action: 'approve' as const,
            content_hash: candidate.fingerprint,
            target_kind: 'harness' as const,
            at: new Date().toISOString(),
          },
        ],
      })),
    }));
    assert.equal(approved.doc.candidates[0]?.status, 'approved');

    const second = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-t10-b' });
    const submission = buildSubmission(second.packet);
    submission.candidates[0]!.title = '大消息分块时必须保留覆盖清单';
    submission.candidates[0]!.proposed_content = '分块后仍需保证每条用户消息归属唯一块，避免审查遗漏。';
    const manifest = await ingestSubmission(repo, recordId, 'run-t10-b', JSON.stringify(submission));
    assert.deepEqual(manifest.new_candidate_ids, ['learning-002']);

    const after = await repo.loadCandidates(recordId);
    const kept = after.doc.candidates.find((candidate) => candidate.id === 'learning-001');
    assert.equal(kept?.status, 'approved', 'a re-run must never overwrite a human decision');
    assert.equal(kept?.decision?.action, 'approve');
    assert.equal(kept?.needs_review, undefined);
    assert.equal(after.doc.candidates.length, 2);
  });

  it('flags candidates whose evidence left the freshly frozen range with needs_review', async () => {
    const { repo, recordId } = await preparedRepo();
    const first = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-t10-c' });
    await ingestSubmission(repo, recordId, 'run-t10-c', JSON.stringify(buildSubmission(first.packet)));

    const shortened = path.join(await tempDir('sca-short-source-'), 'source.jsonl');
    const meta = (await fs.readFile(CODEX_FIXTURE, 'utf8')).split('\n')[0]!;
    await fs.writeFile(shortened, `${meta}\n`);
    const current = await repo.loadAnalyze(recordId);
    await repo.updateAnalyze(recordId, current, (doc) => ({ ...doc, transcript_path: shortened }));
    await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-t10-d' });

    await ingestSubmission(repo, recordId, 'run-t10-d', JSON.stringify({ episodes: [], candidates: [] }));
    const after = await repo.loadCandidates(recordId);
    const flagged = after.doc.candidates.find((candidate) => candidate.id === 'learning-001');
    assert.match(flagged?.needs_review?.reason ?? '', /absent from the latest frozen packet/);
    assert.equal(flagged?.status, 'proposed', 'flagging must not change the review state');
  });
});

describe('cli ingest', () => {
  function capture(stdinText?: string): { io: CliIo; out: string[] } {
    const out: string[] = [];
    return {
      io: {
        env: {},
        stdout: (line) => out.push(line),
        stderr: () => undefined,
        ...(stdinText === undefined ? {} : { readStdin: () => Promise.resolve(stdinText) }),
      },
      out,
    };
  }

  it('runs the prepare → submission → ingest loop over stdin', async () => {
    const { repo, recordId, root } = await preparedRepo();
    const prepared = await prepareRecord(repo, recordId, { owner: 'skill', runId: 'run-cli-1' });
    const submissionFile = path.join(await tempDir('sca-ingest-sub-'), 'submission.json');
    await fs.writeFile(submissionFile, JSON.stringify(buildSubmission(prepared.packet)), 'utf8');

    const cap = capture();
    const code = await runCli(
      ['ingest', recordId, '--run', 'run-cli-1', '--submission', submissionFile, '--data-root', root],
      cap.io,
    );
    assert.equal(code, 0);
    const manifest = JSON.parse(cap.out[0] ?? '{}') as Record<string, unknown>;
    assert.equal(manifest['ok'], true);
    assert.deepEqual(manifest['new_candidate_ids'], ['learning-001']);

    const stdinCap = capture(JSON.stringify(buildSubmission(prepared.packet)));
    const stdinCode = await runCli(
      ['ingest', recordId, '--run', 'run-cli-1', '--data-root', root],
      stdinCap.io,
    );
    assert.equal(stdinCode, 0);
    const secondManifest = JSON.parse(stdinCap.out[0] ?? '{}') as { duplicate?: boolean };
    assert.equal(secondManifest.duplicate, true);
  });

  it('fails with exit code 2 when --run is missing', async () => {
    const { recordId, root } = await preparedRepo();
    const cap = capture();
    const code = await runCli(['ingest', recordId, '--data-root', root], cap.io);
    assert.equal(code, 2);
    assert.ok(cap.out[0]?.includes('schema_invalid'));
  });
});
