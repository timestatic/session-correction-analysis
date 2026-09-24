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
    nextStep: 'Ask the user to paste the host /status output; register with explicit --session and --transcript.',
  },
  location_conflict: {
    message: 'The provided locators resolve to more than one session.',
    retryable: false,
    nextStep: 'Never pick by recency; ask the user for the /status output and register one exact session.',
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
    nextStep: 'Run the analysis Skill explicitly inside a configured host; pending is preserved.',
  },
  unsupported_operation: {
    message: 'This operation or legacy record is not supported in Phase 1.',
    retryable: false,
    nextStep: 'Use a new --data-root for Phase 1; review and approve the current candidate before text output.',
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
