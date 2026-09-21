import { z } from 'zod';

import { hostSchema, isoDateTimeSchema } from './ids.js';
import { sha256HashSchema } from './hash.js';

export const sourceKindSchema = z.enum([
  'codex_transcript',
  'claude_transcript',
  'normalized_transcript',
  'context_snapshot',
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const coverageSchema = z.enum(['full', 'partial', 'unknown']);
export type Coverage = z.infer<typeof coverageSchema>;

/**
 * Frozen input snapshot (design 22.1). Host/model info is recorded only when the
 * host can provide it; unknown values stay absent, they are never filled with 0.
 */
export const snapshotSchema = z
  .object({
    source_kind: sourceKindSchema,
    host: hostSchema,
    source_session_id: z.string().min(1),
    coverage: coverageSchema,
    cutoff_event_id: z.string().min(1).optional(),
    cutoff_byte_offset: z.number().int().nonnegative().optional(),
    source_fingerprint: sha256HashSchema.optional(),
    parser_version: z.string().min(1),
    rule_version: z.string().min(1),
    prompt_hash: sha256HashSchema.optional(),
    host_version: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    captured_at: isoDateTimeSchema.optional(),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;

export const analysisRunStatusSchema = z.enum(['running', 'ingested', 'failed', 'aborted']);
export const runRecordSchema = z
  .object({
    run_id: z.string().min(1),
    input_hash: sha256HashSchema,
    model: z.string().min(1).optional(),
    status: analysisRunStatusSchema,
    started_at: isoDateTimeSchema,
    finished_at: isoDateTimeSchema.optional(),
  })
  .strict();
export type RunRecord = z.infer<typeof runRecordSchema>;

export const leaseSchema = z
  .object({
    run_id: z.string().min(1),
    owner: z.string().min(1),
    acquired_at: isoDateTimeSchema,
    expires_at: isoDateTimeSchema,
    generation: z.number().int().nonnegative(),
    input_hash: sha256HashSchema.optional(),
  })
  .strict();
export type Lease = z.infer<typeof leaseSchema>;
