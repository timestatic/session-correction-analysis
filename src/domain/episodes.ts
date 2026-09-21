import { z } from 'zod';

import { episodeIdSchema, isoDateTimeSchema } from './ids.js';
import { eventSourceRefSchema } from './events.js';

export const confidenceSchema = z.enum(['high', 'medium', 'low', 'uncertain']);
export type Confidence = z.infer<typeof confidenceSchema>;

/** Formal detection set: explicit verdict with high or medium confidence (design 29.1). */
export function isFormalConfidence(confidence: Confidence): boolean {
  return confidence === 'high' || confidence === 'medium';
}

export const evidenceIdSchema: z.ZodString = z.string().min(1);
export type EvidenceId = string;

/** Explicit model processing receipt; absence is a coverage gap, never an abstention. */
export const processedUserSchema = z.object({
  evidence_id: evidenceIdSchema,
  status: z.enum(['reviewed', 'uncertain']),
}).strict();
export type ProcessedUser = z.infer<typeof processedUserSchema>;

export const evidenceKindSchema = z.enum([
  'user_text',
  'assistant_text',
  'tool_call',
  'tool_result',
  'file_edit',
  'interrupt',
  'approval',
  'other',
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceItemSchema = z
  .object({
    id: evidenceIdSchema,
    kind: evidenceKindSchema,
    excerpt: z.string().min(1),
    source_ref: eventSourceRefSchema,
    truncated: z.boolean().default(false),
  })
  .strict();
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const citationSchema = z
  .object({
    evidence_id: evidenceIdSchema,
    quote: z.string().min(1),
  })
  .strict();

export const reworkOutcomeSchema = z.enum(['undone', 'replaced', 'fixed', 'none', 'unknown']);
export type ReworkOutcome = z.infer<typeof reworkOutcomeSchema>;

export const interventionKindSchema = z.enum([
  'interrupt_turn',
  'stop_direction',
  'forbid_action',
  'force_reorder',
  'takeover',
  'deny_operation',
  'other',
]);
export type InterventionKind = z.infer<typeof interventionKindSchema>;

const correctionJudgementSchema = z
  .object({
    detected: z.boolean(),
    subtype: z.string().min(1).optional(),
    confidence: confidenceSchema,
    prior_agent_behavior: z.array(evidenceIdSchema),
    agent_behavior_after: z.array(evidenceIdSchema),
    rework: z
      .object({
        outcome: reworkOutcomeSchema,
        evidence: z.array(evidenceIdSchema),
      })
      .strict()
      .optional(),
    explanation: z.string().min(1),
  })
  .strict();

const interventionJudgementSchema = z
  .object({
    detected: z.boolean(),
    kind: interventionKindSchema.optional(),
    confidence: confidenceSchema,
    evidence: z.array(evidenceIdSchema),
    explanation: z.string().min(1),
  })
  .strict();

const episodeFields = {
  anchor_event_id: evidenceIdSchema,
  issue_anchor: z.string().min(1).max(200),
  correction: correctionJudgementSchema,
  intervention: interventionJudgementSchema,
  citations: z.array(citationSchema).min(1),
};

/** An episode must assert at least one of the two independent labels. */
function assertsALabel(episode: {
  correction: { detected: boolean };
  intervention: { detected: boolean };
}): boolean {
  return episode.correction.detected || episode.intervention.detected;
}

/**
 * What the host model may submit for one episode. Strict by design: authority
 * fields such as status, reviewer or timestamps are owned by application code.
 */
export const episodeSubmissionSchema = z.object(episodeFields).strict().refine(assertsALabel, {
  message: 'an episode must assert at least one label',
});
export type EpisodeSubmission = z.infer<typeof episodeSubmissionSchema>;

export const episodeCommittedSchema = z
  .object({
    ...episodeFields,
    id: episodeIdSchema,
    run_id: z.string().min(1),
    recorded_at: isoDateTimeSchema,
  })
  .strict()
  .refine(assertsALabel, {
    message: 'an episode must assert at least one label',
  });
export type EpisodeCommitted = z.infer<typeof episodeCommittedSchema>;
