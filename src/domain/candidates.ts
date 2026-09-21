import { z } from 'zod';

import { candidateIdSchema, isoDateTimeSchema } from './ids.js';
import { confidenceSchema, evidenceIdSchema } from './episodes.js';
import { errorPayloadSchema } from './errors.js';
import { sha256HashSchema } from './hash.js';

export const candidateStatusSchema = z.enum([
  'proposed',
  'approved',
  'published',
  'rejected',
  'publish_failed',
  'superseded',
]);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

/** Independent of publish status; never used for automatic promotion. */
export const maturitySchema = z.enum(['single_session', 'repeated', 'validated', 'contradicted']);
export type Maturity = z.infer<typeof maturitySchema>;

export const targetKindSchema = z.enum(['harness', 'memory']);
export type TargetKind = z.infer<typeof targetKindSchema>;

export const targetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('harness'),
      path: z.string().min(1).optional(),
      section: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('memory'),
      scope: z.enum(['project', 'user']).optional(),
    })
    .strict(),
]);
export type Target = z.infer<typeof targetSchema>;

/** What the model may propose for a candidate; no authority fields allowed. */
export const candidateSubmissionSchema = z
  .object({
    title: z.string().min(1).max(200),
    category: z.string().min(1),
    confidence: confidenceSchema,
    proposed_content: z.string().min(1),
    applicable_scope: z.string().min(1).optional(),
    trigger_condition: z.string().min(1).optional(),
    exceptions: z.string().min(1).optional(),
    not_applicable: z.string().min(1).optional(),
    evidence: z.array(evidenceIdSchema).min(1),
    source_episode_anchor: z.string().min(1),
    source_issue_anchor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CandidateSubmission = z.infer<typeof candidateSubmissionSchema>;

export const decisionActionSchema = z.enum([
  'approve',
  'reject',
  'revoke',
  'edit_content',
  'supersede',
]);
export type DecisionAction = z.infer<typeof decisionActionSchema>;

/** Every audit-relevant decision binds the exact content version it applied to. */
export const decisionRecordSchema = z
  .object({
    action: decisionActionSchema,
    content_hash: sha256HashSchema,
    target_kind: targetKindSchema,
    scope: z.string().min(1).optional(),
    at: isoDateTimeSchema,
    request_id: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

export const publicationTargetStatusSchema = z.enum([
  'pending',
  'written',
  'verified',
  'failed',
  'unchanged',
  'needs_reconciliation',
]);

export const publicationTargetResultSchema = z
  .object({
    target_id: z.string().min(1),
    display_path: z.string().min(1),
    status: publicationTargetStatusSchema,
    hash_before: sha256HashSchema.optional(),
    hash_after_expected: sha256HashSchema.optional(),
    hash_after_actual: sha256HashSchema.optional(),
    error: errorPayloadSchema.optional(),
  })
  .strict();
export type PublicationTargetResult = z.infer<typeof publicationTargetResultSchema>;

export const publicationPhaseSchema = z.enum([
  'prepared',
  'writing',
  'readback',
  'done',
  'failed',
  'needs_reconciliation',
]);
export type PublicationPhase = z.infer<typeof publicationPhaseSchema>;

export const publicationAttemptSchema = z
  .object({
    publication_id: z.string().min(1),
    phase: publicationPhaseSchema,
    candidate_hash: sha256HashSchema,
    preview_id: z.string().min(1).optional(),
    targets: z.array(publicationTargetResultSchema).min(1),
    started_at: isoDateTimeSchema,
    finished_at: isoDateTimeSchema.optional(),
  })
  .strict();
export type PublicationAttempt = z.infer<typeof publicationAttemptSchema>;

export const publicationSchema = z
  .object({
    published: z.boolean().default(false),
    publication_id: z.string().min(1).optional(),
    published_at: isoDateTimeSchema.optional(),
    attempted_at: isoDateTimeSchema.optional(),
    result: z.enum(['success', 'failed', 'aborted']).optional(),
    error: errorPayloadSchema.optional(),
    /** Optional output events for memory content; never change approval state. */
    output_at: isoDateTimeSchema.optional(),
    attempts: z.array(publicationAttemptSchema).default([]),
  })
  .strict()
  .refine(
    (publication) => publication.published === (publication.result === 'success'),
    { message: 'published flag must match the last attempt result' },
  );
export type Publication = z.infer<typeof publicationSchema>;

export const candidateSchema = z
  .object({
    id: candidateIdSchema,
    fingerprint: sha256HashSchema,
    category: z.string().min(1),
    title: z.string().min(1).max(200),
    confidence: confidenceSchema,
    status: candidateStatusSchema,
    maturity: maturitySchema.default('single_session'),
    target: targetSchema,
    evidence: z.array(evidenceIdSchema).min(1),
    source_episodes: z.array(evidenceIdSchema).min(1),
    proposed_content: z.string().min(1),
    applicable_scope: z.string().min(1).optional(),
    trigger_condition: z.string().min(1).optional(),
    exceptions: z.string().min(1).optional(),
    not_applicable: z.string().min(1).optional(),
    decision: decisionRecordSchema.nullable().default(null),
    decision_history: z.array(decisionRecordSchema).default([]),
    publication: publicationSchema.default({ published: false, attempts: [] }),
    needs_review: z
      .object({
        reason: z.string().min(1),
        flagged_at: isoDateTimeSchema,
      })
      .strict()
      .optional(),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema>;
