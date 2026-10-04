import path from 'node:path';
import { z } from 'zod';

import type { Event, MessageOrigin } from '../domain/events.js';
import { ScaError } from '../domain/errors.js';
import { sha256Hex, sha256Tag } from '../domain/hash.js';
import { endsWithNewline, readJsonl } from './reader.js';
import { bumpIgnored, coverageFromStats, emptyStats } from './types.js';
import type { NormalizedTranscript, TranscriptStats } from './types.js';

const headerSchema = z.object({
  type: z.literal('session'), version: z.literal(4), id: z.string().min(1),
  cwd: z.string().min(1).refine(value => path.isAbsolute(value)).optional(),
  createdAt: z.number().int().nonnegative(), delegationDepth: z.number().int().nonnegative(),
  isSeeded: z.boolean(), parentSession: z.string().min(1).optional(), origin: z.literal('subagent').optional(),
}).passthrough();
const rowSchema = z.object({ type: z.string().min(1), seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(), data: z.record(z.unknown()) }).passthrough();
const sourceSchema = z.object({ kind: z.string().min(1), callId: z.string().min(1).optional() }).passthrough();
const messageSchema = z.object({ role: z.string(), id: z.string().min(1).optional(),
  content: z.array(z.unknown()), source: sourceSchema.optional(), isError: z.boolean().optional(),
  toolCallId: z.string().min(1).optional() }).passthrough();
const turnStep = { turn: z.number().int().nonnegative().optional(), step: z.number().int().nonnegative().optional() };
const assistantSchema = z.object({ message: messageSchema, ...turnStep }).passthrough();
const callSchema = z.object({ name: z.string().min(1), callId: z.string().min(1), arguments: z.string(), ...turnStep }).passthrough();
const resultSchema = z.object({ message: messageSchema, error: z.unknown().optional(), ...turnStep }).passthrough();
const blockSchema = z.object({ type: z.string() }).passthrough();
const textSchema = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const nestedResultSchema = z.object({ type: z.literal('tool-result'), toolCallId: z.string().min(1),
  content: z.array(z.unknown()), isError: z.boolean().optional() }).passthrough();
const editSchema = z.object({ file_path: z.string().min(1), old_string: z.string(), new_string: z.string() }).passthrough();
const writeSchema = z.object({ file_path: z.string().min(1), content: z.string() }).passthrough();

const HOST_SOURCES = new Set(['runtime-context', 'skill-catalog', 'goal', 'agent-instructions', 'time-context',
  'tool-jobs', 'tool-goal', 'compact-checkpoint', 'skill-invocation', 'model-selection']);
const PASSIVE = new Set(['permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
  'turn/start', 'step/start', 'step/end', 'request/header', 'request/context', 'session/title-llm-request',
  'system/message', 'developer/message', 'model/selection', 'command/run', 'command/done', 'subagent/descriptor',
  'subagent/catalog', 'llm/retry', 'llm/retry-started', 'assistant/attempt', 'goal/change', 'todo/write',
  'workspace/changes', 'agent-preset/selected', 'web/deepseek-search-llm-request', 'deliverables/presented']);
const STREAM_TYPES = new Set(['assistant/chunk', 'text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

function origin(kind: string | undefined): MessageOrigin {
  const value = kind === 'user' || kind === 'user-approval' ? 'human'
    : kind === 'agent-message' || kind === 'subagent-settled' || kind === 'agent-teams-command' ? 'agent'
      : kind !== undefined && HOST_SOURCES.has(kind) ? 'host_generated' : 'unknown';
  return { kind: value, basis: kind === undefined ? 'unavailable' : 'native_metadata' };
}

function contentText(content: readonly unknown[], stats: TranscriptStats): string {
  const texts: string[] = [];
  for (const value of content) {
    const block = blockSchema.parse(value);
    if (block.type === 'text') texts.push(textSchema.parse(value).text);
    else if (block.type === 'tool-result') texts.push(contentText(nestedResultSchema.parse(value).content, stats));
    else if (block.type !== 'tool-call' && block.type !== 'reasoning') {
      bumpIgnored(stats, `content:${block.type}`);
      stats.bad_lines += 1;
    }
  }
  return texts.join('\n');
}

function editMetadata(name: string, args: string): Event['edit'] {
  if (name !== 'edit' && name !== 'write') return undefined;
  let value: unknown;
  try { value = JSON.parse(args) as unknown; }
  catch { throw new ScaError('unsupported_transcript', 'DSH edit tool arguments are not valid JSON'); }
  const input = name === 'edit' ? editSchema.parse(value) : writeSchema.parse(value);
  return { paths: [input.file_path], region_keys: name === 'edit'
    ? [sha256Hex(JSON.stringify([input.file_path, editSchema.parse(value).old_string])).slice(0, 16)] : [] };
}

/** Reads a decoded v4 log; compression and freezing belong to the host input boundary. */
export async function adaptDsh(filePath: string): Promise<NormalizedTranscript> {
  const stats = emptyStats();
  const events: Event[] = [];
  const newline = await endsWithNewline(filePath);
  let header: z.infer<typeof headerSchema> | undefined;
  let previous = -1;
  let inheritedCut: number | undefined;
  let title: string | undefined;
  const committedSteps = new Set<string>();
  const committedToolSteps = new Set<string>();
  const streamedSteps = new Set<string>();
  const streamedToolSteps = new Set<string>();
  try {
    for await (const line of readJsonl(filePath)) {
      stats.total_lines += 1;
      if (line.malformed) {
        if (header === undefined) throw new ScaError('unsupported_transcript', 'DSH identity header is malformed');
        if (line.isLast && !newline) stats.tail_incomplete = true;
        else stats.bad_lines += 1;
        continue;
      }
      if (header === undefined) {
        header = headerSchema.parse(line.value);
        const generation = /^session(?:\.v([1-9]\d*))?\.jsonl$/.exec(path.basename(filePath));
        if (generation !== null && Number(generation[1] ?? 0) !== header.version) {
          throw new ScaError('unsupported_transcript', 'DSH filename and header identify different format versions');
        }
        continue;
      }
      const row = rowSchema.parse(line.value);
      if (row.seq <= previous) throw new ScaError('unsupported_transcript', 'DSH event sequence must increase strictly');
      if (row.seq !== previous + 1) stats.bad_lines += 1;
      previous = row.seq;
      const base: Event = { id: `dsh:${row.seq}`, ordinal: events.length, kind: 'tool_call',
        timestamp: new Date(row.time).toISOString(), source_ref: { line: line.line, hash: sha256Tag(line.raw) } };
      const stepKey = `${String(row.data['turn'])}:${String(row.data['step'])}`;
      if (STREAM_TYPES.has(row.type)) {
        if (row.data['turn'] === undefined || row.data['step'] === undefined) stats.tail_incomplete = true;
        else (row.type === 'tool-call-chunks' ? streamedToolSteps : streamedSteps).add(stepKey);
        bumpIgnored(stats, row.type); continue;
      }
      if (row.type === 'session/end-seed') {
        const marker = z.object({ inherited: z.literal(true).optional() }).strict().parse(row.data);
        if (marker.inherited === true) {
          if (!header.isSeeded || inheritedCut !== undefined) throw new ScaError('unsupported_transcript', 'DSH inherited boundary disagrees with its header');
          inheritedCut = events.length;
        }
        continue;
      }
      if (row.type === 'user/message') {
        const message = messageSchema.parse(row.data);
        if (message.role !== 'user') throw new ScaError('unsupported_transcript', 'DSH user message role is inconsistent');
        events.push({ ...base, kind: 'user_message', role: 'user', origin: origin(message.source?.kind), text: contentText(message.content, stats) });
      } else if (row.type === 'assistant/message') {
        const data = assistantSchema.parse(row.data);
        if (data.message.role !== 'assistant') throw new ScaError('unsupported_transcript', 'DSH assistant role is inconsistent');
        committedSteps.add(stepKey);
        const text = contentText(data.message.content, stats);
        if (text.length > 0) events.push({ ...base, kind: 'assistant_message', role: 'assistant', text,
          ...(data.turn === undefined ? {} : { turn_id: String(data.turn) }) });
      } else if (row.type === 'tool/call') {
        const data = callSchema.parse(row.data);
        committedToolSteps.add(stepKey);
        const edit = editMetadata(data.name, data.arguments);
        events.push({ ...base, kind: edit === undefined ? 'tool_call' : 'file_edit', call_id: data.callId,
          ...(data.turn === undefined ? {} : { turn_id: String(data.turn) }),
          text: JSON.stringify({ name: data.name, arguments: data.arguments }), ...(edit === undefined ? {} : { edit }) });
      } else if (row.type === 'tool/result') {
        const data = resultSchema.parse(row.data);
        const nested = data.message.content.map(value => nestedResultSchema.safeParse(value)).filter(item => item.success).map(item => item.data);
        const ids = new Set([data.message.source?.callId, data.message.toolCallId, ...nested.map(item => item.toolCallId)].filter(value => value !== undefined));
        if (ids.size !== 1) throw new ScaError('unsupported_transcript', 'DSH tool result call identity is missing or inconsistent');
        const flags = [data.message.isError, ...nested.map(item => item.isError)].filter(value => value !== undefined);
        const failed = (data.error !== undefined && data.error !== null) || flags.includes(true);
        const unknownOutcome = z.object({ code: z.literal('TOOL_OUTCOME_UNKNOWN') }).passthrough().safeParse(data.error).success;
        const status = unknownOutcome ? 'unknown' : failed ? 'failed' : flags.includes(false) ? 'succeeded' : 'unknown';
        events.push({ ...base, kind: 'tool_result', call_id: [...ids][0]!, text: contentText(data.message.content, stats),
          tool_status: status, ...(data.turn === undefined ? {} : { turn_id: String(data.turn) }) });
      } else if (row.type === 'approval/asked' || row.type === 'approval/decided') {
        events.push({ ...base, kind: 'approval', text: JSON.stringify({ type: row.type, ...row.data }), origin: { kind: 'unknown', basis: 'native_metadata' } });
      } else if (row.type === 'turn/end') {
        const data = z.object({ reason: z.object({ kind: z.string(), reason: z.object({ kind: z.string() }).passthrough().optional() }).passthrough() }).passthrough().parse(row.data);
        if (data.reason.kind === 'interrupted' || (data.reason.kind === 'aborted' && data.reason.reason?.kind === 'user')) {
          events.push({ ...base, kind: 'interrupt', text: JSON.stringify(data.reason), origin: { kind: data.reason.reason?.kind === 'user' ? 'human' : 'unknown', basis: 'native_metadata' } });
        }
      } else if (row.type === 'session/title') {
        title = z.object({ title: z.string() }).passthrough().parse(row.data).title;
      } else if (row.type.startsWith('compaction/')) {
        stats.compacted_records += 1; bumpIgnored(stats, row.type);
      } else {
        bumpIgnored(stats, row.type);
        // Unknown event producers may carry messages or nested edits; never claim full coverage.
        if (!PASSIVE.has(row.type)) stats.bad_lines += 1;
      }
    }
    if (header === undefined) throw new ScaError('unsupported_transcript', 'DSH identity header was not found');
    if (header.isSeeded && inheritedCut === undefined) throw new ScaError('unsupported_transcript', 'DSH seeded session has no verified inherited boundary');
    if ([...streamedSteps].some(key => !committedSteps.has(key)) ||
        [...streamedToolSteps].some(key => !committedToolSteps.has(key))) stats.tail_incomplete = true;
    events.forEach((event, index) => { if (index < (inheritedCut ?? 0)) event.inherited = true; });
    return { host: 'dsh', source_session_id: header.id, events, stats, parser_version: 'dsh-v4/0.1.0', format_version: 4,
      coverage: stats.compacted_records > 0 ? 'partial' : coverageFromStats(stats),
      ...(header.cwd === undefined ? {} : { workspace: header.cwd }), ...(title === undefined ? {} : { title }),
      ...(header.parentSession === undefined ? {} : { parent_session_id: header.parentSession }), inherited_events: inheritedCut ?? 0 };
  } catch (error) {
    if (error instanceof ScaError) throw error;
    if (error instanceof z.ZodError || error instanceof RangeError) throw new ScaError('unsupported_transcript', 'DSH v4 log failed structural validation');
    throw error;
  }
}
