import { sha256Tag } from '../domain/hash.js';
import type { Event, EventKind } from '../domain/events.js';
import { ScaError } from '../domain/errors.js';
import { endsWithNewline, readJsonl } from './reader.js';
import { bumpIgnored, coverageFromStats, emptyStats, PARSER_VERSION } from './types.js';
import type { NormalizedTranscript, TranscriptStats } from './types.js';

interface ClaudeBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface ClaudeLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: string | ClaudeBlock[] };
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function blocks(content: string | ClaudeBlock[] | undefined): ClaudeBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content ?? [];
}

function classifyToolUse(name: string | undefined): EventKind {
  return name !== undefined && EDIT_TOOLS.has(name) ? 'file_edit' : 'tool_call';
}

/** Claude Code transcript adapter: uuid chain entries; user entries may carry tool_result blocks. */
export async function adaptClaude(filePath: string): Promise<NormalizedTranscript> {
  const stats: TranscriptStats = emptyStats();
  const endsNewline = await endsWithNewline(filePath);
  const events: Event[] = [];
  let sessionId = '';
  let workspace: string | undefined;
  let ordinal = 0;

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
    const record = line.value as ClaudeLine;
    if (record.sessionId !== undefined && record.sessionId !== '') {
      sessionId ||= record.sessionId;
    }
    workspace ||= record.cwd;
    if (record.isSidechain === true) {
      stats.sidechain_records += 1;
      continue;
    }
    if (record.type !== 'user' && record.type !== 'assistant') {
      bumpIgnored(stats, String(record.type ?? 'unknown'));
      continue;
    }
    const id = record.uuid ?? `claude:L${line.line}`;
    for (const [blockIndex, block] of blocks(record.message?.content).entries()) {
      const blockId = `${id}:block:${String(blockIndex)}`;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        const kind: EventKind =
          record.type === 'user' && block.text.startsWith('[Request interrupted')
            ? 'interrupt'
            : record.type === 'user'
              ? 'user_message'
              : 'assistant_message';
        events.push(makeEvent(blockId, kind, ordinal++, line.line, line.raw, record.timestamp, block.text));
      } else if (block.type === 'tool_use') {
        events.push(
          makeEvent(
            block.id ?? `${blockId}:tu`,
            classifyToolUse(block.name),
            ordinal++,
            line.line,
            line.raw,
            record.timestamp,
            JSON.stringify(block.input ?? ''),
            block.id,
          ),
        );
      } else if (block.type === 'tool_result') {
        const text =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '');
        events.push(
          makeEvent(
            `${blockId}:tr`,
            'tool_result',
            ordinal++,
            line.line,
            line.raw,
            record.timestamp,
            block.is_error === true ? `ERROR: ${text}` : text,
            block.tool_use_id,
          ),
        );
      } else {
        bumpIgnored(stats, `block:${block.type ?? 'unknown'}`);
      }
    }
  }

  if (sessionId === '') {
    throw new ScaError('unsupported_transcript', 'claude sessionId was not found');
  }
  return {
    host: 'claude',
    source_session_id: sessionId,
    coverage: coverageFromStats(stats),
    events,
    stats,
    parser_version: PARSER_VERSION,
    ...(workspace !== undefined ? { workspace } : {}),
  };
}

function makeEvent(
  id: string,
  kind: EventKind,
  ordinal: number,
  line: number,
  raw: string,
  timestamp: string | undefined,
  text: string,
  callId?: string,
): Event {
  return {
    id,
    kind,
    ordinal,
    role: kind === 'user_message' || kind === 'interrupt' ? 'user' : kind === 'assistant_message' ? 'assistant' : undefined,
    ...(callId !== undefined ? { call_id: callId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    text,
    source_ref: { line, hash: sha256Tag(raw) },
  };
}
