import { z } from 'zod';

import { evidenceIdSchema, evidenceItemSchema } from './episodes.js';
import { sha256HashSchema, sha256Hex, stableHash, type Sha256Hash } from './hash.js';
import { candidateIdSchema, episodeIdSchema, isoDateTimeSchema } from './ids.js';
import {
  ACCEPTED_RULES_MAX_RULES,
  RULE_CONTENT_MAX_BYTES,
  RULE_HISTORY_MAX_ENTRIES,
  RULE_OBSERVATION_EXPLANATION_MAX_BYTES,
  RULE_REVIEW_SNAPSHOT_MAX_EPISODES,
  RULE_REVIEW_SNAPSHOT_MAX_RULES,
  RULE_SCOPE_NOTE_MAX_BYTES,
  RULES_MIGRATE_BATCH_MAX,
  RULES_REQUEST_LOG_MAX,
} from './limits.js';
import { requestReceiptSchema } from './request.js';
import { coverageSchema } from './snapshot.js';

/**
 * Contracts for the root accepted-rules registry (design §31). The registry is
 * authoritative business data: it holds the rules the user finally approved,
 * while the session files keep the original candidates and their audit trail.
 * Nothing here writes; storage and recovery land in LC-02/LC-03.
 */

export const ACCEPTED_RULES_SCHEMA_ID = 'session-correction-analysis/accepted-rules/v1';
export const acceptedRulesSchemaIdSchema = z.literal(ACCEPTED_RULES_SCHEMA_ID);

export const RULE_REVIEW_SNAPSHOT_SCHEMA_ID = 'session-correction-analysis/rule-review-snapshot/v1';
export const ruleReviewSnapshotSchemaIdSchema = z.literal(RULE_REVIEW_SNAPSHOT_SCHEMA_ID);

export const MIGRATION_SCHEMA_ID = 'session-correction-analysis/rules-migration/v1';
export const migrationSchemaIdSchema = z.literal(MIGRATION_SCHEMA_ID);

/**
 * Frozen compatibility matrix (LC-01). A reader that does not know a schema id
 * must refuse to write it and stay read-only; there is no silent fallback and
 * no dual write, so an older binary can never half-upgrade newer state.
 */
export const RULES_SCHEMA_COMPAT = [
  {
    schema_id: 'session-correction-analysis/v1',
    surface: 'session records: analyze.md + learning_candidates.md',
    on_unknown_schema: 'read_only_refuse_write',
  },
  {
    schema_id: ACCEPTED_RULES_SCHEMA_ID,
    surface: 'root registry: accepted_rules.md',
    on_unknown_schema: 'read_only_refuse_write',
  },
  {
    schema_id: 'session-correction-analysis/publish-receipt/v1',
    surface: 'runtime publication receipt',
    on_unknown_schema: 'refuse_until_reconciled',
  },
  {
    schema_id: RULE_REVIEW_SNAPSHOT_SCHEMA_ID,
    surface: 'runtime frozen rule review input',
    on_unknown_schema: 'review_unavailable',
  },
  {
    schema_id: MIGRATION_SCHEMA_ID,
    surface: 'explicit migrate dry-run report',
    on_unknown_schema: 'refuse_apply',
  },
] as const satisfies readonly {
  schema_id: string;
  surface: string;
  on_unknown_schema: string;
}[];

export const recordIdSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'record_id must be 64 lowercase hex characters');

/**
 * rule_id is derived from the adopting source, never from the body: re-adopting
 * the same candidate replays the same id instead of creating a second rule, and
 * later edits or moves never renumber it (design 31.3).
 */
export const ruleIdSchema = z.string().regex(/^rule-[0-9a-f]{16}$/, 'must be rule-<16 hex>');
export type RuleId = string;

export function computeRuleId(recordId: string, candidateId: string): RuleId {
  if (!/^[0-9a-f]{64}$/.test(recordId) || candidateId.trim() === '') {
    throw new Error('rule identity components must not be empty');
  }
  return `rule-${sha256Hex(JSON.stringify([recordId, candidateId])).slice(0, 16)}`;
}

// --- scope ------------------------------------------------------------------

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Free text is capped in UTF-8 bytes, not characters: a character cap lets CJK
 * text (3 bytes per char) sail past every byte budget downstream, and those
 * budgets are what keeps a registry readable and a snapshot packable.
 */
function utf8Bounded(label: string, maxBytes: number): z.ZodEffects<z.ZodString> {
  return z
    .string()
    .min(1, `${label} must not be empty`)
    .refine(
      (text) => utf8Bytes(text) <= maxBytes,
      `${label} must fit ${String(maxBytes)} UTF-8 bytes; longer is rejected, never truncated`,
    );
}

const ruleContentSchema = utf8Bounded('rule content', RULE_CONTENT_MAX_BYTES);
const scopeNoteSchema = utf8Bounded('scope note', RULE_SCOPE_NOTE_MAX_BYTES);
const observationExplanationSchema = utf8Bounded(
  'explanation',
  RULE_OBSERVATION_EXPLANATION_MAX_BYTES,
);

const canonicalWorkspacePathSchema = z
  .string()
  .min(2, 'canonical_workspace must be an absolute path')
  .startsWith('/', 'canonical_workspace must be absolute')
  .refine((value) => !value.endsWith('/'), 'canonical_workspace must not end with a separator')
  .refine((value) => !value.split('/').includes('..'), 'canonical_workspace must not contain ..');

export const projectRuleScopeSchema = z
  .object({
    kind: z.literal('project'),
    canonical_workspace: canonicalWorkspacePathSchema,
    project_name: z.string().min(1).max(200).optional(),
    note: scopeNoteSchema.optional(),
  })
  .strict();

export const userRuleScopeSchema = z
  .object({
    kind: z.literal('user'),
    note: scopeNoteSchema.optional(),
  })
  .strict();

/**
 * Structured scope only (design 31.3): a project rule binds one canonical
 * workspace, a user rule was explicitly promoted by the user. Renamed paths and
 * separate worktrees are never inferred to be the same project, and free text
 * never becomes a scope.
 */
export const ruleScopeSchema = z.union([projectRuleScopeSchema, userRuleScopeSchema]);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

/** True when a rule applies to a session in `sessionWorkspace` (null: unknown). */
export function isScopeMatch(scope: RuleScope, sessionWorkspace: string | null): boolean {
  if (scope.kind === 'user') {
    return true;
  }
  return sessionWorkspace !== null && scope.canonical_workspace === sessionWorkspace;
}

// --- content version --------------------------------------------------------

export const ruleStatusSchema = z.enum(['active', 'revoked', 'superseded']);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

/**
 * The version hash binds body and applicable scope (design 31.3). The title is
 * display text and the host is never part of an identity: two hosts in one
 * project share the rule.
 */
export function ruleContentHash(input: { content: string; scope: RuleScope }): Sha256Hash {
  return stableHash({ content: input.content, scope: input.scope });
}

// --- delivery ---------------------------------------------------------------

/** Harness persistence states; 未沉淀 is expressed as an absent (null) delivery. */
export const harnessDeliveryStateSchema = z.enum([
  'not_persisted',
  'prepared',
  'writing',
  'verified',
  'failed',
  'needs_reconciliation',
]);
/** Memory content states only; there is no sink, so nothing claims an external write. */
export const memoryDeliveryStateSchema = z.enum(['not_exported', 'exported', 'user_confirmed_saved']);

const ruleDeliveryUnion = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('harness'),
      version: z.number().int().positive(),
      content_hash: sha256HashSchema,
      target_id: z.string().min(1),
      display_path: z.string().min(1),
      state: harnessDeliveryStateSchema,
      preview_id: z.string().min(1).optional(),
      publication_id: z.string().min(1).optional(),
      updated_at: isoDateTimeSchema,
      error: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('memory'),
      version: z.number().int().positive(),
      content_hash: sha256HashSchema,
      state: memoryDeliveryStateSchema,
      exported_at: isoDateTimeSchema.optional(),
      user_confirmed_at: isoDateTimeSchema.optional(),
      updated_at: isoDateTimeSchema,
    })
    .strict(),
]);

export const ruleDeliverySchema = ruleDeliveryUnion.superRefine((delivery, ctx) => {
  if (delivery.kind !== 'memory') {
    return;
  }
  if (delivery.state === 'exported' && delivery.exported_at === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['exported_at'],
      message: 'memory state exported requires exported_at',
    });
  }
  if (delivery.state === 'user_confirmed_saved' && delivery.user_confirmed_at === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['user_confirmed_at'],
      message: 'memory state user_confirmed_saved requires user_confirmed_at from explicit user feedback',
    });
  }
});
export type RuleDelivery = z.infer<typeof ruleDeliverySchema>;

// --- operation history ------------------------------------------------------

export const ruleOperationSchema = z.enum([
  'accepted',
  'content_updated',
  'scope_updated',
  'revoked',
  'superseded',
  'delivery_receipt',
]);
export type RuleOperation = z.infer<typeof ruleOperationSchema>;

/** A replaced version keeps enough of itself to audit what the user approved before. */
export const ruleVersionSnapshotSchema = z
  .object({
    version: z.number().int().positive(),
    content_hash: sha256HashSchema,
    title: z.string().min(1).max(200),
    content: ruleContentSchema,
  })
  .strict();

export const ruleHistoryEntrySchema = z
  .object({
    at: isoDateTimeSchema,
    action: ruleOperationSchema,
    version: z.number().int().positive(),
    content_hash: sha256HashSchema,
    request_id: z.string().min(1).optional(),
    note: z.string().min(1).max(500).optional(),
    previous: ruleVersionSnapshotSchema.optional(),
    delivery: ruleDeliverySchema.optional(),
    superseded_by: ruleIdSchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.action === 'content_updated' || entry.action === 'scope_updated') && entry.previous === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['previous'],
        message: `a ${entry.action} operation must snapshot the previous version it replaced`,
      });
    }
  });
export type RuleHistoryEntry = z.infer<typeof ruleHistoryEntrySchema>;

// --- source -----------------------------------------------------------------

/**
 * Source references are data-root relative so they survive a move of the root
 * but never point outside it; an absolute or escaping path is a traversal risk.
 */
export const relativeDataRootPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'),
    'candidate_path must be a data-root relative path without traversal',
  );

export const ruleSourceSchema = z
  .object({
    record_id: recordIdSchema,
    candidate_id: candidateIdSchema,
    candidate_path: relativeDataRootPathSchema,
    candidate_content_hash: sha256HashSchema,
    accepted_request_id: z.string().min(1).optional(),
  })
  .strict();
export type RuleSource = z.infer<typeof ruleSourceSchema>;

// --- rule -------------------------------------------------------------------

export const ruleSchema = z
  .object({
    rule_id: ruleIdSchema,
    title: z.string().min(1).max(200),
    content: ruleContentSchema,
    scope: ruleScopeSchema,
    status: ruleStatusSchema,
    superseded_by: ruleIdSchema.optional(),
    version: z.number().int().positive(),
    content_hash: sha256HashSchema,
    accepted_at: isoDateTimeSchema,
    version_effective_at: isoDateTimeSchema,
    source: ruleSourceSchema,
    delivery: ruleDeliverySchema.nullable().default(null),
    history: z.array(ruleHistoryEntrySchema).min(1).max(RULE_HISTORY_MAX_ENTRIES),
    updated_at: isoDateTimeSchema,
  })
  .strict()
  .superRefine((rule, ctx) => {
    const issue = (path: [string, ...string[]], message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };

    if (rule.status === 'superseded' && rule.superseded_by === undefined) {
      issue(['superseded_by'], 'a superseded rule must name superseded_by');
    }
    if (rule.status !== 'superseded' && rule.superseded_by !== undefined) {
      issue(['superseded_by'], `only a superseded rule may carry superseded_by, not '${rule.status}'`);
    }
    if (rule.superseded_by !== undefined && rule.superseded_by === rule.rule_id) {
      issue(['superseded_by'], 'a rule cannot supersede itself');
    }

    if (rule.content_hash !== ruleContentHash({ content: rule.content, scope: rule.scope })) {
      issue(['content_hash'], 'content_hash does not match the current rule content and scope');
    }

    if (rule.delivery !== null) {
      if (rule.delivery.version !== rule.version || rule.delivery.content_hash !== rule.content_hash) {
        issue(
          ['delivery'],
          'delivery must be bound to the current rule version and content hash; older receipts belong to history',
        );
      }
    }

    const first = rule.history[0];
    if (first === undefined || first.action !== 'accepted' || first.version !== 1) {
      issue(['history'], 'history must start with the acceptance of version 1');
    }
    let lastVersion = 0;
    for (const entry of rule.history) {
      if (entry.version < lastVersion) {
        issue(['history'], 'history versions must be non-decreasing');
        break;
      }
      lastVersion = entry.version;
    }
    if (lastVersion > rule.version) {
      issue(['history'], `history records version ${lastVersion} beyond the rule version ${rule.version}`);
    }
    if (rule.version > 1 && !rule.history.some((entry) => entry.version === rule.version)) {
      issue(['history'], `no user operation records version ${rule.version}`);
    }
    const requiredOperation: Partial<Record<RuleStatus, RuleOperation>> = {
      revoked: 'revoked',
      superseded: 'superseded',
    };
    const needed = requiredOperation[rule.status];
    if (needed !== undefined && !rule.history.some((entry) => entry.action === needed)) {
      issue(['status'], `a ${needed} rule needs a ${needed} operation in history`);
    }

    if (Date.parse(rule.accepted_at) > Date.parse(rule.version_effective_at)) {
      issue(['version_effective_at'], 'version_effective_at must not precede accepted_at');
    }
  });
export type Rule = z.infer<typeof ruleSchema>;

// --- pending acceptance (cross-file adoption, design 31.5) ------------------

/**
 * The bounded replay delta of one adoption. It carries the whole rule because
 * recovery must be able to finish the commit without re-reading the candidate,
 * but never more than one rule, so it stays inside the single-operation budget.
 */
export const acceptanceDeltaSchema = z
  .object({
    kind: z.enum(['add', 'update']),
    rule: ruleSchema,
    previous: z
      .object({
        version: z.number().int().positive(),
        content_hash: sha256HashSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((delta, ctx) => {
    if (delta.kind === 'update' && delta.previous === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['previous'],
        message: 'an update delta must carry the previous version it replaces',
      });
    }
    if (delta.kind === 'add' && delta.previous !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['previous'],
        message: 'an add delta must not carry a previous version',
      });
    }
  });
export type AcceptanceDelta = z.infer<typeof acceptanceDeltaSchema>;

/**
 * Written to the registry before either side moves. Its existence means "an
 * adoption is half-done"; readers recover it or report maintenance, and a
 * mismatched file hash stops the replay instead of overwriting a user edit.
 */
export const pendingAcceptanceSchema = z
  .object({
    request_id: z.string().min(1),
    payload_hash: sha256HashSchema,
    rule_id: ruleIdSchema,
    record_id: recordIdSchema,
    candidate_id: candidateIdSchema,
    candidate_expected_revision: z.number().int().positive(),
    candidate_expected_hash: sha256HashSchema.optional(),
    candidate_baseline_hash: sha256HashSchema.optional(),
    candidate_notes_hash: sha256HashSchema.optional(),
    rules_notes_hash: sha256HashSchema.optional(),
    rules_expected_revision: z.number().int().positive(),
    rules_expected_hash: sha256HashSchema,
    delta: acceptanceDeltaSchema,
    created_at: isoDateTimeSchema,
  })
  .strict()
  .superRefine((pending, ctx) => {
    if (pending.delta.rule.rule_id !== pending.rule_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delta'],
        message: 'the delta rule_id must equal the pinned pending rule_id',
      });
    }
  });
export type PendingAcceptance = z.infer<typeof pendingAcceptanceSchema>;

// --- registry document ------------------------------------------------------

export const acceptedRulesDocumentSchema = z
  .object({
    schema: acceptedRulesSchemaIdSchema,
    revision: z.number().int().positive(),
    updated_at: isoDateTimeSchema,
    rules: z.array(ruleSchema).max(ACCEPTED_RULES_MAX_RULES).default([]),
    request_log: z.array(requestReceiptSchema).max(RULES_REQUEST_LOG_MAX).default([]),
    pending_acceptance: pendingAcceptanceSchema.nullable().default(null),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (const rule of doc.rules) {
      if (seen.has(rule.rule_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules'],
          message: `duplicate rule_id ${rule.rule_id}; one rule id is one rule`,
        });
      }
      seen.add(rule.rule_id);
    }
  });
export type AcceptedRulesDocument = z.infer<typeof acceptedRulesDocumentSchema>;

/** A brand-new data root may create an empty registry; that is not "no rules" for a root that has history. */
export function initialRulesDocument(now: string): AcceptedRulesDocument {
  return {
    schema: ACCEPTED_RULES_SCHEMA_ID,
    revision: 1,
    updated_at: now,
    rules: [],
    request_log: [],
    pending_acceptance: null,
  };
}

/** The only active rule for a given id; revoked and superseded rules never shadow it. */
export function activeRule(rules: readonly Rule[], ruleId: string): Rule | undefined {
  return rules.find((rule) => rule.rule_id === ruleId && rule.status === 'active');
}

/** Stable review order (design 31.6): adoption time first, rule id as the tiebreak. */
export function sortRulesForReview(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => {
    const byTime = Date.parse(a.accepted_at) - Date.parse(b.accepted_at);
    if (byTime !== 0) {
      return byTime;
    }
    return a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0;
  });
}

// --- rule_ref on candidates -------------------------------------------------

/**
 * Set once a candidate's approval has been adopted into the registry. It binds
 * the adopted candidate content version so a later content edit cannot be
 * mistaken for the version the user approved.
 */
export const ruleRefSchema = z
  .object({
    rule_id: ruleIdSchema,
    accepted_version: z.number().int().positive(),
    candidate_content_hash: sha256HashSchema,
    request_id: z.string().min(1).optional(),
    at: isoDateTimeSchema,
  })
  .strict();
export type RuleRef = z.infer<typeof ruleRefSchema>;

// --- frozen review snapshot (design 31.6) -----------------------------------

/** The minimal per-rule snapshot a session keeps so history stays readable after the rule moves on. */
export const snapshotRuleSchema = z
  .object({
    rule_id: ruleIdSchema,
    version: z.number().int().positive(),
    content_hash: sha256HashSchema,
    title: z.string().min(1).max(200),
    content: ruleContentSchema,
    scope: ruleScopeSchema,
    status: ruleStatusSchema,
    accepted_at: isoDateTimeSchema,
    version_effective_at: isoDateTimeSchema,
    delivery: ruleDeliverySchema.nullable().default(null),
    source: ruleSourceSchema,
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.content_hash !== ruleContentHash({ content: rule.content, scope: rule.scope })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content_hash'],
        message: 'snapshot content_hash does not match the frozen rule content and scope',
      });
    }
  });
export type SnapshotRule = z.infer<typeof snapshotRuleSchema>;

export const snapshotEpisodeSchema = z
  .object({
    episode_id: episodeIdSchema,
    evidence: z.array(evidenceIdSchema).min(1),
  })
  .strict();
export type SnapshotEpisode = z.infer<typeof snapshotEpisodeSchema>;

export const ruleReviewSnapshotSchema = z
  .object({
    schema: ruleReviewSnapshotSchemaIdSchema,
    record_id: recordIdSchema,
    analysis_id: z.string().min(1),
    analyze_revision: z.number().int().positive(),
    rules_revision: z.number().int().positive(),
    rules_file_hash: sha256HashSchema,
    /** Canonical workspace of the reviewed session; null means scope cannot be proven. */
    session_workspace: z.string().nullable(),
    created_at: isoDateTimeSchema,
    coverage: coverageSchema,
    rules: z.array(snapshotRuleSchema).max(RULE_REVIEW_SNAPSHOT_MAX_RULES),
    episodes: z.array(snapshotEpisodeSchema).min(1).max(RULE_REVIEW_SNAPSHOT_MAX_EPISODES),
    evidence: z.array(evidenceItemSchema).min(1),
    input_digest: sha256HashSchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ruleIds = new Set<string>();
    for (const rule of snapshot.rules) {
      if (ruleIds.has(rule.rule_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules'],
          message: `duplicate rule_id ${rule.rule_id} in the review snapshot`,
        });
      }
      ruleIds.add(rule.rule_id);
    }
    const episodeIds = new Set<string>();
    for (const episode of snapshot.episodes) {
      if (episodeIds.has(episode.episode_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['episodes'],
          message: `duplicate episode_id ${episode.episode_id} in the review snapshot`,
        });
      }
      episodeIds.add(episode.episode_id);
    }
  });
export type RuleReviewSnapshot = z.infer<typeof ruleReviewSnapshotSchema>;

/**
 * Digest of the frozen contract: rule bodies, versions, evidence and coverage.
 * Wall-clock capture time is metadata and stays out, the same way prepare keeps
 * timestamps out of its input hash.
 */
export function computeRuleReviewDigest(input: unknown): Sha256Hash {
  const { created_at: _omitCreated, input_digest: _omitDigest, ...rest } = (input ?? {}) as Record<string, unknown>;
  return stableHash(rest);
}

// --- observations -----------------------------------------------------------

export const observationRelationSchema = z.enum([
  'recurrence_detected',
  'possibly_related',
  'no_recurrence_observed',
]);
export type ObservationRelation = z.infer<typeof observationRelationSchema>;

/**
 * Program-derived time relationship (design 31.6). Only an event that is
 * provably later than the rule version may claim recurrence, and only a
 * provably later-than-persisted event may claim a post-delivery recurrence.
 */
export const temporalClassSchema = z.enum([
  'subsequent_recurrence',
  'post_delivery_recurrence',
  'historical_relation',
  'temporal_unknown',
]);
export type TemporalClass = z.infer<typeof temporalClassSchema>;

export interface TemporalFacts {
  episode_event_at?: string;
  rule_version_effective_at: string;
  delivered_at?: string;
}

function timeValue(iso: string | undefined): number | undefined {
  if (iso === undefined) {
    return undefined;
  }
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
}

export function classifyTemporal(facts: TemporalFacts): TemporalClass {
  const event = timeValue(facts.episode_event_at);
  const effective = timeValue(facts.rule_version_effective_at);
  const delivered = timeValue(facts.delivered_at);
  if (event === undefined || effective === undefined) {
    return 'temporal_unknown';
  }
  if (event < effective) {
    return 'historical_relation';
  }
  if (delivered !== undefined && event >= delivered) {
    return 'post_delivery_recurrence';
  }
  return 'subsequent_recurrence';
}

export const ruleObservationSubmissionSchema = z
  .object({
    rule_id: ruleIdSchema,
    version: z.number().int().positive(),
    content_hash: sha256HashSchema,
    relation: observationRelationSchema,
    episode_id: episodeIdSchema.optional(),
    evidence: z.array(evidenceIdSchema),
    explanation: observationExplanationSchema,
  })
  .strict()
  .superRefine((observation, ctx) => {
    const issue = (path: [string, ...string[]], message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };
    if (observation.relation === 'recurrence_detected') {
      if (observation.episode_id === undefined) {
        issue(['episode_id'], 'recurrence_detected requires the episode_id it was seen in');
      }
      if (observation.evidence.length === 0) {
        issue(['evidence'], 'recurrence_detected requires at least one evidence id');
      }
    }
    if (observation.relation === 'possibly_related' && observation.evidence.length === 0) {
      issue(['evidence'], 'possibly_related requires at least one evidence id');
    }
    if (observation.relation === 'no_recurrence_observed') {
      if (observation.episode_id !== undefined) {
        issue(['episode_id'], 'no_recurrence_observed must not name an episode_id');
      }
      if (observation.evidence.length > 0) {
        issue(['evidence'], 'no_recurrence_observed must not cite evidence');
      }
    }
  });
export type RuleObservationSubmission = z.infer<typeof ruleObservationSubmissionSchema>;

export const ruleObservationSchema = z
  .object({
    rule_id: ruleIdSchema,
    version: z.number().int().positive(),
    content_hash: sha256HashSchema,
    relation: observationRelationSchema,
    episode_id: episodeIdSchema.optional(),
    evidence: z.array(evidenceIdSchema),
    explanation: observationExplanationSchema,
    temporal: temporalClassSchema,
    episode_event_at: isoDateTimeSchema.optional(),
    rule_version_effective_at: isoDateTimeSchema,
    delivered_at: isoDateTimeSchema.optional(),
    snapshot_digest: sha256HashSchema,
    observed_at: isoDateTimeSchema,
  })
  .strict()
  .superRefine((observation, ctx) => {
    const issue = (path: [string, ...string[]], message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };
    if (observation.relation === 'recurrence_detected') {
      if (observation.episode_id === undefined) {
        issue(['episode_id'], 'recurrence_detected requires the episode_id it was seen in');
      }
      if (observation.evidence.length === 0) {
        issue(['evidence'], 'recurrence_detected requires at least one evidence id');
      }
    }
    if (observation.relation === 'no_recurrence_observed') {
      if (observation.episode_id !== undefined || observation.evidence.length > 0) {
        issue(['episode_id'], 'no_recurrence_observed must not name an episode_id or cite evidence');
      }
    }
    if (observation.temporal === 'post_delivery_recurrence' && observation.delivered_at === undefined) {
      issue(['delivered_at'], 'post_delivery_recurrence requires the version delivered_at it is measured against');
    }
    if (observation.relation === 'no_recurrence_observed') {
      if (observation.episode_event_at !== undefined) {
        issue(['episode_event_at'], 'no_recurrence_observed has no event to date');
      }
      if (observation.temporal !== 'temporal_unknown') {
        issue(['temporal'], 'no_recurrence_observed carries no temporal claim');
      }
      return;
    }
    if (observation.temporal === 'temporal_unknown' && observation.episode_event_at !== undefined) {
      issue(['temporal'], 'temporal_unknown is only allowed when the event time is missing');
    }
    const derived = classifyTemporal({
      ...(observation.episode_event_at === undefined ? {} : { episode_event_at: observation.episode_event_at }),
      rule_version_effective_at: observation.rule_version_effective_at,
      ...(observation.delivered_at === undefined ? {} : { delivered_at: observation.delivered_at }),
    });
    // Claiming a plain later recurrence when the persistence time is also known
    // under-reports; every other disagreement would over-report.
    const weakerClaim = observation.temporal === 'subsequent_recurrence' && derived === 'post_delivery_recurrence';
    if (observation.temporal !== derived && !weakerClaim) {
      issue(['temporal'], `temporal label ${observation.temporal} contradicts the frozen timestamps`);
    }
  });
export type RuleObservation = z.infer<typeof ruleObservationSchema>;

/** Per-rule processing list of a review pass; a missing entry is a review gap, not a negative. */
export const ruleReviewCoverageSchema = z
  .object({
    status: z.enum(['full', 'partial', 'unavailable']),
    considered: z.array(ruleIdSchema),
    reviewed: z.array(ruleIdSchema),
    skipped: z.array(z.object({ rule_id: ruleIdSchema, reason: z.string().min(1) }).strict()),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    const issue = (path: [string, ...string[]], message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };
    const considered = new Set(coverage.considered);
    const reviewed = new Set(coverage.reviewed);
    const skipped = new Set(coverage.skipped.map((entry) => entry.rule_id));
    for (const id of reviewed) {
      if (!considered.has(id)) {
        issue(['reviewed'], 'every reviewed and skipped rule must appear in considered');
        break;
      }
    }
    for (const id of skipped) {
      if (!considered.has(id)) {
        issue(['skipped'], 'every reviewed and skipped rule must appear in considered');
        break;
      }
    }
    for (const id of reviewed) {
      if (skipped.has(id)) {
        issue(['reviewed'], 'a rule cannot be both reviewed and skipped');
        break;
      }
    }
    if (coverage.status === 'full' && coverage.skipped.length > 0) {
      issue(['status'], 'coverage status full is not allowed while rules were skipped');
    }
    if (coverage.status === 'unavailable' && (reviewed.size > 0 || skipped.size > 0)) {
      issue(['status'], 'an unavailable review lists no reviewed or skipped rules');
    }
  });
export type RuleReviewCoverage = z.infer<typeof ruleReviewCoverageSchema>;

export const ruleReviewSubmissionSchema = z
  .object({
    snapshot_digest: sha256HashSchema,
    coverage: ruleReviewCoverageSchema,
    observations: z.array(ruleObservationSubmissionSchema).max(RULE_REVIEW_SNAPSHOT_MAX_EPISODES),
  })
  .strict()
  .superRefine((submission, ctx) => {
    const seen = new Set<string>();
    for (const observation of submission.observations) {
      const key = `${observation.rule_id}|${observation.version}|${observation.episode_id ?? ''}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observations'],
          message: 'duplicate observation for the same rule version and episode; a re-run never accumulates',
        });
      }
      seen.add(key);
    }
  });
export type RuleReviewSubmission = z.infer<typeof ruleReviewSubmissionSchema>;

// --- frozen change requests (design 31.4/31.5) ------------------------------

const confirmedSchema = z.literal(true, {
  errorMap: () => ({ message: 'a rule change requires explicit user confirmation' }),
});

export const ruleAdoptRequestSchema = z
  .object({
    request_id: z.string().min(1),
    record_id: recordIdSchema,
    candidate_id: candidateIdSchema,
    expected_revision: z.number().int().positive(),
    expected_candidate_content_hash: sha256HashSchema,
    scope: ruleScopeSchema,
    confirmed: confirmedSchema,
    note: z.string().min(1).max(500).optional(),
  })
  .strict();
export type RuleAdoptRequest = z.infer<typeof ruleAdoptRequestSchema>;

export const ruleUpdateRequestSchema = z
  .object({
    request_id: z.string().min(1),
    rule_id: ruleIdSchema,
    expected_revision: z.number().int().positive(),
    expected_version: z.number().int().positive(),
    expected_content_hash: sha256HashSchema,
    title: z.string().min(1).max(200).optional(),
    content: ruleContentSchema.optional(),
    scope: ruleScopeSchema.optional(),
    note: z.string().min(1).max(500).optional(),
    confirmed: confirmedSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.title === undefined && request.content === undefined && request.scope === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'an update must propose at least a content, title or scope change',
      });
    }
  });
export type RuleUpdateRequest = z.infer<typeof ruleUpdateRequestSchema>;

export const ruleRevokeRequestSchema = z
  .object({
    request_id: z.string().min(1),
    rule_id: ruleIdSchema,
    expected_revision: z.number().int().positive(),
    expected_version: z.number().int().positive(),
    confirmed: confirmedSchema,
    note: z.string().min(1).max(500).optional(),
  })
  .strict();
export type RuleRevokeRequest = z.infer<typeof ruleRevokeRequestSchema>;

export const rulesMigrateRequestSchema = z
  .object({
    mode: z.enum(['dry_run', 'apply']),
    expected_revision: z.number().int().positive(),
    record_ids: z.array(recordIdSchema).optional(),
    batch_size: z.number().int().positive().max(RULES_MIGRATE_BATCH_MAX).optional(),
    backup_dir: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.mode === 'apply' && request.backup_dir === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backup_dir'],
        message: 'migrate apply requires a backup_dir; affected Markdown is copied before any write',
      });
    }
  });
export type RulesMigrateRequest = z.infer<typeof rulesMigrateRequestSchema>;

// --- migration report (design 31.5) ----------------------------------------

export const migrationDispositionSchema = z.enum([
  'import',
  'skip_unapproved',
  'skip_approval_stale',
  'skip_already_migrated',
  'needs_review_missing_scope',
  'needs_review_missing_time',
  'needs_review_source_missing',
]);
export type MigrationDisposition = z.infer<typeof migrationDispositionSchema>;

/**
 * One line of a migrate dry-run. A candidate that cannot be imported honestly
 * is listed as needs_review with no rule_id and no invented timestamps:
 * migration never promotes a rule the user cannot trace back.
 */
export const migrationItemSchema = z
  .object({
    record_id: recordIdSchema,
    candidate_id: candidateIdSchema,
    disposition: migrationDispositionSchema,
    reason: z.string().min(1),
    candidate_content_hash: sha256HashSchema,
    rule_id: ruleIdSchema.optional(),
    proposed_scope: ruleScopeSchema.optional(),
    accepted_at: isoDateTimeSchema.optional(),
    publication_receipt: z
      .object({
        publication_id: z.string().min(1),
        published: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const issue = (path: [string, ...string[]], message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };
    if (item.disposition === 'import') {
      if (item.rule_id === undefined) {
        issue(['rule_id'], 'an import line must carry the deterministic rule_id');
      }
      if (item.proposed_scope === undefined) {
        issue(['proposed_scope'], 'an import line must carry the scope it would write');
      }
      if (item.accepted_at === undefined) {
        issue(['accepted_at'], 'an import line needs the real approval time; migration never fabricates one');
      }
    } else if (item.disposition.startsWith('needs_review')) {
      if (item.rule_id !== undefined || item.proposed_scope !== undefined) {
        issue(['rule_id'], `a ${item.disposition} line stays unimported until the user resolves it`);
      }
    }
  });
export type MigrationItem = z.infer<typeof migrationItemSchema>;

export const migrationPlanSchema = z
  .object({
    schema: migrationSchemaIdSchema,
    generated_at: isoDateTimeSchema,
    mode: z.enum(['dry_run', 'apply']),
    expected_revision: z.number().int().positive(),
    batch_size: z.number().int().positive().max(RULES_MIGRATE_BATCH_MAX).default(RULES_MIGRATE_BATCH_MAX),
    backup_dir: z.string().min(1).optional(),
    items: z.array(migrationItemSchema).max(ACCEPTED_RULES_MAX_RULES),
    counts: z
      .object({
        import: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        needs_review: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.mode === 'apply' && plan.backup_dir === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backup_dir'],
        message: 'an applied migration plan must record its backup_dir',
      });
    }
  });
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;
