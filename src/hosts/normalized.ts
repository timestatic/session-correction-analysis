import { z } from 'zod';

import { sha256Tag } from '../domain/hash.js';
import type { Event } from '../domain/events.js';
import { ScaError } from '../domain/errors.js';
import { hostSchema, isoDateTimeSchema } from '../domain/ids.js';
import { eventKindSchema } from '../domain/events.js';
import { endsWithNewline, readJsonl } from './reader.js';
import { bumpIgnored, coverageFromStats, emptyStats, PARSER_VERSION } from './types.js';
import type { NormalizedTranscript } from './types.js';

/**
 * Frozen normalized import contract (design 30, T07a): UTF-8 JSONL, first
 * record is the identity meta line, every later line is one event. A bad meta
 * fails closed as unsupported_transcript; bad event lines degrade to counted
 * bad_lines with partial coverage — never silently reinterpreted.
 */
export const normalizedMetaSchema = z
  .object({
    type: z.literal('meta'),
    host: hostSchema,
    source_session_id: z.string().min(1),
    workspace: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .strict();

export const normalizedEventSchema = z
  .object({
    type: z.literal('event'),
    kind: eventKindSchema,
    id: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    turn_id: z.string().min(1).optional(),
    call_id: z.string().min(1).optional(),
    timestamp: isoDateTimeSchema.optional(),
    text: z.string().min(1),
  })
  .strict();

/** Explicitly imported normalized transcript: first line must be the identity meta record. */
export async function adaptNormalized(filePath: string): Promise<NormalizedTranscript> {
  const stats = emptyStats();
  const endsNewline = await endsWithNewline(filePath);
  const events: Event[] = [];
  let meta: z.infer<typeof normalizedMetaSchema> | null = null;
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
    if (meta === null) {
      const parsedMeta = normalizedMetaSchema.safeParse(line.value);
      if (!parsedMeta.success) {
        throw new ScaError(
          'unsupported_transcript',
          'normalized transcript must start with an identity meta record',
        );
      }
      meta = parsedMeta.data;
      continue;
    }
    const parsed = normalizedEventSchema.safeParse(line.value);
    if (!parsed.success) {
      bumpIgnored(stats, 'normalized:invalid_event_line');
      stats.bad_lines += 1;
      continue;
    }
    const e = parsed.data;
    events.push({
      id: e.id ?? `norm:L${line.line}`,
      kind: e.kind,
      ordinal: ordinal++,
      ...(e.role !== undefined ? { role: e.role } : {}),
      ...(e.turn_id !== undefined ? { turn_id: e.turn_id } : {}),
      ...(e.call_id !== undefined ? { call_id: e.call_id } : {}),
      ...(e.timestamp !== undefined ? { timestamp: e.timestamp } : {}),
      text: e.text,
      source_ref: { line: line.line, hash: sha256Tag(line.raw) },
    });
  }

  if (meta === null) {
    throw new ScaError('unsupported_transcript', 'normalized transcript is empty');
  }
  return {
    host: meta.host,
    source_session_id: meta.source_session_id,
    coverage: coverageFromStats(stats),
    events,
    stats,
    parser_version: PARSER_VERSION,
    ...(meta.workspace !== undefined ? { workspace: meta.workspace } : {}),
    ...(meta.title !== undefined ? { title: meta.title } : {}),
  };
}
