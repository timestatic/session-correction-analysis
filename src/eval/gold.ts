import { z } from 'zod';

import { hostSchema } from '../domain/ids.js';
import { sha256HashSchema } from '../domain/hash.js';

/**
 * Gold labels for the dev-set replay (design 29.3, plan 2.2). They are produced
 * by humans with full context — model output can never mark its own gold — and
 * live only in the local evaluation data root, never in the repository.
 * Every gold file pins the exact frozen input it was annotated against.
 */

export const GOLD_SCHEMA = 'session-correction-analysis/gold/v1';
export const goldLabelSchema = z.enum(['correction', 'intervention']);
export type GoldLabel = z.infer<typeof goldLabelSchema>;

export const goldUnitStatusSchema = z.enum(['arbitrated', 'uncertain', 'unarbited']);
export type GoldUnitStatus = z.infer<typeof goldUnitStatusSchema>;

export const reworkGoldSchema = z.enum(['yes', 'no', 'unknown']);
export type ReworkGold = z.infer<typeof reworkGoldSchema>;

export const evalSplitSchema = z.enum(['dev', 'test', 'unused']);
export type EvalSplit = z.infer<typeof evalSplitSchema>;

export const goldUserUnitSchema = z
  .object({
    /** The packet evidence id of one user message; every message is exactly one unit. */
    evidence_id: z.string().min(1),
    event_id: z.string().min(1),
    status: goldUnitStatusSchema,
    /** Annotation rationale; required once the unit is arbitrated or abstained. */
    note: z.string().min(1).optional(),
    /** Worksheet aids copied from the frozen packet (local-only, like the excerpts). */
    line: z.number().int().nonnegative().optional(),
    excerpt: z.string().min(1).optional(),
  })
  .strict();
export type GoldUserUnit = z.infer<typeof goldUserUnitSchema>;

export const goldEpisodeSchema = z
  .object({
    /** Unique within this session; match tables reference (session_id, id). */
    id: z.string().min(1),
    labels: z.array(goldLabelSchema).min(1),
    /** The main user-feedback message that anchors the problem. */
    anchor_evidence_id: z.string().min(1),
    /** Full feedback set for this problem, including a merged reminder chain (design 29.1). */
    feedback_evidence_ids: z.array(z.string().min(1)).min(1),
    rework: reworkGoldSchema,
    /** False keeps the episode out of rework precision/recall; unknown stays reported. */
    rework_judgeable: z.boolean(),
    rationale: z.string().min(1),
  })
  .strict()
  .refine((episode) => episode.feedback_evidence_ids.includes(episode.anchor_evidence_id), {
    message: 'the anchor message must be part of the feedback set',
  });
export type GoldEpisode = z.infer<typeof goldEpisodeSchema>;

export const goldSessionSchema = z
  .object({
    schema: z.literal(GOLD_SCHEMA),
    session_id: z.string().min(1),
    host: hostSchema,
    /** Source fingerprint of the frozen range the annotation was written against. */
    source_fingerprint: sha256HashSchema,
    parser_version: z.string().min(1),
    rule_version: z.string().min(1),
    split: evalSplitSchema,
    /** false while it is only a worksheet draft awaiting human labels. */
    labeled: z.boolean(),
    /** Every user message evidence id of the frozen packet — anything absent is a coverage gap. */
    all_user_evidence_ids: z.array(z.string().min(1)),
    units: z.array(goldUserUnitSchema),
    episodes: z.array(goldEpisodeSchema),
  })
  .strict()
  .superRefine((gold, ctx) => {
    const seenUnits = new Set<string>();
    for (const unit of gold.units) {
      if (seenUnits.has(unit.evidence_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate unit evidence_id ${unit.evidence_id}` });
      }
      seenUnits.add(unit.evidence_id);
    }
    const seenEpisodes = new Set<string>();
    for (const episode of gold.episodes) {
      if (seenEpisodes.has(episode.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate gold episode id ${episode.id}` });
      }
      seenEpisodes.add(episode.id);
    }
    // Units must come from the frozen packet set; unlisted messages are a coverage gap (design 29.3),
    // scored separately and never silently treated as abstentions.
    const packetUnits = new Set(gold.all_user_evidence_ids);
    for (const unit of gold.units) {
      if (!packetUnits.has(unit.evidence_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unit ${unit.evidence_id} is not a user message of the frozen packet`,
        });
      }
    }
  });
export type GoldSession = z.infer<typeof goldSessionSchema>;

/**
 * The frozen, human-confirmed prediction↔gold matching (design 29.3): the scorer
 * validates and counts it, it never decides matches itself, and no text
 * similarity may substitute for a table entry.
 */
export const matchEntrySchema = z
  .object({
    session_id: z.string().min(1),
    /** Committed episode id (ep-…) of a formal prediction. */
    prediction_id: z.string().min(1),
    gold_id: z.string().min(1),
    label: goldLabelSchema,
  })
  .strict();
export type MatchEntry = z.infer<typeof matchEntrySchema>;
