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

// --- Publish protocol (design 14 / 26.2, consumed by T13) --------------------

/** A preview past this age must be recreated; publish never revives it. */
export const PUBLISH_PREVIEW_TTL_MS = 10 * 60 * 1000;
/** Harness target files above this size are refused before any write, never truncated. */
export const TARGET_FILE_MAX_BYTES = 1024 * 1024;

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

// --- Accepted-rules registry (design 31, frozen at LC-01) --------------------
/*
 * Measured on 2026-09-20 with packaging/measure-rules-budget.mjs (macOS arm64,
 * Node v24.19.0) on synthetic registries serialized through the same
 * frontmatter renderer as the session documents, in both ASCII and CJK bodies of
 * ~1KiB and of the maximum size. See packaging/accepted-rules-contract.md for
 * the recorded numbers; these caps are protocol limits, not performance targets.
 */

/**
 * One rule body is a rule, not a document: longer is rejected, never truncated.
 * Capped in UTF-8 bytes rather than characters because every downstream budget is
 * a byte budget and this product's rule text is commonly CJK (3 bytes per char).
 */
export const RULE_CONTENT_MAX_BYTES = 4_000;
/** Free-text scenario note attached to a structured scope, in UTF-8 bytes. */
export const RULE_SCOPE_NOTE_MAX_BYTES = 500;
/** Operation history kept per rule; the newest entries win, nothing is silently truncated. */
export const RULE_HISTORY_MAX_ENTRIES = 200;
/** Hard ceiling on rules in one registry; beyond it the file is treated as corrupt, not paged. */
export const ACCEPTED_RULES_MAX_RULES = 5_000;
/**
 * Safe read budget for accepted_rules.md: a larger file is refused before the
 * YAML parse rather than silently truncated. Measured (see
 * packaging/accepted-rules-contract.md) 9,139,064 bytes for 1,000 rules at the
 * maximum body size and 3,187,064 for 1,000 rules at ~1KiB bodies; both are
 * UTF-8 bounded, so 16MiB never rejects a legal 1,000-rule registry.
 */
export const ACCEPTED_RULES_READ_MAX_BYTES = 16 * 1024 * 1024;
/** Idempotency ledger in accepted_rules.md frontmatter, same window semantics as review. */
export const RULES_REQUEST_LOG_MAX = 500;
/** Operations committed per `rules migrate --apply`; migration is never a whole-library transaction. */
export const RULES_MIGRATE_BATCH_MAX = 50;
/** Binding serialized-size ceiling of one frozen review snapshot, checked on the real bytes. */
export const RULE_REVIEW_SNAPSHOT_MAX_BYTES = 192 * 1024;
/**
 * Ceiling, not a packing target: measured 40 x 4,000-byte ASCII bodies reach
 * 193,732 bytes, and CJK titles/notes push the same 40 rules past 192KiB.
 * `rules review-prepare` therefore packs by RULE_REVIEW_SNAPSHOT_MAX_BYTES and
 * reports the rules it could not carry as partial coverage - never a silent drop.
 */
export const RULE_REVIEW_SNAPSHOT_MAX_RULES = 40;
/** Episodes frozen into one review snapshot, and the matching observation ceiling. */
export const RULE_REVIEW_SNAPSHOT_MAX_EPISODES = 200;
/**
 * Explanation text of one rule observation, in UTF-8 bytes. 200 observations at
 * this cap stay inside the single-operation 256KiB pending-commit budget.
 */
export const RULE_OBSERVATION_EXPLANATION_MAX_BYTES = 1_000;

