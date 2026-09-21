/**
 * Frozen engineering-contract numbers (design §30, closed at T07a).
 * Every value here is a protocol contract: changing one is a breaking change
 * that must be re-verified with the boundary cases in
 * tests/unit/domain/limits.test.ts and the referenced design sections.
 */

// --- Two-file commit + lease (design 24.2 / 24.3) ---------------------------

/** Pending payloads over this size are refused before any write, never truncated. */
export const PENDING_COMMIT_MAX_BYTES = 256 * 1024;

/** Default lease for one analysis run of a single session (skill/agent bound). */
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

// --- Cross-process session lock (design 24.2, proper-lockfile) --------------

/** A lock older than this is considered abandoned and may be taken over. */
export const LOCK_STALE_MS = 30_000;
/** Heartbeat interval refreshing the lock while its owner is alive. */
export const LOCK_UPDATE_MS = 5_000;
export const LOCK_RETRY_COUNT = 10;
export const LOCK_RETRY_MIN_MS = 25;
export const LOCK_RETRY_MAX_MS = 250;

// --- Host input surface (design 25.1 / 25.2) --------------------------------

/** Hook stdin payloads are bounded; anything larger fails before parsing (T17). */
export const HOOK_STDIN_MAX_BYTES = 64 * 1024;
/** detectFormat sniffs at most this many well-formed head lines. */
export const FORMAT_SNIFF_LINES = 16;

/**
 * Compatibility matrix frozen from real probes on 2026-09-19 (macOS arm64);
 * full record and install commands live in packaging/compat-matrix.md.
 */
export const HOST_PROBE = {
  codex: { package: '@openai/codex', version: '0.146.0', probe: 'codex --version' },
  claude: { package: '@anthropic-ai/claude-code', version: '2.1.220', probe: 'claude --version' },
} as const;

// --- prepare / ingest analysis contract (design 22, consumed by T08/T09) ----

/** One prepare packet stays under the pending budget so ingest can never straddle it. */
export const PREPARE_PACKET_MAX_BYTES = 192 * 1024;
/** Cap for one event text embedded in a packet; over-cap text is elided with an explicit marker, never silently cut. */
export const PREPARE_EVENT_MAX_TEXT_CHARS = 8 * 1024;
/** Only one bounded schema-error resubmission per analysis run (errors.ts contract). */
export const INGEST_MAX_CORRECTIVE_RESUBMISSIONS = 1;

// --- Drain scheduling (design 25.3) ------------------------------------------

/** A scheduled drain processes at most this many records per run, lease per session. */
export const DRAIN_MAX_SESSIONS_PER_RUN = 3;

// --- Review decision surface (design 26.2, T12) ------------------------------

/**
 * Idempotency ledger size kept in learning_candidates.md request_log; the
 * newest receipts win. A request id that fell out of the window is answered
 * from the candidate's decision history as stale and never re-executed.
 */
export const REVIEW_REQUEST_LOG_MAX = 500;

// --- Local HTTP service (design 26.2, consumed by T16) -----------------------

export const HTTP_BODY_MAX_BYTES = 256 * 1024;
export const HTTP_REQUEST_TIMEOUT_MS = 30_000;

