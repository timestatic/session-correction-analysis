import { z } from 'zod';

import { candidateSchema } from './candidates.js';
import { errorPayloadSchema } from './errors.js';
import { episodeCommittedSchema, evidenceItemSchema, processedUserSchema } from './episodes.js';
import { sha256HashSchema } from './hash.js';
import { hostSchema, isoDateTimeSchema } from './ids.js';
import { requestReceiptSchema } from './request.js';
import { leaseSchema, runRecordSchema, snapshotSchema } from './snapshot.js';

export const SCHEMA_ID = 'session-correction-analysis/v1' as const;
export const schemaIdSchema = z.literal(SCHEMA_ID);

export const analysisStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'stale',
]);
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;

export const triggerSchema = z.enum([
  'session_end',
  'manual_skill',
  'scheduled_drain',
  'explicit_import',
]);
export type Trigger = z.infer<typeof triggerSchema>;

/** The committed fact section rebuilt by every successful ingest. */
export const analyzeFactsSchema = z
  .object({
    snapshot: snapshotSchema,
    episodes: z.array(episodeCommittedSchema).default([]),
    evidence: z.array(evidenceItemSchema).default([]),
    processed_users: z.array(processedUserSchema).default([]),
    // Immutable provenance for retained candidates; never counted as current-run detections.
    candidate_sources: z.array(z.object({
      candidate_id: z.string().min(1),
      episodes: z.array(episodeCommittedSchema),
      evidence: z.array(evidenceItemSchema),
    }).strict()).default([]),
    runs: z.array(runRecordSchema).default([]),
    parse_errors: z.array(errorPayloadSchema).default([]),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type AnalyzeFacts = z.infer<typeof analyzeFactsSchema>;

export const pendingCommitSchema = z
  .object({
    analysis_id: z.string().min(1),
    input_digest: sha256HashSchema,
    created_at: isoDateTimeSchema,
    facts: analyzeFactsSchema,
    candidates: z.array(candidateSchema).default([]),
  })
  .strict();
export type PendingCommit = z.infer<typeof pendingCommitSchema>;

export const analyzeDocumentSchema = z
  .object({
    schema: schemaIdSchema,
    session_id: z.string().min(1),
    session_title: z.string().min(1).optional(),
    source: hostSchema,
    project_name: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    transcript_path: z.string().min(1).optional(),
    trigger: triggerSchema,
    analysis_status: analysisStatusSchema,
    analysis_id: z.string().min(1).optional(),
    transcript_fingerprint: sha256HashSchema.optional(),
    analyzer_version: z.string().min(1),
    revision: z.number().int().positive(),
    created_at: isoDateTimeSchema,
    analyzed_at: isoDateTimeSchema.nullable().optional(),
    error: errorPayloadSchema.nullable().optional(),
    lease: leaseSchema.nullable().optional(),
    pending_commit: pendingCommitSchema.nullable().optional(),
    facts: analyzeFactsSchema.optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type AnalyzeDocument = z.infer<typeof analyzeDocumentSchema>;

export { requestReceiptSchema };
export type { RequestReceipt } from './request.js';

export const candidatesDocumentSchema = z
  .object({
    schema: schemaIdSchema,
    session_id: z.string().min(1),
    analysis_id: z.string().min(1).optional(),
    analysis_revision: z.number().int().positive().optional(),
    revision: z.number().int().positive(),
    /** Derived fields; the store must recompute and refuse contradictory values. */
    candidate_count: z.number().int().nonnegative(),
    published_count: z.number().int().nonnegative(),
    updated_at: isoDateTimeSchema,
    /** Set by the ingest that applied a pending commit, for recovery comparison. */
    applied_analysis_id: z.string().min(1).optional(),
    candidates: z.array(candidateSchema).default([]),
    request_log: z.array(requestReceiptSchema).default([]),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CandidatesDocument = z.infer<typeof candidatesDocumentSchema>;
