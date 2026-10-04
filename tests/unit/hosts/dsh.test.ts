import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';

import { adaptTranscript } from '../../../src/hosts/index.js';
import { buildPacket } from '../../../src/analysis/prepare.js';
import { eventSchema } from '../../../src/domain/events.js';
import { resolveDshTranscript } from '../../../src/hosts/dsh-paths.js';
import { discoverSession } from '../../../src/hosts/discover.js';
import { TRANSCRIPT_MAX_BYTES, withFrozenTranscript } from '../../../src/hosts/frozen.js';
import { ScaError } from '../../../src/domain/errors.js';

const HAS_ZSTD = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

async function fixture(rows: unknown[], compressed = false): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-dsh-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.v4.jsonl');
  await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  if (!compressed) return file;
  execFileSync('zstd', ['-q', file, '-o', `${file}.zstd`]);
  return `${file}.zstd`;
}

function header(version = 4, seeded = false): unknown {
  return { type: 'session', version, id: 'dsh-test', cwd: '/repo/test', createdAt: 1_790_000_000_000,
    delegationDepth: seeded ? 1 : 0, isSeeded: seeded, ...(seeded ? { parentSession: 'parent', origin: 'subagent' } : {}) };
}

function event(seq: number, type: string, data: unknown): unknown { return { seq, time: 1_790_000_000_000 + seq, type, data }; }
function user(seq: number, text: string, source = 'user'): unknown {
  return event(seq, 'user/message', { id: `u${seq}`, role: 'user', source: { kind: source }, content: [{ type: 'text', text }] });
}
function edit(seq: number, id: string): unknown {
  return event(seq, 'tool/call', { name: 'edit', callId: id, turn: 1, step: seq,
    arguments: JSON.stringify({ file_path: '/repo/test/a.ts', old_string: 'a', new_string: 'b' }) });
}
function result(seq: number, id: string, failed = false): unknown {
  return event(seq, 'tool/result', { turn: 1, step: seq, error: failed ? { code: 'FS_STALE_VERSION' } : null,
    message: { id: `r${seq}`, role: 'user', source: { kind: 'tool', callId: id }, isError: failed,
      content: [{ type: 'text', text: failed ? 'updated' : 'no keyword; failed appears in file content' }] } });
}

it('keeps native origins, duplicate text and committed messages while ignoring stream mirrors', async () => {
  const file = await fixture([header(), user(0, 'same'), user(1, 'same', 'agent-message'), user(2, 'context', 'time-context'),
    user(3, 'plugin', 'plugin'), event(4, 'text-chunks', { texts: ['reply'] }),
    event(5, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }, turn: 1, step: 1 })]);
  const transcript = await adaptTranscript(file);
  assert.equal(transcript.host, 'dsh');
  assert.deepEqual(transcript.events.slice(0, 4).map(item => item.origin?.kind), ['human', 'agent', 'host_generated', 'unknown']);
  assert.equal(transcript.events.filter(item => item.kind === 'assistant_message').length, 1);
  transcript.events.forEach(item => eventSchema.parse(item));
});

it('prepares compressed evidence with native edit outcomes and independent byte provenance', { skip: !HAS_ZSTD }, async () => {
  const file = await fixture([header(), user(0, 'please change'), edit(1, 'a'), result(2, 'a'),
    user(3, 'wrong direction'), edit(4, 'b'), result(5, 'b'), edit(6, 'c'), result(7, 'c', true)], true);
  const packet = await buildPacket({ recordId: 'a'.repeat(64), runId: 'run-dsh', analysisId: 'analysis-dsh', transcriptPath: file, ruleVersion: 'test' });
  assert.equal(packet.snapshot.source_kind, 'dsh_transcript');
  assert.equal(packet.snapshot.source_encoding, 'zstd');
  assert.equal(packet.snapshot.format_version, 4);
  assert.notEqual(packet.snapshot.source_fingerprint, packet.snapshot.decoded_fingerprint);
  assert.equal(packet.user_coverage.length, 2);
  assert.deepEqual(packet.edit_signals?.filter(item => item.role === 'change').map(item => item.success), [true, true, false]);
  assert.equal(packet.rework_hints?.length, 1);
});

it('retains inherited context with an explicit boundary and does not infer compaction as human text', async () => {
  const file = await fixture([header(4, true), user(0, 'parent'), event(1, 'session/end-seed', { inherited: true }),
    user(2, 'child'), event(3, 'compaction/summary', { summary: [{ type: 'text', text: 'summary' }] })]);
  const packet = await buildPacket({ recordId: 'a'.repeat(64), runId: 'run-seed', analysisId: 'analysis', transcriptPath: file, ruleVersion: 'test' });
  assert.deepEqual(packet.evidence.map(item => item.inherited ?? false), [true, false]);
  assert.equal(packet.snapshot.parent_session_id, 'parent');
  assert.equal(packet.snapshot.inherited_events, 1);
  assert.equal(packet.snapshot.coverage, 'partial');
});

it('refuses future versions, header/filename mismatches, invalid sequences and missing inherited boundaries', async () => {
  for (const rows of [[header(5)], [header(3)], [header(), user(1, 'a'), user(1, 'b')], [header(4, true), user(0, 'missing cut')]]) {
    await assert.rejects(adaptTranscript(await fixture(rows)));
  }
});

it('does not classify parent abort or system error as user intervention', async () => {
  const file = await fixture([header(), event(0, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } }),
    event(1, 'turn/end', { turn: 2, reason: { kind: 'error' } }),
    event(2, 'turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })]);
  assert.equal((await adaptTranscript(file)).events.filter(item => item.kind === 'interrupt').length, 1);
});

it('rejects a corrupt compressed source instead of accepting a decoded prefix', { skip: !HAS_ZSTD }, async () => {
  const file = await fixture([header(), user(0, 'a')], true);
  const bytes = await fs.readFile(file);
  await fs.writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
  await assert.rejects(adaptTranscript(file));
});

it('selects the highest directory generation without falling back from an unsupported version', async () => {
  const file = await fixture([header()]);
  const dir = path.dirname(file);
  const future = path.join(dir, 'session.v5.jsonl');
  await fs.writeFile(future, JSON.stringify({ type: 'session', version: 5 }) + '\n');
  await fs.writeFile(path.join(dir, 'session.lock'), '');
  assert.equal(await resolveDshTranscript(dir), future);
  await assert.rejects(adaptTranscript(await resolveDshTranscript(dir)), /structural validation/);
  assert.equal(await resolveDshTranscript(file), file);
});

it('refuses ambiguous highest encodings and does not route DSH discover into Claude history', async () => {
  const file = await fixture([header()]);
  await fs.writeFile(`${file}.zstd`, 'placeholder');
  await assert.rejects(resolveDshTranscript(path.dirname(file)), /multiple encodings/);
  await assert.rejects(discoverSession({ host: 'dsh', homeDir: path.dirname(file), workspace: '/repo/test',
    marker: 'sca-probe-00000000-0000-4000-8000-000000000000' }), /explicit v4/);
});

it('keeps unknown native outcomes and unpaired stream fragments partial', async () => {
  const rows = [header(), edit(0, 'edit'), event(1, 'tool/result', { error: { code: 'TOOL_OUTCOME_UNKNOWN' },
    message: { role: 'user', source: { kind: 'tool', callId: 'edit' }, isError: true, content: [{ type: 'text', text: 'success' }] } }),
  event(2, 'text-chunks', { turn: 1, step: 2, texts: ['unfinished'] })];
  const file = await fixture(rows);
  const transcript = await adaptTranscript(file);
  assert.equal(transcript.events.find(item => item.kind === 'tool_result')?.tool_status, 'unknown');
  assert.equal(transcript.coverage, 'partial');
});

it('does not turn duplicate native results into successful rework corroboration', async () => {
  const file = await fixture([header(), edit(0, 'a'), result(1, 'a'), result(2, 'a', true)]);
  const packet = await buildPacket({ recordId: 'a'.repeat(64), runId: 'run-duplicate', analysisId: 'analysis', transcriptPath: file, ruleVersion: 'test' });
  assert.equal(packet.edit_signals?.find(item => item.role === 'change')?.success, undefined);
});

it('retains nested tool result correlation without flattening it into a user message', async () => {
  const file = await fixture([header(), event(0, 'tool/result', { message: { role: 'user', content: [{ type: 'tool-result',
    toolCallId: 'nested', isError: false, content: [{ type: 'text', text: 'done' }] }] } })]);
  const transcript = await adaptTranscript(file);
  assert.equal(transcript.events[0]?.kind, 'tool_result');
  assert.equal(transcript.events[0]?.call_id, 'nested');
  assert.equal(transcript.events[0]?.tool_status, 'succeeded');
});

it('does not let a text commit discharge an uncommitted tool-call stream', async () => {
  const file = await fixture([header(), event(0, 'tool-call-chunks', { turn: 1, step: 1, texts: ['pending'] }),
    event(1, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } })]);
  assert.equal((await adaptTranscript(file)).coverage, 'partial');
  const committed = await fixture([header(), event(0, 'tool-call-chunks', { turn: 1, step: 1 }),
    event(1, 'tool/call', { turn: 1, step: 1, name: 'read', callId: 'read', arguments: '{}' })]);
  assert.equal((await adaptTranscript(committed)).coverage, 'full');
});

it('reports missing cwd as unavailable without inventing a workspace match', async () => {
  const h = { type: 'session', version: 4, id: 'dsh-test', createdAt: 1_790_000_000_000, delegationDepth: 0, isSeeded: false };
  const file = await fixture([h, user(0, 'hello')]);
  const packet = await buildPacket({ recordId: 'a'.repeat(64), runId: 'run-workspace', analysisId: 'analysis',
    transcriptPath: file, ruleVersion: 'test', expectedIdentity: { host: 'dsh', sessionId: 'dsh-test', workspace: '/declared' } });
  assert.equal(packet.snapshot.workspace_verification, 'unavailable');
});


it('rejects oversized compressed and decoded inputs and cleans frozen files', { skip: !HAS_ZSTD }, async () => {
  const file = await fixture([header()], true);
  await fs.truncate(file, TRANSCRIPT_MAX_BYTES + 1);
  const tooLarge = (error: unknown): boolean => error instanceof ScaError && error.code === 'payload_too_large';
  await assert.rejects(withFrozenTranscript(file, () => Promise.reject(new Error('oversized source accepted'))), tooLarge);
  await fs.writeFile(file, execFileSync('zstd', ['-q', '-c'], { input: Buffer.alloc(TRANSCRIPT_MAX_BYTES + 1, 65) }));
  await assert.rejects(withFrozenTranscript(file, () => Promise.reject(new Error('oversized decoded content accepted'))), tooLarge);
  await fs.writeFile(file, execFileSync('zstd', ['-q', '-c'], { input: Buffer.alloc(TRANSCRIPT_MAX_BYTES, 65) }));
  await withFrozenTranscript(file, async decoded => { assert.equal((await fs.stat(decoded)).size, TRANSCRIPT_MAX_BYTES); });
  const valid = await fixture([header()], true);
  let decodedPath = '';
  await assert.rejects(withFrozenTranscript(valid, async decoded => {
    decodedPath = decoded;
    await fs.access(decoded);
    throw new Error('consumer failed');
  }), (error: unknown) => error instanceof ScaError && error.code === 'transcript_unreadable');
  assert.ok(decodedPath);
  await assert.rejects(fs.access(path.dirname(decodedPath)));
  await fs.access(valid);
});

it('reports a missing decoder and cleans temporary files after decoder timeout', { skip: !HAS_ZSTD }, async () => {
  const file = await fixture([header()], true);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-decoder-test-'));
  dirs.push(dir);
  const previousPath = process.env['PATH'];
  const previousTmp = process.env['TMPDIR'];
  const unreadable = (error: unknown): boolean => error instanceof ScaError && error.code === 'transcript_unreadable';
  try {
    process.env['TMPDIR'] = dir;
    process.env['PATH'] = dir;
    await assert.rejects(withFrozenTranscript(file, () => Promise.reject(new Error('missing decoder accepted'))), unreadable);
    assert.deepEqual(await fs.readdir(dir), []);
    const fake = path.join(dir, 'zstd');
    await fs.writeFile(fake, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o755 });
    const started = Date.now();
    await assert.rejects(withFrozenTranscript(file, () => Promise.reject(new Error('timeout accepted'))), unreadable);
    assert.ok(Date.now() - started >= 29_000);
    assert.ok(Date.now() - started < 45_000);
    assert.deepEqual(await fs.readdir(dir), ['zstd']);
  } finally {
    if (previousPath === undefined) delete process.env['PATH']; else process.env['PATH'] = previousPath;
    if (previousTmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = previousTmp;
  }
});
