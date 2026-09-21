import { z } from 'zod';

import {
  decisionActionSchema,
  targetSchema,
  type Candidate,
  type DecisionAction,
  type DecisionRecord,
} from '../domain/candidates.js';
import type { CandidatesDocument, RequestReceipt } from '../domain/documents.js';
import { ScaError } from '../domain/errors.js';
import { stableHash, type Sha256Hash } from '../domain/hash.js';
import { candidateIdSchema } from '../domain/ids.js';
import { REVIEW_REQUEST_LOG_MAX } from '../domain/limits.js';
import { allowedActions, canTransition } from '../domain/states.js';
import type { RecordRepository } from '../store/repository.js';

/**
 * Human review decisions on candidates (design 24.4 / 26.2 / 26.4). Every
 * mutation is one request inside a single session-lock transaction:
 * already-seen request ids are answered from the ledger BEFORE the revision
 * check, so retries retrieve the original receipt instead of re-executing.
 * Content, target or scope changes invalidate the current approval by
 * returning the candidate to proposed; the old decision stays in history.
 */

export const decisionRequestSchema = z
  .object({
    request_id: z.string().min(1).max(200),
    candidate_id: candidateIdSchema,
    action: decisionActionSchema,
    expected_revision: z.number().int().positive(),
    note: z.string().min(1).max(2000).optional(),
    /** New content/title/target/scope — edit_content only; requires content. */
    content: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    target: targetSchema.optional(),
    scope: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.action === 'edit_content' && req.content === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'edit_content requires the new content' });
    }
    if (req.action !== 'edit_content' && (req.content !== undefined || req.title !== undefined || req.target !== undefined || req.scope !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only edit_content may change content, title, target or scope',
      });
    }
  });
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

export interface DecisionOutcome {
  receipt: RequestReceipt;
  /** Candidate state after (or despite) the request — never undefined once validated. */
  candidate: Candidate;
  revision: number;
  duplicate: boolean;
}

/** The identity of the current content version; approvals bind to exactly this. */
export function contentVersionHash(candidate: Candidate): Sha256Hash {
  return stableHash({
    proposed_content: candidate.proposed_content,
    target: candidate.target,
    applicable_scope: candidate.applicable_scope ?? null,
  });
}

export function decisionPayloadHash(request: DecisionRequest): Sha256Hash {
  const { request_id: _omitted, ...payload } = request;
  return stableHash(payload);
}

/** True only when the CURRENT content version carries an unrevoked approval. */
export function hasCurrentApproval(candidate: Candidate): boolean {
  if (candidate.status !== 'approved' && candidate.status !== 'published' && candidate.status !== 'publish_failed') {
    return false;
  }
  const decision = candidate.decision;
  return decision !== null && decision.action === 'approve' && decision.content_hash === contentVersionHash(candidate);
}

const ACTION_TARGET_STATUS: Record<DecisionAction, Candidate['status']> = {
  approve: 'approved',
  reject: 'rejected',
  revoke: 'proposed',
  edit_content: 'proposed',
  supersede: 'superseded',
};

function gate(candidate: Candidate, request: DecisionRequest): void {
  const needed = { approve: 'approve', reject: 'reject', revoke: 'revoke_approval', edit_content: 'edit_content', supersede: null } as const;
  const action = needed[request.action];
  if (action === null) {
    if (!canTransition(candidate.status, 'superseded')) {
      throw new ScaError(
        'schema_invalid',
        `candidate ${candidate.id} in status ${candidate.status} cannot be superseded; rejected decisions stand`,
      );
    }
    return;
  }
  if (!allowedActions(candidate).includes(action)) {
    throw new ScaError('schema_invalid', `action ${request.action} is not allowed for candidate ${candidate.id} in status ${candidate.status}`);
  }
}

function applyAction(candidate: Candidate, request: DecisionRequest, now: string): Candidate {
  gate(candidate, request);
  const at = now;
  let next: Candidate = { ...candidate, updated_at: at };
  let decision: DecisionRecord | null = null;
  const historyAction: DecisionAction = request.action;

  switch (request.action) {
    case 'edit_content': {
      if (request.content === undefined) {
        throw new ScaError('schema_invalid', 'edit_content requires content');
      }
      next = {
        ...next,
        proposed_content: request.content,
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.target !== undefined ? { target: request.target } : {}),
        ...(request.scope !== undefined ? { applicable_scope: request.scope } : {}),
      };
      decision = null;
      break;
    }
    case 'approve': {
      decision = {
        action: 'approve',
        content_hash: contentVersionHash(next),
        target_kind: next.target.kind,
        ...(next.applicable_scope !== undefined ? { scope: next.applicable_scope } : {}),
        at,
        request_id: request.request_id,
        ...(request.note !== undefined ? { note: request.note } : {}),
      };
      break;
    }
    case 'reject': {
      decision = {
        action: 'reject',
        content_hash: contentVersionHash(next),
        target_kind: next.target.kind,
        at,
        request_id: request.request_id,
        ...(request.note !== undefined ? { note: request.note } : {}),
      };
      break;
    }
    case 'revoke': {
      // Revocation never adds a top-level status: back to proposed, history carries the revoke.
      decision = null;
      break;
    }
    case 'supersede': {
      decision = candidate.decision;
      break;
    }
  }

  const historyRecord: DecisionRecord = {
    action: historyAction,
    content_hash: contentVersionHash(next),
    target_kind: next.target.kind,
    ...(next.applicable_scope !== undefined ? { scope: next.applicable_scope } : {}),
    at,
    request_id: request.request_id,
    ...(request.note !== undefined ? { note: request.note } : {}),
  };
  return {
    ...next,
    status: ACTION_TARGET_STATUS[request.action],
    decision,
    decision_history: [...candidate.decision_history, historyRecord],
  };
}

export async function applyDecision(
  repo: RecordRepository,
  recordId: string,
  rawRequest: unknown,
  opts: { retention?: number } = {},
): Promise<DecisionOutcome> {
  const parsed = decisionRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => issue.message)
      .join('; ')
      .slice(0, 300);
    throw new ScaError('schema_invalid', `decision request rejected — ${detail}`);
  }
  const request = parsed.data;
  const payload = decisionPayloadHash(request);
  const retention = opts.retention ?? REVIEW_REQUEST_LOG_MAX;

  const { result, file } = await repo.transactCandidates<{
    receipt: RequestReceipt;
    candidate: Candidate;
    duplicate: boolean;
  }>(recordId, (doc: CandidatesDocument) => {
    const now = new Date().toISOString();
    const seen = doc.request_log.find((entry) => entry.request_id === request.request_id);
    if (seen !== undefined) {
      const candidate = doc.candidates.find((c) => c.id === request.candidate_id);
      if (candidate === undefined) {
        throw new ScaError('schema_invalid', `candidate ${request.candidate_id} is not in this record`);
      }
      if (seen.payload_hash !== payload) {
        // Same request id, different payload: rejected, and nothing is executed.
        return {
          write: false,
          result: {
            receipt: { request_id: request.request_id, payload_hash: payload, result: 'rejected' as const, at: now },
            candidate,
            duplicate: false,
          },
        };
      }
      return { write: false, result: { receipt: seen, candidate, duplicate: true } };
    }

    const candidate = doc.candidates.find((c) => c.id === request.candidate_id);
    if (candidate === undefined) {
      throw new ScaError('schema_invalid', `candidate ${request.candidate_id} is not in this record`);
    }
    if (candidate.decision_history.some((record) => record.request_id === request.request_id)) {
      // Fell out of the retention window; the history proves it already ran.
      return {
        write: false,
        result: {
          receipt: { request_id: request.request_id, payload_hash: payload, result: 'stale' as const, at: now },
          candidate,
          duplicate: false,
        },
      };
    }
    if (doc.revision !== request.expected_revision) {
      throw new ScaError(
        'revision_conflict',
        `expected revision ${String(request.expected_revision)} but the record is at ${String(doc.revision)}; reload and retry`,
      );
    }

    if (candidate.rule_ref !== undefined) throw new ScaError('unsupported_operation', `candidate already linked to ${candidate.rule_ref.rule_id}; rule lifecycle is not yet available, do not edit historical approval`);
    const updated = applyAction(candidate, request, now);
    const receipt: RequestReceipt = {
      request_id: request.request_id,
      payload_hash: payload,
      result: 'applied',
      at: now,
    };
    return {
      write: true,
      doc: {
        ...doc,
        candidates: doc.candidates.map((c) => (c.id === updated.id ? updated : c)),
        request_log: [...doc.request_log, receipt].slice(-retention),
      },
      result: { receipt, candidate: updated, duplicate: false },
    };
  });

  return { receipt: result.receipt, candidate: result.candidate, revision: file.doc.revision, duplicate: result.duplicate };
}
