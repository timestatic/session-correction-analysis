import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { adaptCodex } from '../../../src/hosts/codex.js';
import { ScaError } from '../../../src/domain/errors.js';
import { stableHash, type Sha256Hash } from '../../../src/domain/hash.js';
import { PREPARE_EVENT_MAX_TEXT_CHARS } from '../../../src/domain/limits.js';
import { buildPacket, prepareRecord, PREPARE_SCHEMA, type PreparePacket } from '../../../src/analysis/prepare.js';
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

async function registeredRepo(): Promise<{ repo: RecordRepository; recordId: string; ws: string }> {
  const root = await tempDir('sca-prep-');
  const ws = await tempDir('sca-prep-ws-');
  const repo = new RecordRepository(root);
  const result = await repo.register({
    host: 'codex',
    canonicalWorkspace: '/repo/dpp_v3',
    sessionId: 'thr_fixture_1',
    transcriptPath: CODEX_FIXTURE,
    trigger: 'manual_skill',
    analyzerVersion: '0.1.0',
  });
  return { repo, recordId: result.recordId, ws };
}

async function normalizedFile(eventLines: string[]): Promise<string> {
  const dir = await tempDir('sca-prep-norm-');
  const meta = JSON.stringify({ type: 'meta', host: 'codex', source_session_id: 'norm-prep' });
  const file = path.join(dir, 'transcript.jsonl');
  await fs.writeFile(file, `${[meta, ...eventLines].join('\n')}\n`, 'utf8');
  return file;
}

function userEvent(text: string, id: string): string {
  return JSON.stringify({ type: 'event', kind: 'user_message', id, text });
}

function assistantEvent(text: string, id: string): string {
  return JSON.stringify({ type: 'event', kind: 'assistant_message', id, text });
}

describe('prepare edit signals (design 23.3)', () => {
  it('binds edit signals into a deterministic input hash while keeping hints advisory', async () => {
    const packet = await buildPacket({
      recordId: 'rec-rw',
      runId: 'run-rw',
      analysisId: 'analysis-rw',
      transcriptPath: REWORK_FIXTURE,
      ruleVersion: '0.1.0',
    });
    const changes = (packet.edit_signals ?? []).filter((signal) => signal.role === 'change');
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[0]?.paths, ['src/a.ts']);
    assert.equal(changes[0]?.success, true, 'paired Script completed makes the change valid');
    assert.ok((packet.rework_hints?.length ?? 0) >= 1);
    assert.equal(packet.rework_hints?.[0]?.level, 'file', 'different changed lines keep the hint file-level');

    // The signals are derived data: recomputing the packet must yield the same input_hash.
    const again = await buildPacket({
      recordId: 'rec-rw',
      runId: 'run-rw-2',
      analysisId: 'analysis-rw-2',
      transcriptPath: REWORK_FIXTURE,
      ruleVersion: '0.1.0',
    });
    assert.equal(packet.input_hash, again.input_hash);
    assert.equal(packet.input_hash, expectedPacketHash(packet));
  });

  it('records only result signals for a session without edits, and none at all for empty change sets', async () => {
    const packet = await buildPacket({
      recordId: 'rec-basic',
      runId: 'run-basic',
      analysisId: 'analysis-basic',
      transcriptPath: CODEX_FIXTURE,
      ruleVersion: '0.1.0',
    });
    assert.ok((packet.edit_signals?.length ?? 0) > 0, 'the read tool result still produces a result signal');
    assert.ok((packet.edit_signals ?? []).every((signal) => signal.role === 'result'));
    assert.equal(packet.rework_hints, undefined);
  });
});

describe('prepare silent tool events', () => {
  it('freezes empty-text events with a placeholder instead of failing the packet', async () => {
    const dir = await tempDir('sca-prep-empty-');
    const file = path.join(dir, 'silent.jsonl');
    const lines = [
      { type: 'session_meta', payload: { session_id: 'thr-silent', id: 'thr-silent', cwd: '/repo/silent' } },
      {
        type: 'response_item',
        payload: { type: 'message', id: 'msg_u1', role: 'user', content: [{ type: 'input_text', text: '建个目录' }] },
      },
      { type: 'response_item', payload: { type: 'function_call', id: 'fc1', name: 'shell', arguments: '' } },
      { type: 'response_item', payload: { type: 'function_call_output', id: 'fo1', call_id: 'fc1', output: '' } },
    ];
    await fs.writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

    const packet = await buildPacket({
      recordId: 'rec-silent',
      runId: 'run-silent',
      analysisId: 'analysis-silent',
      transcriptPath: file,
      ruleVersion: '0.1.0',
    });
    const silent = packet.evidence.filter((item) => item.kind === 'tool_call' || item.kind === 'tool_result');
    assert.equal(silent.length, 2);
    assert.ok(silent.every((item) => item.excerpt === '(no text)'));
  });
});

/** Independent mirror of the integrity fields; volatile run/time metadata is excluded. */
function expectedPacketHash(packet: PreparePacket): Sha256Hash {
  return stableHash({
    record_id: packet.record_id,
    snapshot: { ...packet.snapshot, captured_at: undefined },
    evidence: packet.evidence,
    blocks: packet.blocks,
    user_coverage: packet.user_coverage,
    edit_signals: packet.edit_signals ?? [],
    rule_version: packet.rule_version,
    prompt_hash: packet.prompt_hash,
    submission_schema: packet.submission_schema,
  });
}

describe('prepare packet (design 22.3)', () => {
  it('freezes identity, coverage and user-message ownership', async () => {
    const { repo, recordId } = await registeredRepo();
    const transcript = await adaptCodex(CODEX_FIXTURE);
    const outcome = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-fixed-1' });
    const packet = outcome.packet;
    assert.equal(packet.schema, PREPARE_SCHEMA);
    assert.equal(packet.record_id, recordId);
    assert.equal(packet.run_id, 'run-fixed-1');
    assert.equal(packet.snapshot.coverage, 'full');
    assert.ok(typeof packet.snapshot.source_fingerprint === 'string');
    assert.match(packet.snapshot.source_fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.ok(packet.snapshot.cutoff_byte_offset !== undefined);
    assert.match(packet.input_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(packet.prompt_hash, /^sha256:[0-9a-f]{64}$/);

    const primaries = packet.blocks.flatMap((b) => b.primary_user_event_ids);
    assert.equal(new Set(primaries).size, primaries.length, 'each user message has exactly one primary block');
    const userEvents = transcript.events.filter((e) => e.kind === 'user_message');
    assert.equal(packet.user_coverage.length, userEvents.length);
    for (const entry of packet.user_coverage) {
      assert.ok(primaries.includes(entry.event_id));
      assert.ok(entry.primary_block < packet.blocks.length);
    }
    assert.ok(packet.blocks.every((b, i) => b.index === i));
    assert.ok(packet.blocks.every((b) => new Set(b.evidence_ids).size === b.evidence_ids.length));
  });

  it('claims the lease and blocks a second live run', async () => {
    const { repo, recordId } = await registeredRepo();
    const first = await prepareRecord(repo, recordId, { owner: 'test', runId: 'run-a' });
    assert.equal(first.lease.run_id, 'run-a');
    assert.equal(first.fence.generation, first.lease.generation);
    const { doc } = await repo.loadAnalyze(recordId);
    assert.equal(doc.lease?.run_id, 'run-a');

    await assert.rejects(
      () => prepareRecord(repo, recordId, { owner: 'test', runId: 'run-b' }),
      (err: unknown) => err instanceof ScaError && err.code === 'lease_active',
    );
  });

  it('is deterministic for the same frozen range', async () => {
    const a = await buildPacket({
      recordId: 'rec-x',
      runId: 'run-1',
      analysisId: 'analysis-1',
      transcriptPath: CODEX_FIXTURE,
      ruleVersion: '0.1.0',
    });
    const b = await buildPacket({
      recordId: 'rec-x',
      runId: 'run-2',
      analysisId: 'analysis-2',
      transcriptPath: CODEX_FIXTURE,
      ruleVersion: '0.1.0',
    });
    assert.equal(a.input_hash, b.input_hash);
    assert.equal(a.snapshot.source_fingerprint, b.snapshot.source_fingerprint);
    assert.deepEqual(
      a.evidence.map((e) => e.id),
      b.evidence.map((e) => e.id),
    );
  });

  it('marks partial coverage when the transcript has a corrupt tail range', async () => {
    const packet = await buildPacket({
      recordId: 'rec-tail',
      runId: 'run-t',
      analysisId: 'analysis-t',
      transcriptPath: path.join(REPO, 'tests', 'fixtures', 'codex', 'tail-half-line.jsonl'),
      ruleVersion: '0.1.0',
    });
    assert.equal(packet.snapshot.coverage, 'partial');
  });

  it('elides oversized event text with an explicit marker, never silently', async () => {
    const file = await normalizedFile([userEvent('长'.repeat(PREPARE_EVENT_MAX_TEXT_CHARS + 500), 'big-1')]);
    const packet = await buildPacket({
      recordId: 'rec-big',
      runId: 'run-big',
      analysisId: 'analysis-big',
      transcriptPath: file,
      ruleVersion: '0.1.0',
    });
    const item = packet.evidence[0];
    assert.ok(item?.truncated);
    assert.ok(item?.excerpt.endsWith('…[TRUNCATED]'));
    assert.equal((item?.excerpt.length ?? 0) - '…[TRUNCATED]'.length, PREPARE_EVENT_MAX_TEXT_CHARS);
  });

  it('splits a huge turn across blocks without dropping evidence', async () => {
    const many: string[] = [userEvent('开始', 'u-1')];
    for (let i = 0; i < 400; i += 1) {
      many.push(assistantEvent(`step ${i} ${'y'.repeat(600)}`, `a-${i}`));
    }
    const file = await normalizedFile(many);
    const packet = await buildPacket({
      recordId: 'rec-split',
      runId: 'run-split',
      analysisId: 'analysis-split',
      transcriptPath: file,
      ruleVersion: '0.1.0',
    });
    assert.ok(packet.blocks.length > 1, 'budget must produce multiple blocks');
    assert.ok(packet.blocks.some((b) => b.truncated), 'mid-turn split is explicit');
    const covered = new Set(packet.blocks.flatMap((b) => b.evidence_ids));
    assert.equal(covered.size, packet.evidence.length, 'no evidence may be dropped');
    assert.deepEqual(
      packet.user_coverage.map((c) => c.event_id),
      ['u-1'],
      'ownership stays in exactly one block',
    );
    assert.deepEqual(packet.blocks[0]?.primary_user_event_ids, ['u-1']);
    assert.ok(
      packet.blocks.slice(1).every((b) => b.primary_user_event_ids.length === 0),
      'continuation blocks never re-own a user message',
    );
  });

  it('writes the packet to deletable runtime storage and digests existing candidates', async () => {
    const { repo, recordId } = await registeredRepo();
    const outcome = await prepareRecord(repo, recordId, { owner: 'test' });
    const raw = await fs.readFile(outcome.packetPath, 'utf8');
    const reparsed = JSON.parse(raw) as { schema: string; evidence: unknown[]; submission_schema: unknown };
    assert.equal(reparsed.schema, PREPARE_SCHEMA);
    assert.equal(reparsed.evidence.length, outcome.packet.evidence.length);
    assert.ok(reparsed.submission_schema !== null);
    assert.deepEqual(outcome.packet.existing_candidates, []);
    assert.ok(outcome.packetPath.includes(path.join('runtime', 'packets', recordId)));
  });
});

describe('cli prepare', () => {
  function capture(): { io: CliIo; out: string[] } {
    const out: string[] = [];
    return { io: { env: {}, stdout: (line) => out.push(line), stderr: () => undefined }, out };
  }

  it('prints a manifest, not the transcript', async () => {
    const { repo, recordId } = await registeredRepo();
    const root = repo.paths.root;
    const cap = capture();
    const code = await runCli(['prepare', recordId, '--data-root', root, '--owner', 'skill'], cap.io);
    assert.equal(code, 0);
    const manifest = JSON.parse(cap.out[0] ?? '{}') as Record<string, unknown>;
    assert.equal(manifest['ok'], true);
    assert.equal(manifest['record_id'], recordId);
    assert.equal(manifest['user_message_count'], 1);
    assert.ok(typeof manifest['largest_evidence_bytes'] === 'number');
    assert.equal(manifest['pending_limit_bytes'], 262_144);
    assert.ok(typeof manifest['input_hash'] === 'string');
    assert.ok(!('evidence' in manifest), 'manifest must not carry evidence content');
    assert.ok(!JSON.stringify(manifest).includes('excerpt'));
  });

  it('refuses a missing record id before touching storage', async () => {
    const cap = capture();
    const code = await runCli(['prepare', '--data-root', await tempDir('sca-prep-unused-')], cap.io);
    assert.equal(code, 2);
    assert.ok(cap.out[0]?.includes('schema_invalid'));
  });
});
