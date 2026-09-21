import { z } from 'zod';

import { sha256HashSchema } from './hash.js';

export const eventKindSchema = z.enum([
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'interrupt',
  'approval',
  'file_edit',
]);
export type EventKind = z.infer<typeof eventKindSchema>;

export const eventSourceRefSchema = z
  .object({
    line: z.number().int().nonnegative().optional(),
    byte_start: z.number().int().nonnegative().optional(),
    byte_end: z.number().int().nonnegative().optional(),
    hash: sha256HashSchema,
  })
  .strict();
export type EventSourceRef = z.infer<typeof eventSourceRefSchema>;

/** Normalized event produced by host adapters; ids come from adapters, never from the model. */
export const eventSchema = z
  .object({
    id: z.string().min(1),
    kind: eventKindSchema,
    ordinal: z.number().int().nonnegative(),
    role: z.string().min(1).optional(),
    turn_id: z.string().min(1).optional(),
    call_id: z.string().min(1).optional(),
    timestamp: z.string().min(1).optional(),
    text: z.string().optional(),
    source_ref: eventSourceRefSchema,
  })
  .strict();
export type Event = z.infer<typeof eventSchema>;
