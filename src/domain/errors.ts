import { z } from 'zod';

interface ErrorSpec {
  readonly message: string;
  readonly retryable: boolean;
  readonly nextStep: string;
}

export const ERROR_CODES = {
  session_locator_unavailable: {
    message: 'The requested session cannot be located through the host index or registered records.',
    retryable: false,
    nextStep: 'Provide the exact transcript file with --transcript <path>.',
  },
  location_conflict: {
    message: 'Explicit --session and --transcript resolve to different sessions.',
    retryable: false,
    nextStep: 'Pass only one locator, or correct it so both refer to the same session.',
  },
  unsupported_transcript: {
    message: 'The native transcript format is not supported by any adapter yet.',
    retryable: false,
    nextStep: 'Export or provide a normalized transcript following the frozen schema.',
  },
  transcript_unreadable: {
    message: 'The transcript file is missing or unreadable.',
    retryable: false,
    nextStep: 'Keep the record with its failure reason; do not treat absence as zero corrections.',
  },
  runner_unavailable: {
    message: 'No host agent/model execution environment is available for semantic analysis.',
    retryable: true,
    nextStep: 'Run the analysis Skill inside a configured host, or drain later; pending is preserved.',
  },
  unsupported_operation: {
    message: 'This operation is not supported for the candidate target kind.',
    retryable: false,
    nextStep: 'Memory candidates use approval plus content output; harness candidates use preview/publish.',
  },
  record_identity_mismatch: {
    message: 'A record with this id exists but its stored source identity differs.',
    retryable: false,
    nextStep: 'Refuse the overwrite; re-check host, canonical workspace and original session id.',
  },
  revision_conflict: {
    message: 'The document revision changed after it was read.',
    retryable: true,
    nextStep: 'Re-read the current revision and resubmit the mutation.',
  },
  lease_expired: {
    message: 'The analysis run lease expired and its fencing generation was superseded.',
    retryable: false,
    nextStep: 'Late runner results are rejected; start a fresh prepared run.',
  },
  lease_active: {
    message: 'Another live analysis run holds the lease for this record.',
    retryable: true,
    nextStep: 'Wait for the lease to finish or expire; never run two analyzers per session.',
  },
  lock_compromised: {
    message: 'The session lock was lost while this writer held it.',
    retryable: true,
    nextStep: 'Stop committing; re-acquire and reload before retrying.',
  },
  pending_commit_recovery_failed: {
    message: 'An interrupted two-file commit could not be recovered.',
    retryable: false,
    nextStep: 'Show maintenance status and refuse new writes for this record.',
  },
  schema_invalid: {
    message: 'A document or payload failed schema validation.',
    retryable: false,
    nextStep: 'Fix the reported field; the original file is left untouched.',
  },
  evidence_not_found: {
    message: 'A submitted evidence id is not present in the frozen prepare packet.',
    retryable: false,
    nextStep: 'Reject submission; allow one bounded schema-error resubmission only.',
  },
  citation_mismatch: {
    message: 'A submitted quote does not match the referenced evidence fragment.',
    retryable: false,
    nextStep: 'Reject submission; never hide the error by lowering confidence.',
  },
  coverage_incomplete: {
    message: 'The analysis input is partial; full-session conclusions are not allowed.',
    retryable: false,
    nextStep: 'Report partial explicitly and keep it out of full-session statistics.',
  },
  payload_too_large: {
    message: 'The submitted payload exceeds the frozen size limit.',
    retryable: true,
    nextStep: 'Shrink the evidence window and resubmit; never copy the full transcript.',
  },
  approval_missing: {
    message: 'The candidate is not approved in its current content version.',
    retryable: false,
    nextStep: 'Approve the current version first; edits and revocations invalidate prior approvals.',
  },
  preview_expired: {
    message: 'The publish preview no longer exists or passed its expiry.',
    retryable: true,
    nextStep: 'Create a fresh preview and publish against it.',
  },
  target_changed: {
    message: 'The publish target content hash differs from the previewed value.',
    retryable: true,
    nextStep: 'Refuse the overwrite and re-preview.',
  },
  target_not_allowed: {
    message: 'The publish target is outside the configured whitelist.',
    retryable: false,
    nextStep: 'Stop automatic publishing; the user must add the target explicitly.',
  },
  publication_in_doubt: {
    message: 'A publication attempt cannot prove its phase and needs reconciliation.',
    retryable: false,
    nextStep: 'Compare target markers and expected hashes; never re-insert the rule.',
  },
  rules_registry_missing: {
    message: 'Session records exist but this data root has no accepted_rules.md.',
    retryable: false,
    nextStep: 'Report the registry as uninitialized and run `sca rules migrate --dry-run`; a missing file never means zero rules.',
  },
  migration_required: {
    message: 'Adopted candidates predate the rules registry and have not been migrated.',
    retryable: false,
    nextStep: 'Show the dry-run report to the user; apply migration is explicit and backed up, never automatic.',
  },
  rule_not_found: {
    message: 'No rule with this id exists in the registry.',
    retryable: false,
    nextStep: 'List rules first; only an existing rule can be updated, revoked or re-delivered.',
  },
  rule_scope_unknown: {
    message: 'The adoption or scope change cannot be bound to a provable project or explicit user scope.',
    retryable: false,
    nextStep: 'Ask the user to state the scope; never guess from a path rename, worktree or free text.',
  },
  rule_version_mismatch: {
    message: 'A receipt or observation refers to a rule version that is no longer current.',
    retryable: false,
    nextStep: 'Keep it as a historical observation and re-snapshot before claiming anything about the current rule.',
  },
  rule_acceptance_recovery_failed: {
    message: 'An interrupted cross-file adoption cannot be replayed safely.',
    retryable: false,
    nextStep: 'Show maintenance status and refuse adoption/publish writes; keep the conflict, never overwrite the user edit.',
  },
  registry_changed: {
    message: 'accepted_rules.md no longer matches the hash the pending adoption recorded.',
    retryable: true,
    nextStep: 'Stop automatic replay, reload, and let the user resolve the external edit before retrying.',
  },
  request_conflict: {
    message: 'This request id was already used with a different payload.',
    retryable: false,
    nextStep: 'Refuse the write and submit a new request id; the original receipt stays untouched.',
  },
  internal_error: {
    message: 'An unexpected internal failure occurred.',
    retryable: false,
    nextStep: 'Report the failure with its diagnostic code; state is left recoverable.',
  },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const errorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const errorPayloadSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    next_step: z.string().min(1),
  })
  .strict();
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

/** Errors carry codes and next steps only; transcript content must never leak into messages. */
export class ScaError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly nextStep: string;

  constructor(code: ErrorCode, detail?: string) {
    const spec = ERROR_CODES[code];
    super(detail === undefined ? spec.message : `${spec.message} ${detail}`);
    this.name = 'ScaError';
    this.code = code;
    this.retryable = spec.retryable;
    this.nextStep = spec.nextStep;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      next_step: this.nextStep,
    };
  }
}
