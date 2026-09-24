import { z } from 'zod';

import { ScaError } from '../domain/errors.js';
import { stableHash, type Sha256Hash } from '../domain/hash.js';
import { candidateIdSchema } from '../domain/ids.js';
import type { RequestReceipt } from '../domain/request.js';
import {
  computeRuleId,
  ruleIdSchema,
  type AcceptedRule,
  type AcceptedRulesDocument,
  type RuleHistoryAction,
  type RuleScope,
} from '../domain/rules.js';
import { contentVersionHash, hasCurrentApproval } from '../review/decide.js';
import type { RecordRepository } from '../store/repository.js';
import { transactRegistry } from '../store/registry.js';

/**
 * Adoption ledger (design 31.2/31.5, lightweight scope): one approved
 * candidate version becomes one entry in the root accepted_rules.md registry.
 * Idempotency follows the decide.ts contract — the request ledger is checked
 * BEFORE any gate, a replayed id answers with its original receipt, and the
 * derived rule_id makes re-adopting the same candidate content a no-op.
 * Nothing is written back into the candidate document (no double write).
 */

export const adoptRequestSchema = z
  .object({
    request_id: z.string().min(1).max(200),
    candidate_id: candidateIdSchema,
    /** Revision of learning_candidates.md the approval was read at. */
    expected_revision: z.number().int().positive(),
    scope: z.enum(['project', 'user']).optional(),
    note: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type AdoptRequest = z.infer<typeof adoptRequestSchema>;

export const revokeRequestSchema = z
  .object({
    request_id: z.string().min(1).max(200),
    rule_id: ruleIdSchema,
    /** Revision of the registry itself; there is no other ledger to race against. */
    expected_revision: z.number().int().positive(),
    note: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type RevokeRequest = z.infer<typeof revokeRequestSchema>;

export interface MutationRequest {
  request_id: string;
  expected_revision: number;
  note?: string | undefined;
}

export function adoptPayloadHash(recordId: string, request: AdoptRequest): Sha256Hash {
  const { request_id: _omitted, ...payload } = request;
  return stableHash({ operation: 'adopt', record_id: recordId, ...payload });
}

export function revokePayloadHash(request: RevokeRequest): Sha256Hash {
  const { request_id: _omitted, ...payload } = request;
  return stableHash({ operation: 'revoke', ...payload });
}

export interface RuleOutcome {
  receipt: RequestReceipt;
  rule: AcceptedRule;
  /** Registry revision after (or despite) the request. */
  revision: number;
  duplicate: boolean;
}

function sameScope(a: RuleScope, b: RuleScope): boolean {
  if (a.kind === 'user' || b.kind === 'user') {
    return a.kind === b.kind;
  }
  return a.canonical_workspace === b.canonical_workspace;
}

function resolveScope(
  requested: 'project' | 'user' | undefined,
  recordWorkspace: string | undefined,
): RuleScope {
  if (requested === 'user') {
    return { kind: 'user' };
  }
  if (recordWorkspace === undefined || recordWorkspace.length === 0) {
    throw new ScaError(
      'schema_invalid',
      'the record carries no workspace to bind a project rule to; pass --scope user or re-register with --workspace',
    );
  }
  return { kind: 'project', canonical_workspace: recordWorkspace };
}

function rejectParse(label: string, error: z.ZodError): never {
  const detail = error.issues
    .map((issue) => issue.message)
    .join('; ')
    .slice(0, 300);
  throw new ScaError('schema_invalid', `${label} request rejected — ${detail}`);
}

function receiptFor(request: MutationRequest, payload: Sha256Hash, result: RequestReceipt['result'], at: string): RequestReceipt {
  return { request_id: request.request_id, payload_hash: payload, result, at };
}

/** Ledger replay shared by adopt and revoke: same id → original receipt, clashing payload → rejected. */
function replayFromLedger(
  registry: AcceptedRulesDocument,
  request: AdoptRequest | RevokeRequest,
  payload: Sha256Hash,
  ruleId: string,
  operation: 'adopt' | 'revoke',
  now: string,
): Omit<RuleOutcome, 'revision'> | undefined {
  const seen = registry.request_log.find((entry) => entry.request_id === request.request_id);
  if (seen === undefined) {
    return undefined;
  }
  const rule = seen.rule_id === undefined
    ? requestAlreadyApplied(registry, request.request_id)
    : registry.rules.find((entry) => entry.rule_id === seen.rule_id);
  if (rule === undefined) {
    throw new ScaError('internal_error', 'the adoption ledger references a rule missing from the registry');
  }
  const { request_id: _omitted, ...legacyPayload } = request;
  const legacyActionMatches = rule.history.some((entry) => entry.request_id === request.request_id &&
    (operation === 'adopt' ? entry.action === 'adopted' || entry.action === 'revised' : entry.action === 'revoked'));
  const matches = rule.rule_id === ruleId && (seen.payload_hash === payload ||
    (seen.rule_id === undefined && legacyActionMatches && seen.payload_hash === stableHash(legacyPayload)));
  if (!matches) {
    return { receipt: receiptFor(request, payload, 'rejected', now), duplicate: false, rule };
  }
  return { receipt: seen, duplicate: true, rule };
}

function requestAlreadyApplied(registry: AcceptedRulesDocument, requestId: string): AcceptedRule | undefined {
  return registry.rules.find((rule) => rule.history.some((entry) => entry.request_id === requestId));
}

export async function adoptCandidate(
  repo: RecordRepository,
  recordId: string,
  rawRequest: unknown,
): Promise<RuleOutcome> {
  const parsed = adoptRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    rejectParse('adopt', parsed.error);
  }
  const request = parsed.data;
  const payload = adoptPayloadHash(recordId, request);
  const ruleId = computeRuleId(recordId, request.candidate_id);

  const { result, doc } = await transactRegistry(repo.paths, async (registry) => {
    const now = new Date().toISOString();
    const replay = replayFromLedger(registry, request, payload, ruleId, 'adopt', now);
    if (replay !== undefined) {
      return { write: false, result: replay };
    }
    const fallen = requestAlreadyApplied(registry, request.request_id);
    if (fallen !== undefined) {
      // Fell out of the retention window; the rule history proves it already ran.
      return {
        write: false,
        result: { receipt: receiptFor(request, payload, 'stale', now), duplicate: false, rule: fallen },
      };
    }

    // Gate reads of the session record: plain loads, the registry lock is outermost.
    const analyze = await repo.loadAnalyze(recordId);
    const candidates = await repo.loadCandidates(recordId);
    const candidate = candidates.doc.candidates.find((c) => c.id === request.candidate_id);
    if (candidate === undefined) {
      throw new ScaError('schema_invalid', `candidate ${request.candidate_id} is not in this record`);
    }
    if (candidates.doc.revision !== request.expected_revision) {
      throw new ScaError(
        'revision_conflict',
        `expected revision ${String(request.expected_revision)} but the candidates record is at ${String(candidates.doc.revision)}; reload and retry`,
      );
    }
    if (!hasCurrentApproval(candidate)) {
      throw new ScaError(
        'approval_missing',
        `candidate ${candidate.id} needs an unrevoked approval for its current content before adoption`,
      );
    }
    const scope = resolveScope(request.scope, analyze.doc.workspace);
    const contentHash = contentVersionHash(candidate);

    const existing = registry.rules.find((r) => r.rule_id === ruleId);
    if (
      existing !== undefined &&
      existing.status === 'active' &&
      existing.source.candidate_content_hash === contentHash &&
      sameScope(existing.scope, scope)
    ) {
      // Persist even no-op receipts so a retry cannot undo a later revocation.
      const receipt = { ...receiptFor(request, payload, 'duplicate', now), rule_id: ruleId };
      return {
        write: true,
        doc: { ...registry, request_log: [...registry.request_log, receipt] },
        result: { receipt, duplicate: true, rule: existing },
      };
    }

    const historyAction: RuleHistoryAction =
      existing === undefined || existing.source.candidate_content_hash === contentHash ? 'adopted' : 'revised';
    const historyEntry = {
      action: historyAction,
      at: now,
      request_id: request.request_id,
      ...(request.note !== undefined ? { note: request.note } : {}),
    };
    // Rebuilt field-by-field so a removed applicable_scope cannot survive from the old version.
    const rule: AcceptedRule = {
      rule_id: ruleId,
      title: candidate.title,
      content: candidate.proposed_content,
      ...(candidate.applicable_scope !== undefined ? { applicable_scope: candidate.applicable_scope } : {}),
      target_kind: candidate.target.kind,
      scope,
      status: 'active',
      version:
        existing === undefined ? 1 : historyAction === 'revised' ? existing.version + 1 : existing.version,
      content_hash: contentHash,
      source: { record_id: recordId, candidate_id: candidate.id, candidate_content_hash: contentHash },
      accepted_at: existing?.accepted_at ?? now,
      updated_at: now,
      history: existing === undefined ? [historyEntry] : [...existing.history, historyEntry],
    };
    const receipt = { ...receiptFor(request, payload, 'applied', now), rule_id: rule.rule_id };
    return {
      write: true,
      doc: {
        ...registry,
        rules: existing === undefined ? [...registry.rules, rule] : registry.rules.map((r) => (r.rule_id === ruleId ? rule : r)),
        request_log: [...registry.request_log, receipt],
      },
      result: { receipt, duplicate: false, rule },
    };
  });

  return { receipt: result.receipt, rule: result.rule, revision: doc.revision, duplicate: result.duplicate };
}

export async function revokeRule(
  repo: RecordRepository,
  rawRequest: unknown,
): Promise<RuleOutcome> {
  const parsed = revokeRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    rejectParse('revoke', parsed.error);
  }
  const request = parsed.data;
  const payload = revokePayloadHash(request);

  const { result, doc } = await transactRegistry(repo.paths, (registry) => {
    const now = new Date().toISOString();
    const replay = replayFromLedger(registry, request, payload, request.rule_id, 'revoke', now);
    if (replay !== undefined) {
      return { write: false, result: replay };
    }
    const fallen = requestAlreadyApplied(registry, request.request_id);
    if (fallen !== undefined) {
      return {
        write: false,
        result: { receipt: receiptFor(request, payload, 'stale', now), duplicate: false, rule: fallen },
      };
    }
    if (registry.revision !== request.expected_revision) {
      throw new ScaError(
        'revision_conflict',
        `expected registry revision ${String(request.expected_revision)} but it is at ${String(registry.revision)}; list the rules and retry`,
      );
    }
    const existing = registry.rules.find((r) => r.rule_id === request.rule_id);
    if (existing === undefined) {
      throw new ScaError('schema_invalid', `rule ${request.rule_id} is not in the registry`);
    }
    if (existing.status === 'revoked') {
      throw new ScaError('schema_invalid', `rule ${request.rule_id} is already revoked`);
    }
    const rule: AcceptedRule = {
      ...existing,
      status: 'revoked',
      updated_at: now,
      history: [
        ...existing.history,
        {
          action: 'revoked',
          at: now,
          request_id: request.request_id,
          ...(request.note !== undefined ? { note: request.note } : {}),
        },
      ],
    };
    const receipt = { ...receiptFor(request, payload, 'applied', now), rule_id: rule.rule_id };
    return {
      write: true,
      doc: {
        ...registry,
        rules: registry.rules.map((r) => (r.rule_id === rule.rule_id ? rule : r)),
        request_log: [...registry.request_log, receipt],
      },
      result: { receipt, duplicate: false, rule },
    };
  });

  return { receipt: result.receipt, rule: result.rule, revision: doc.revision, duplicate: result.duplicate };
}
