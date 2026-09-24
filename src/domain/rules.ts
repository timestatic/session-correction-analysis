import { z } from 'zod';

import { targetKindSchema } from './candidates.js';
import { sha256HashSchema, sha256Hex } from './hash.js';
import { candidateIdSchema, isoDateTimeSchema } from './ids.js';
import { requestReceiptSchema } from './request.js';

/**
 * The root accepted-rules registry (design 31.2, lightweight adoption ledger).
 * It has its own schema id so the session-record reader and this registry
 * never share an upgrade path; entries record what the human adopted and
 * where it came from, nothing else.
 */
export const ACCEPTED_RULES_SCHEMA_ID = 'session-correction-analysis/accepted-rules/v1' as const;
export const ACCEPTED_RULES_FILE = 'accepted_rules.md';

export const ruleIdSchema: z.ZodString = z.string().regex(/^rule-[0-9a-f]{16}$/);
export type RuleId = string;

/**
 * rule_id is derived from (record_id, candidate_id), like computeEpisodeId:
 * re-adopting the same candidate can never create a second copy, so adoption
 * is idempotent without writing a rule_ref back into the candidate.
 */
export function computeRuleId(recordId: string, candidateId: string): RuleId {
  if (recordId.trim() === '' || candidateId.trim() === '') {
    throw new Error('rule identity components must not be empty');
  }
  return `rule-${sha256Hex(JSON.stringify([recordId, candidateId])).slice(0, 16)}`;
}

/** Where the rule lives for later delivery: this project only, or the user globally. */
export const ruleScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('project'),
      canonical_workspace: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('user') }).strict(),
]);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

export const ruleHistoryActionSchema = z.enum(['adopted', 'revised', 'revoked']);
export type RuleHistoryAction = z.infer<typeof ruleHistoryActionSchema>;

export const ruleHistoryEntrySchema = z
  .object({
    action: ruleHistoryActionSchema,
    at: isoDateTimeSchema,
    request_id: z.string().min(1).optional(),
    note: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type RuleHistoryEntry = z.infer<typeof ruleHistoryEntrySchema>;

/** Provenance back-pointer; the candidate document stays untouched (no double write). */
export const ruleSourceSchema = z
  .object({
    record_id: z.string().regex(/^[0-9a-f]{64}$/),
    candidate_id: candidateIdSchema,
    candidate_content_hash: sha256HashSchema,
  })
  .strict();
export type RuleSource = z.infer<typeof ruleSourceSchema>;

export const acceptedRuleStatusSchema = z.enum(['active', 'revoked']);
export type AcceptedRuleStatus = z.infer<typeof acceptedRuleStatusSchema>;

export const acceptedRuleSchema = z
  .object({
    rule_id: ruleIdSchema,
    title: z.string().min(1).max(200),
    content: z.string().min(1),
    applicable_scope: z.string().min(1).optional(),
    target_kind: targetKindSchema,
    scope: ruleScopeSchema,
    status: acceptedRuleStatusSchema,
    version: z.number().int().positive(),
    content_hash: sha256HashSchema,
    source: ruleSourceSchema,
    accepted_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
    history: z.array(ruleHistoryEntrySchema).min(1),
  })
  .strict();
export type AcceptedRule = z.infer<typeof acceptedRuleSchema>;

export const acceptedRulesDocumentSchema = z
  .object({
    schema: z.literal(ACCEPTED_RULES_SCHEMA_ID),
    /** 0 only for the synthesized missing-file view; written files start at 1. */
    revision: z.number().int().nonnegative(),
    updated_at: isoDateTimeSchema,
    rules: z.array(acceptedRuleSchema).default([]),
    request_log: z.array(requestReceiptSchema.extend({ rule_id: ruleIdSchema.optional() })).default([]),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type AcceptedRulesDocument = z.infer<typeof acceptedRulesDocumentSchema>;
