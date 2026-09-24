import { sha256Tag } from '../domain/hash.js';
import type { Event, EventKind } from '../domain/events.js';
import { ScaError } from '../domain/errors.js';
import { endsWithNewline, readJsonl } from './reader.js';
import { bumpIgnored, coverageFromStats, emptyStats, PARSER_VERSION } from './types.js';
import type { NormalizedTranscript, TranscriptStats } from './types.js';

interface CodexPayload {
  type?: string;
  id?: string;
  role?: string;
  content?: { type?: string; text?: string }[];
  call_id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  output?: unknown;
  item?: { type?: string; id?: string; content?: { type?: string; text?: string }[] };
  turn_id?: string;
}
interface CodexLine {
  type?: string;
  timestamp?: string;
  ordinal?: number;
  payload?: CodexPayload;
}

function joinText(parts: { type?: string; text?: string }[] | undefined): string | undefined {
  if (!parts) {
    return undefined;
  }
  const texts = parts
    .map((p) => p.text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function turnOf(payload: CodexPayload): string | undefined {
  const meta = (payload as unknown as { internal_chat_message_metadata_passthrough?: { turn_id?: string } })
    .internal_chat_message_metadata_passthrough;
  return meta?.turn_id ?? payload.turn_id;
}

function classifyCall(name: string | undefined): EventKind {
  if (name === 'apply_patch') {
    return 'file_edit';
  }
  return 'tool_call';
}

function wrappedPatch(name: string | undefined, input: string): string | undefined {
  if (name !== 'exec') return undefined;
  const matches = [...input.matchAll(/(?:^|[;\n])\s*text\(\s*await\s+tools\.apply_patch\(\s*("(?:\\.|[^"\\])*")\s*\)\s*\)\s*;?/gs)];
  const literal = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (literal === undefined) return undefined;
  try {
    const patch: unknown = JSON.parse(literal);
    return typeof patch === 'string' && patch.startsWith('*** Begin Patch\n') && patch.trimEnd().endsWith('*** End Patch')
      ? patch : undefined;
  } catch {
    return undefined;
  }
}

/** Codex rollout.jsonl adapter: response_item is canonical; verified item_completed mirrors merge. */
export async function adaptCodex(filePath: string): Promise<NormalizedTranscript> {
  const stats: TranscriptStats = emptyStats();
  const endsNewline = await endsWithNewline(filePath);
  const events: Event[] = [];
  let sessionId = '';
  let workspace: string | undefined;
  let ordinal = 0;

  const lastUserText = new Map<string, number>();
  const lastAssistantText = new Map<string, number>();

  for await (const line of readJsonl(filePath)) {
    stats.total_lines += 1;
    if (line.malformed) {
      if (line.isLast && !endsNewline) {
        stats.tail_incomplete = true;
      } else {
        stats.bad_lines += 1;
      }
      continue;
    }
    const record = line.value as CodexLine;
    const payload = record.payload ?? {};
    const rawLine = `L${line.line}`;

    if (record.type === 'session_meta') {
      sessionId = payload.id ?? (payload as unknown as { session_id?: string }).session_id ?? '';
      workspace = (payload as unknown as { cwd?: string }).cwd;
      continue;
    }

    if (record.type === 'compacted') {
      stats.compacted_records += 1;
      continue;
    }

    if (record.type === 'response_item') {
      const kind = payload.type;
      const id = payload.id ?? `codex:${rawLine}`;
      const turnId = turnOf(payload);
      if (kind === 'message') {
        const text = joinText(payload.content);
        if (payload.role === 'user' && text !== undefined) {
          lastUserText.set(text, events.length);
          events.push(makeEvent(id, 'user_message', ordinal++, line.line, line.raw, record.timestamp, turnId, text));
        } else if (payload.role === 'assistant' && text !== undefined) {
          lastAssistantText.set(text, events.length);
          events.push(
            makeEvent(id, 'assistant_message', ordinal++, line.line, line.raw, record.timestamp, turnId, text),
          );
        } else {
          bumpIgnored(stats, `response_item:message:${payload.role ?? 'unknown'}`);
        }
        continue;
      }
      if (kind === 'custom_tool_call' || kind === 'function_call') {
        // Older/exported transcripts used input for function calls; arguments wins when present.
        const rawInput = kind === 'function_call' && payload.arguments !== undefined ? payload.arguments : payload.input;
        const input = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput ?? '');
        const patch = wrappedPatch(payload.name, input);
        events.push(
          makeEvent(
            id,
            patch === undefined ? classifyCall(payload.name) : 'file_edit',
            ordinal++,
            line.line,
            line.raw,
            record.timestamp,
            turnId,
            patch ?? input,
            payload.call_id,
          ),
        );
        continue;
      }
      if (kind === 'custom_tool_call_output' || kind === 'function_call_output') {
        const text = outputToText(payload.output);
        events.push(
          makeEvent(id, 'tool_result', ordinal++, line.line, line.raw, record.timestamp, turnId, text, payload.call_id),
        );
        continue;
      }
      bumpIgnored(stats, `response_item:${kind ?? 'unknown'}`);
      continue;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'item_completed' && payload.item) {
        const item = payload.item;
        const text = joinText(item.content);
        if (item.type === 'UserMessage' && text !== undefined) {
          const idx = lastUserText.get(text);
          if (idx !== undefined && events[idx]?.text === text) {
            stats.mirrors_merged += 1;
            continue;
          }
        }
        if (item.type === 'AgentMessage' && text !== undefined) {
          const idx = lastAssistantText.get(text);
          if (idx !== undefined && events[idx]?.text === text) {
            stats.mirrors_merged += 1;
            continue;
          }
        }
        bumpIgnored(stats, `event_msg:item_completed:${item.type ?? 'unknown'}`);
        continue;
      }
      bumpIgnored(stats, `event_msg:${payload.type ?? 'unknown'}`);
      continue;
    }

    bumpIgnored(stats, String(record.type ?? 'unknown'));
  }

  if (sessionId === '') {
    throw new ScaError('unsupported_transcript', 'codex session_meta with an id was not found');
  }
  return {
    host: 'codex',
    source_session_id: sessionId,
    coverage: coverageFromStats(stats),
    events,
    stats,
    parser_version: PARSER_VERSION,
    ...(workspace !== undefined ? { workspace } : {}),
  };
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    return joinText(output as { type?: string; text?: string }[]) ?? JSON.stringify(output);
  }
  return JSON.stringify(output ?? '');
}

function makeEvent(
  id: string,
  kind: EventKind,
  ordinal: number,
  line: number,
  raw: string,
  timestamp: string | undefined,
  turnId: string | undefined,
  text: string,
  callId?: string,
): Event {
  return {
    id,
    kind,
    ordinal,
    role: kind === 'user_message' ? 'user' : kind === 'assistant_message' ? 'assistant' : undefined,
    ...(turnId !== undefined ? { turn_id: turnId } : {}),
    ...(callId !== undefined ? { call_id: callId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    text,
    source_ref: { line, hash: sha256Tag(raw) },
  };
}
