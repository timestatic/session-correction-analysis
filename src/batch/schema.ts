import { z } from 'zod';

import { eventSchema } from '../domain/events.js';
import { sha256HashSchema, stableStringify } from '../domain/hash.js';
import { hostSchema } from '../domain/ids.js';

export const batchIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
const instantSchema = z.string().datetime({ offset: true });
export const scopeSchema = z.object({
  time_zone: z.string().min(1).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'invalid time zone'),
  start: instantSchema,
  end: instantSchema,
  time_mode: z.literal('created'),
  inclusion_rule: z.string().min(1),
}).strict().refine(value => Date.parse(value.start) < Date.parse(value.end), 'start must precede end');

export const sourceInputSchema = z.object({
  path: z.string().min(1),
  host: hostSchema,
  session_id: z.string().min(1),
  created_at: instantSchema,
  role: z.enum(['direct', 'automation', 'subagent', 'guardian', 'unknown']),
  role_basis: z.enum(['native_metadata', 'user_declared', 'unavailable']),
  parent_session_id: z.string().min(1).optional(),
}).strict();
export const batchInputSchema = z.object({
  schema: z.literal('session-correction-analysis/batch-input/v1'),
  batch_id: batchIdSchema,
  scope: scopeSchema,
  sources: z.array(sourceInputSchema).min(1),
}).strict();
export type BatchInput = z.infer<typeof batchInputSchema>;

export const indexedEventSchema = z.object({
  evidence_id: z.string().min(1),
  body_hash: sha256HashSchema,
  reading_reuse_of: z.string().min(1).optional(),
  event: eventSchema,
}).strict();
export const sourceSnapshotSchema = z.object({
  source_id: z.string().min(1),
  input: sourceInputSchema,
  source_hash: sha256HashSchema,
  byte_length: z.number().int().nonnegative(),
  frozen_bytes_base64: z.string(),
  parser_version: z.string().min(1),
  coverage: z.enum(['full', 'partial']),
  parent_status: z.enum(['unverified', 'not_declared']),
  excluded_sidechain_records: z.number().int().nonnegative(),
  compacted_records: z.number().int().nonnegative(),
  events: z.array(indexedEventSchema),
}).strict();
export const targetSchema = z.object({
  target_id: z.string().min(1),
  source_id: z.string().min(1),
  evidence_id: z.string().min(1),
  reuse_candidate_of: z.string().min(1).optional(),
}).strict();
export const manifestSchema = z.object({
  schema: z.literal('session-correction-analysis/batch-manifest/v1'),
  batch_id: batchIdSchema,
  scope: scopeSchema,
  sources: z.array(sourceSnapshotSchema),
  targets: z.array(targetSchema),
}).strict();
export type BatchManifest = z.infer<typeof manifestSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

export const judgmentSchema = z.object({
  target_id: z.string().min(1),
  expected_version: z.number().int().nonnegative(),
  reading: z.enum(['inspected', 'reused_exact']),
  judgment: z.enum(['positive', 'negative', 'uncertain']),
  classification: z.enum(['ordinary_task', 'refinement', 'correction', 'intervention', 'machine', 'unresolved']),
  evidence_status: z.enum(['sufficient', 'incomplete', 'unavailable']),
  inspected_evidence_ids: z.array(z.string().min(1)).min(1),
  reuse_target_id: z.string().min(1).optional(),
  unresolved_evidence_ids: z.array(z.string().min(1)),
  citations: z.array(z.object({ evidence_id: z.string().min(1), quote: z.string().min(1) }).strict()),
}).strict();
export const MAX_BATCH_SUBMISSION_BYTES = 1_048_576;
export const batchCandidateSchema = z.object({
  kind: z.enum(['harness', 'memory']), content: z.string().min(1).max(16_384),
  evidence_ids: z.array(z.string().min(1)).min(1).max(100),
}).strict();
export const dualJudgmentSchema = judgmentSchema.extend({
  labels: z.object({ correction: z.boolean(), intervention: z.boolean() }).strict(),
  candidates: z.array(batchCandidateSchema).max(10).optional(),
  rework: z.object({
    causal_status: z.literal('unverified'),
    earlier_edit: z.string().min(1), earlier_result: z.string().min(1),
    later_edit: z.string().min(1), later_result: z.string().min(1),
  }).strict().optional(),
}).strict().refine(item => {
  const positive = item.labels.correction || item.labels.intervention;
  return ((item.candidates?.length ?? 0) === 0 || item.judgment === 'positive')
    && (item.candidates ?? []).every(candidate => new Set(candidate.evidence_ids).size === candidate.evidence_ids.length
      && candidate.evidence_ids.every(id => item.inspected_evidence_ids.includes(id) && item.citations.some(citation => citation.evidence_id === id)))
    && new Set((item.candidates ?? []).map(candidate => stableStringify(candidate))).size === (item.candidates?.length ?? 0)
    && (item.rework === undefined || item.judgment === 'positive')
    && (item.judgment === 'positive') === positive
    && (item.classification !== 'correction' || item.labels.correction)
    && (item.classification !== 'intervention' || item.labels.intervention);
}, 'dual labels conflict with judgment or primary classification');
const submissionFields = { manifest_hash: sha256HashSchema, request_id: batchIdSchema };
export const batchSubmissionSchema = z.discriminatedUnion('schema', [
  z.object({ schema: z.literal('session-correction-analysis/batch-submission/v1'), ...submissionFields,
    judgments: z.array(judgmentSchema).min(1) }).strict(),
  z.object({ schema: z.literal('session-correction-analysis/batch-submission/v2'), ...submissionFields,
    judgments: z.array(dualJudgmentSchema).min(1) }).strict(),
]).refine(submission => Buffer.byteLength(stableStringify(submission), 'utf8') <= MAX_BATCH_SUBMISSION_BYTES,
  'batch submission exceeds 1 MiB; split actual reviewed targets into separate requests');
export type BatchSubmission = z.infer<typeof batchSubmissionSchema>;
export const ledgerSchema = z.object({
  schema: z.literal('session-correction-analysis/batch-ledger/v1'),
  manifest_hash: sha256HashSchema,
  revision: z.number().int().nonnegative(),
  history: z.array(z.object({
    request_id: batchIdSchema,
    request_hash: sha256HashSchema,
    judgments: z.array(z.union([judgmentSchema, dualJudgmentSchema])),
    submission_schema: z.literal('session-correction-analysis/batch-submission/v2').optional(),
  }).strict()),
}).strict();
export type BatchLedger = z.infer<typeof ledgerSchema>;
export type Judgment = z.infer<typeof judgmentSchema> | z.infer<typeof dualJudgmentSchema>;

export const pageCursorSchema = z.object({
  manifest_hash: sha256HashSchema,
  source_index: z.number().int().nonnegative(),
  event_index: z.number().int().nonnegative(),
  text_offset: z.number().int().nonnegative(),
  expand: z.boolean().optional(),
}).strict();
export type PageCursor = z.infer<typeof pageCursorSchema>;
export const pageRequestSchema = z.object({
  max_bytes: z.number().int().min(2048).max(1_048_576),
  cursor: pageCursorSchema.optional(),
  evidence_id: z.string().min(1).optional(),
}).strict().refine(value => value.cursor === undefined || value.evidence_id === undefined,
  'use cursor or evidence_id, not both');
export type PageRequest = z.infer<typeof pageRequestSchema>;
export const WORKER_GUIDANCE = 'Review every target, including negatives. Reading reuse does not authorize semantic reuse. Inspect adjacent context and expand referenced evidence when attribution, contradictions or rework are unclear. Unresolved expansion prevents semantic completion. Never infer human identity from transport role. Submit no approvals or rules. Receipts attest claimed inspection, not actual model attention.';
