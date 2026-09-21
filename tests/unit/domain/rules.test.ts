import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { candidateSchema } from '../../../src/domain/candidates.js';
import { SCHEMA_ID, analyzeDocumentSchema } from '../../../src/domain/documents.js';
import { ERROR_CODES } from '../../../src/domain/errors.js';
import { sha256Tag } from '../../../src/domain/hash.js';
import {
  ACCEPTED_RULES_MAX_RULES,
  ACCEPTED_RULES_READ_MAX_BYTES,
  PENDING_COMMIT_MAX_BYTES,
  RULE_CONTENT_MAX_BYTES,
  RULE_HISTORY_MAX_ENTRIES,
  RULE_OBSERVATION_EXPLANATION_MAX_BYTES,
  RULE_REVIEW_SNAPSHOT_MAX_BYTES,
  RULE_REVIEW_SNAPSHOT_MAX_RULES,
  RULES_MIGRATE_BATCH_MAX,
  RULES_REQUEST_LOG_MAX,
  RULE_SCOPE_NOTE_MAX_BYTES,
} from '../../../src/domain/limits.js';
import {
  ACCEPTED_RULES_FILE_NAME,
  LOCK_ORDER,
  REGISTRY_LOCK_NAME,
  acceptedRulesPath,
  registryLockTarget,
  resolvePaths,
} from '../../../src/store/paths.js';
import {
  ACCEPTED_RULES_SCHEMA_ID as ROOT_ID,
  MIGRATION_SCHEMA_ID,
  RULE_REVIEW_SNAPSHOT_SCHEMA_ID,
  RULES_SCHEMA_COMPAT,
  type AcceptedRulesDocument,
  type Rule,
  acceptanceDeltaSchema,
  acceptedRulesDocumentSchema,
  classifyTemporal,
  computeRuleId,
  computeRuleReviewDigest,
  initialRulesDocument,
  isScopeMatch,
  migrationItemSchema,
  pendingAcceptanceSchema,
  ruleAdoptRequestSchema,
  ruleContentHash,
  ruleObservationSchema,
  ruleObservationSubmissionSchema,
  ruleRefSchema,
  ruleReviewCoverageSchema,
  ruleReviewSnapshotSchema,
  ruleReviewSubmissionSchema,
  ruleSchema,
  ruleUpdateRequestSchema,
  ruleRevokeRequestSchema,
  rulesMigrateRequestSchema,
} from '../../../src/domain/rules.js';

const RECORD_ID = 'a'.repeat(64);
const ACCEPTED_AT = '2026-01-01T00:00:00.000Z';
const EFFECTIVE_AT = '2026-01-02T00:00:00.000Z';
const CONTENT = 'Always run `npm run typecheck` before proposing a commit in this repo.';
const SCOPE = { kind: 'project', canonical_workspace: '/work/api' } as const;

function mkRule(overrides: Record<string, unknown> = {}): Rule {
  const baseHash = ruleContentHash({ content: CONTENT, scope: SCOPE });
  const base: Record<string, unknown> = {
    rule_id: computeRuleId(RECORD_ID, 'learning-001'),
    title: 'Typecheck before commit',
    content: CONTENT,
    content_hash: baseHash,
    scope: SCOPE,
    status: 'active',
    version: 1,
    accepted_at: ACCEPTED_AT,
    version_effective_at: EFFECTIVE_AT,
    source: {
      record_id: RECORD_ID,
      candidate_id: 'learning-001',
      candidate_path: `records/${RECORD_ID}/learning_candidates.md`,
      candidate_content_hash: sha256Tag('candidate v1'),
    },
    delivery: null,
    history: [{ at: ACCEPTED_AT, action: 'accepted', version: 1, content_hash: baseHash }],
    updated_at: EFFECTIVE_AT,
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  // A rule's content hash is derived, so an override of body or scope re-derives
  // it; passing content_hash or history explicitly keeps the caller's stale value.
  if (overrides['content_hash'] === undefined && overrides['history'] === undefined) {
    const hash = ruleContentHash({
      content: merged['content'] as string,
      scope: merged['scope'] as Parameters<typeof ruleContentHash>[0]['scope'],
    });
    merged['content_hash'] = hash;
    merged['history'] = [{ at: merged['accepted_at'], action: 'accepted', version: 1, content_hash: hash }];
  }
  return ruleSchema.parse(merged);
}

function mkDoc(overrides: Record<string, unknown> = {}): AcceptedRulesDocument {
  return acceptedRulesDocumentSchema.parse({
    schema: ROOT_ID,
    revision: 1,
    updated_at: EFFECTIVE_AT,
    rules: [mkRule()],
    request_log: [],
    ...overrides,
  });
}

describe('rule identity and content version (design 31.3)', () => {
  it('derives a stable rule_id from the adopting source only', () => {
    const first = computeRuleId(RECORD_ID, 'learning-001');
    assert.match(first, /^rule-[0-9a-f]{16}$/);
    assert.equal(first, computeRuleId(RECORD_ID, 'learning-001'));
    // Same source re-adopted never produces a second rule_id.
    assert.equal(first, computeRuleId(RECORD_ID, 'learning-001'));
    assert.notEqual(first, computeRuleId(RECORD_ID, 'learning-002'));
    assert.notEqual(first, computeRuleId('b'.repeat(64), 'learning-001'));
  });

  it('binds the content hash to body and scope, never to title or host', () => {
    const hash = ruleContentHash({ content: CONTENT, scope: SCOPE });
    assert.equal(hash, ruleContentHash({ content: CONTENT, scope: { ...SCOPE } }));
    assert.notEqual(hash, ruleContentHash({ content: `${CONTENT}.`, scope: SCOPE }));
    assert.notEqual(
      hash,
      ruleContentHash({ content: CONTENT, scope: { kind: 'user' } }),
      'promoting a rule to user scope is a new content version',
    );
    assert.notEqual(
      hash,
      ruleContentHash({ content: CONTENT, scope: { kind: 'project', canonical_workspace: '/work/other' } }),
    );
  });

  it('filters reviewable rules by structured scope', () => {
    const project = mkRule();
    const other = mkRule({ scope: { kind: 'project', canonical_workspace: '/work/other' } });
    const userScoped = mkRule({ scope: { kind: 'user' } });
    assert.equal(isScopeMatch(project.scope, '/work/api'), true);
    assert.equal(isScopeMatch(other.scope, '/work/api'), false);
    assert.equal(isScopeMatch(userScoped.scope, '/work/api'), true, 'user scope applies everywhere');
    assert.equal(isScopeMatch(project.scope, null), false, 'an unknown session workspace cannot claim a project rule');
    assert.equal(isScopeMatch(userScoped.scope, null), true);
  });
});

describe('rule schema (design 31.3)', () => {
  it('accepts a well-formed rule and keeps an unset delivery as an explicit null', () => {
    const rule = mkRule();
    assert.equal(rule.delivery, null);
    assert.deepEqual(JSON.parse(JSON.stringify(rule)), JSON.parse(JSON.stringify(mkRule(rule))));
  });

  it('rejects illegal status combinations', () => {
    const other = computeRuleId(RECORD_ID, 'learning-002');
    assert.throws(() => mkRule({ status: 'superseded' }), /superseded/);
    assert.throws(() => mkRule({ status: 'revoked', superseded_by: other }), /revoked/);
    assert.throws(() => mkRule({ status: 'active', superseded_by: other }), /active/);
    assert.throws(() => mkRule({ status: 'persisted' }));
    assert.throws(() => mkRule({ status: 'superseded', superseded_by: mkRule().rule_id }), /itself/);
  });

  it('refuses a content hash that does not match the current body and scope', () => {
    const rule = mkRule();
    assert.throws(
      () => mkRule({ content: 'rewritten body', content_hash: rule.content_hash }),
      /content_hash/,
    );
    assert.throws(
      () => mkRule({ scope: { kind: 'user' }, content_hash: rule.content_hash }),
      /content_hash/,
    );
    assert.throws(() => mkRule({ content_hash: sha256Tag('hand edited') }), /content_hash/);
  });

  it('requires a user operation entry for every version it claims', () => {
    const bumped = {
      ...mkRule(),
      version: 2,
      content: 'v2 body',
      content_hash: ruleContentHash({ content: 'v2 body', scope: SCOPE }),
      version_effective_at: '2026-02-01T00:00:00.000Z',
    };
    assert.throws(() => ruleSchema.parse(bumped), /version 2/);
    assert.doesNotThrow(() =>
      ruleSchema.parse({
        ...bumped,
        history: [
          ...bumped.history,
          {
            at: '2026-02-01T00:00:00.000Z',
            action: 'content_updated',
            version: 2,
            content_hash: bumped.content_hash,
            previous: { version: 1, content_hash: mkRule().content_hash, title: 'Typecheck before commit', content: CONTENT },
          },
        ],
      }),
    );
  });

  it('demands an acceptance entry first and a non-decreasing history', () => {
    assert.throws(() => mkRule({ history: [] }), /history/);
    assert.throws(
      () =>
        mkRule({
          history: [
            { at: ACCEPTED_AT, action: 'revoked', version: 1, content_hash: mkRule().content_hash },
          ],
        }),
      /acceptance/,
    );
    assert.throws(
      () =>
        mkRule({
          history: [
            { at: ACCEPTED_AT, action: 'content_updated', version: 3, content_hash: mkRule().content_hash },
            { at: ACCEPTED_AT, action: 'accepted', version: 1, content_hash: mkRule().content_hash },
          ],
        }),
      /decreasing|monotonic/,
    );
  });

  it('keeps adoption time at or before the current version effective time', () => {
    assert.throws(() => mkRule({ version_effective_at: '2025-12-31T00:00:00.000Z' }), /accepted_at/);
  });

  it('caps the rule body and the per-rule history instead of truncating silently', () => {
    assert.throws(() => mkRule({ content: 'x'.repeat(RULE_CONTENT_MAX_BYTES + 1) }), /content/);
    // The cap is UTF-8 bytes, so a short-looking CJK body still cannot slip past
    // the byte budgets the registry read limit and review snapshot packing use.
    assert.throws(() => mkRule({ content: '检'.repeat(2_000) }), /content/);
    assert.doesNotThrow(() => mkRule({ content: '检'.repeat(1_333) }));
    assert.throws(() => mkRule({ title: 'x'.repeat(201) }), /title/);
    const entry = { at: ACCEPTED_AT, action: 'accepted', version: 1, content_hash: mkRule().content_hash };
    assert.throws(() => mkRule({ history: Array.from({ length: RULE_HISTORY_MAX_ENTRIES + 1 }, () => entry) }), /history/);
  });

  it('only allows structured scopes', () => {
    assert.throws(() => mkRule({ scope: { kind: 'project', canonical_workspace: 'work/api' } }), /workspace/);
    assert.throws(() => mkRule({ scope: { kind: 'project', canonical_workspace: '/work/api/' } }), /workspace/);
    assert.throws(() => mkRule({ scope: { kind: 'project', canonical_workspace: '/work/../etc' } }), /workspace/);
    assert.throws(() => mkRule({ scope: { kind: 'project' } }), /workspace/);
    assert.throws(() => mkRule({ scope: { kind: 'general' } }), /kind/);
    assert.throws(() => mkRule({ scope: 'everything always' }));
    assert.throws(() => mkRule({ scope: { kind: 'project', canonical_workspace: '/work/api', host: 'codex' } }));
    assert.throws(
      () => mkRule({ scope: { kind: 'project', canonical_workspace: '/work/api', note: 'x'.repeat(RULE_SCOPE_NOTE_MAX_BYTES + 1) } }),
      /note/,
    );
    assert.doesNotThrow(() => mkRule({ scope: { kind: 'user' } }));
  });

  it('refuses a source reference that escapes the data root or is not a candidate id', () => {
    assert.throws(() => mkRule({ source: { ...mkRule().source, candidate_path: '/etc/passwd' } }), /candidate_path/);
    assert.throws(
      () => mkRule({ source: { ...mkRule().source, candidate_path: `records/../../secret.md` } }),
      /candidate_path/,
    );
    assert.throws(() => mkRule({ source: { ...mkRule().source, candidate_path: `records\\x\\y.md` } }), /candidate_path/);
    assert.throws(() => mkRule({ source: { ...mkRule().source, record_id: 'nope' } }), /record_id/);
    assert.throws(() => mkRule({ source: { ...mkRule().source, candidate_id: 'candidate-1' } }), /candidate_id/);
  });
});

describe('rule delivery receipts (design 31.4)', () => {
  it('accepts a harness receipt bound to the current version', () => {
    const rule = mkRule();
    const withDelivery = ruleSchema.parse({
      ...rule,
      delivery: {
        kind: 'harness',
        version: rule.version,
        content_hash: rule.content_hash,
        target_id: 'target-agents',
        display_path: 'AGENTS.md',
        state: 'verified',
        publication_id: 'pub-aaaaaa',
        updated_at: EFFECTIVE_AT,
      },
    });
    assert.equal(withDelivery.delivery?.state, 'verified');
  });

  it('never lets an older version receipt claim the current state', () => {
    assert.throws(() => mkRule({ delivery: { kind: 'harness', version: 41, content_hash: mkRule().content_hash, target_id: 't', display_path: 'AGENTS.md', state: 'verified', updated_at: EFFECTIVE_AT } }), /version/);
  });

  it('keeps harness and memory receipt shapes apart', () => {
    assert.throws(
      () => mkRule({ delivery: { kind: 'memory', version: 1, content_hash: mkRule().content_hash, state: 'exported', target_id: 'target-agents', updated_at: EFFECTIVE_AT } }),
    );
    assert.throws(
      () => mkRule({ delivery: { kind: 'memory', version: 1, content_hash: mkRule().content_hash, state: 'user_confirmed_saved', updated_at: EFFECTIVE_AT } }),
      /user_confirmed_at/,
    );
    assert.doesNotThrow(
      () =>
        mkRule({
          delivery: {
            kind: 'memory',
            version: 1,
            content_hash: mkRule().content_hash,
            state: 'user_confirmed_saved',
            user_confirmed_at: EFFECTIVE_AT,
            updated_at: EFFECTIVE_AT,
          },
        }),
    );
    assert.throws(() => mkRule({ delivery: { kind: 'harness', version: 1, content_hash: mkRule().content_hash, state: 'persisted', target_id: 't', display_path: 'p', updated_at: EFFECTIVE_AT } }));
    assert.throws(() => mkRule({ delivery: { kind: 'harness', version: 1, content_hash: mkRule().content_hash, state: 'verified', display_path: 'p', updated_at: EFFECTIVE_AT } }), /target_id/);
  });

  it('records a superseded rule with its replacement history', () => {
    const replacement = computeRuleId(RECORD_ID, 'learning-002');
    const revoked = mkRule({
      status: 'revoked',
      history: [
        ...mkRule().history,
        { at: EFFECTIVE_AT, action: 'revoked', version: 1, content_hash: mkRule().content_hash },
      ],
    });
    assert.equal(revoked.status, 'revoked');
    const superseded = mkRule({
      status: 'superseded',
      superseded_by: replacement,
      history: [
        ...mkRule().history,
        { at: EFFECTIVE_AT, action: 'superseded', version: 1, content_hash: mkRule().content_hash, superseded_by: replacement },
      ],
    });
    assert.equal(superseded.superseded_by, replacement);
    assert.throws(
      () =>
        mkRule({
          status: 'superseded',
          superseded_by: replacement,
          history: [
            ...mkRule().history,
            { at: EFFECTIVE_AT, action: 'revoked', version: 1, content_hash: mkRule().content_hash },
          ],
        }),
      /superseded/,
    );
  });

  it('requires a previous snapshot whenever a version replaced earlier content', () => {
    assert.throws(
      () =>
        mkRule({
          version: 1,
          history: [
            ...mkRule().history,
            { at: EFFECTIVE_AT, action: 'content_updated', version: 1, content_hash: mkRule().content_hash },
          ],
        }),
      /previous/,
    );
  });
});

describe('accepted rules root document (design 31.2/31.3)', () => {
  it('parses a document and creates an explicit empty registry for a fresh data root', () => {
    const doc = mkDoc();
    assert.equal(doc.rules.length, 1);
    const empty = initialRulesDocument(EFFECTIVE_AT);
    assert.equal(empty.schema, ROOT_ID);
    assert.equal(empty.revision, 1);
    assert.deepEqual(empty.rules, []);
    assert.equal(empty.pending_acceptance, null);
  });

  it('refuses an unknown or foreign schema id', () => {
    assert.throws(() => mkDoc({ schema: 'session-correction-analysis/accepted-rules/v2' }), /schema/);
    assert.throws(() => mkDoc({ schema: SCHEMA_ID }), /schema/);
  });

  it('refuses duplicate rule ids and non-positive revisions', () => {
    assert.throws(() => mkDoc({ rules: [mkRule(), mkRule()] }), /duplicate/);
    assert.throws(() => mkDoc({ revision: 0 }));
    assert.throws(() => mkDoc({ rules: mkRule() }));
  });

  it('caps rule count and request log size at the frozen budgets', () => {
    const big = Array.from({ length: ACCEPTED_RULES_MAX_RULES + 1 }, (_, i) =>
      mkRule({ rule_id: computeRuleId(RECORD_ID, `learning-${String(i + 1).padStart(3, '0')}`) }),
    );
    assert.equal(acceptedRulesDocumentSchema.safeParse({ ...mkDoc(), rules: big }).success, false);
    const receipts = Array.from({ length: RULES_REQUEST_LOG_MAX + 1 }, (_, i) => ({
      request_id: `r-${i}`,
      payload_hash: sha256Tag(`p-${i}`),
      result: 'applied',
      at: EFFECTIVE_AT,
    }));
    assert.equal(acceptedRulesDocumentSchema.safeParse({ ...mkDoc(), rules: [], request_log: receipts }).success, false);
  });

  it('keeps the schema id aligned with the compat table', () => {
    assert.ok(RULES_SCHEMA_COMPAT.some((entry) => entry.schema_id === ROOT_ID));
    assert.ok(RULES_SCHEMA_COMPAT.some((entry) => entry.schema_id === SCHEMA_ID));
    assert.ok(RULES_SCHEMA_COMPAT.some((entry) => entry.schema_id === RULE_REVIEW_SNAPSHOT_SCHEMA_ID));
    assert.ok(RULES_SCHEMA_COMPAT.some((entry) => entry.schema_id === MIGRATION_SCHEMA_ID));
    assert.deepEqual(
      RULES_SCHEMA_COMPAT.map((entry) => entry.schema_id),
      [...new Set(RULES_SCHEMA_COMPAT.map((entry) => entry.schema_id))],
      'each schema id appears once',
    );
  });
});

describe('pending acceptance (design 31.5)', () => {
  function mkPending(overrides: Record<string, unknown> = {}) {
    return pendingAcceptanceSchema.parse({
      request_id: 'adopt-1',
      payload_hash: sha256Tag('adopt-1'),
      rule_id: mkRule().rule_id,
      record_id: RECORD_ID,
      candidate_id: 'learning-001',
      candidate_expected_revision: 3,
      rules_expected_revision: 1,
      rules_expected_hash: sha256Tag('doc'),
      created_at: EFFECTIVE_AT,
      delta: { kind: 'add', rule: mkRule() },
      ...overrides,
    });
  }

  it('requires both sides of the expected version/hash pair', () => {
    assert.equal(mkPending().delta.kind, 'add');
    assert.throws(() => mkPending({ candidate_expected_revision: undefined }));
    assert.throws(() => mkPending({ rules_expected_hash: undefined }));
    assert.throws(
      () => mkPending({ journal_path: 'runtime/x' }),
      /journal_path/,
    );
  });

  it('pins the rule id so a replay can never invent a different one', () => {
    assert.throws(
      () => mkPending({ delta: { kind: 'add', rule: mkRule({ rule_id: computeRuleId(RECORD_ID, 'learning-009') }) } }),
      /rule_id/,
    );
  });

  it('bounds the replay delta to one rule', () => {
    assert.equal(acceptanceDeltaSchema.safeParse({ kind: 'add', rules: [mkRule()] }).success, false);
    assert.equal(acceptanceDeltaSchema.safeParse({ kind: 'add' }).success, false);
    assert.throws(
      () => acceptanceDeltaSchema.parse({ kind: 'update', rule: mkRule() }),
      /previous/,
    );
    assert.equal(
      acceptanceDeltaSchema.safeParse({
        kind: 'update',
        rule: mkRule(),
        previous: { version: 1, content_hash: mkRule().content_hash },
      }).success,
      true,
    );
  });

  it('refuses an oversized delta instead of truncating it', () => {
    assert.throws(
      () => mkPending({ delta: { kind: 'add', rule: { ...mkRule(), content: 'x'.repeat(RULE_CONTENT_MAX_BYTES + 1) } } }),
      /content/,
    );
  });
});

describe('candidate rule_ref keeps old semantics intact (design 31.3)', () => {
  function mkCandidateBase(overrides: Record<string, unknown> = {}) {
    return {
      id: 'learning-001',
      fingerprint: sha256Tag('fp'),
      category: 'process',
      title: 't',
      confidence: 'high',
      status: 'approved',
      maturity: 'single_session',
      target: { kind: 'harness' },
      evidence: ['ev-a'],
      source_episodes: ['ev-b'],
      proposed_content: 'body',
      decision: { action: 'approve', content_hash: sha256Tag('body'), target_kind: 'harness', at: ACCEPTED_AT },
      decision_history: [],
      publication: { published: false, attempts: [] },
      created_at: ACCEPTED_AT,
      updated_at: ACCEPTED_AT,
      ...overrides,
    };
  }

  it('parses a pre-rule candidate exactly as before', () => {
    const before = candidateSchema.parse(mkCandidateBase());
    assert.equal(before.rule_ref, undefined);
    assert.equal(before.decision?.content_hash, sha256Tag('body'));
  });

  it('accepts a rule_ref that binds the adopted content version', () => {
    const withRef = candidateSchema.parse(
      mkCandidateBase({
        rule_ref: {
          rule_id: computeRuleId(RECORD_ID, 'learning-001'),
          accepted_version: 1,
          candidate_content_hash: sha256Tag('body'),
          request_id: 'adopt-1',
          at: ACCEPTED_AT,
        },
      }),
    );
    assert.equal(withRef.rule_ref?.accepted_version, 1);
  });

  it('rejects malformed rule references', () => {
    assert.equal(ruleRefSchema.safeParse({
      rule_id: 'rule-xyz',
      accepted_version: 1,
      candidate_content_hash: sha256Tag('b'),
      at: ACCEPTED_AT,
    }).success, false);
    assert.equal(ruleRefSchema.safeParse({
      rule_id: computeRuleId(RECORD_ID, 'learning-001'),
      accepted_version: 0,
      candidate_content_hash: sha256Tag('b'),
      at: ACCEPTED_AT,
    }).success, false);
    assert.throws(
      () =>
        candidateSchema.parse(
          mkCandidateBase({
            rule_ref: {
              rule_id: computeRuleId(RECORD_ID, 'learning-001'),
              accepted_version: 1,
              candidate_content_hash: sha256Tag('b'),
              at: ACCEPTED_AT,
              status: 'active',
            },
          }),
        ),
      /status/,
    );
  });
});

describe('rule review snapshot (design 31.6)', () => {
  function snapshotBody(overrides: Record<string, unknown> = {}) {
    const rule = mkRule();
    return {
      schema: RULE_REVIEW_SNAPSHOT_SCHEMA_ID,
      record_id: RECORD_ID,
      analysis_id: 'an-1',
      analyze_revision: 4,
      rules_revision: 1,
      rules_file_hash: sha256Tag('doc'),
      session_workspace: '/work/api',
      created_at: EFFECTIVE_AT,
      coverage: 'full',
      rules: [
        {
          rule_id: rule.rule_id,
          version: rule.version,
          content_hash: rule.content_hash,
          title: rule.title,
          content: rule.content,
          scope: rule.scope,
          status: rule.status,
          accepted_at: rule.accepted_at,
          version_effective_at: rule.version_effective_at,
          delivery: rule.delivery,
          source: rule.source,
        },
      ],
      episodes: [{ episode_id: `ep-${'a'.repeat(16)}`, evidence: ['ev-1'] }],
      evidence: [
        {
          id: 'ev-1',
          kind: 'user_text',
          excerpt: 'stop doing that',
          source_ref: { line: 7, hash: sha256Tag('e7') },
        },
      ],
      ...overrides,
    };
  }

  it('freezes rule bodies, versions and evidence with a digest', () => {
    const body = snapshotBody();
    const digest = computeRuleReviewDigest(body);
    const snap = ruleReviewSnapshotSchema.parse({ ...body, input_digest: digest });
    assert.equal(snap.input_digest, digest);
    assert.equal(snap.rules[0]?.content, CONTENT);
    // created_at is metadata; the frozen contract digest ignores it.
    assert.equal(computeRuleReviewDigest({ ...body, created_at: '2024-01-01T00:00:00.000Z' }), digest);
    assert.notEqual(computeRuleReviewDigest({ ...body, coverage: 'partial' }), digest);
    assert.notEqual(
      computeRuleReviewDigest({
        ...body,
        rules: [{ ...body.rules[0], content_hash: sha256Tag('other') }],
      }),
      digest,
    );
  });

  it('rejects a snapshot whose rule content hash was tampered with', () => {
    const body = snapshotBody();
    const tampered = {
      ...body,
      rules: [{ ...body.rules[0], content: 'silently different body', content_hash: body.rules[0]?.content_hash }],
    };
    assert.throws(
      () => ruleReviewSnapshotSchema.parse({ ...tampered, input_digest: computeRuleReviewDigest(tampered) }),
      /content_hash/,
    );
  });

  it('rejects duplicate rules, unknown schema, and out-of-budget collections', () => {
    const body = snapshotBody();
    const digest = computeRuleReviewDigest(body);
    assert.throws(
      () =>
        ruleReviewSnapshotSchema.parse({
          ...body,
          rules: [...body.rules, ...body.rules],
          input_digest: digest,
        }),
      /duplicate/,
    );
    assert.throws(() => ruleReviewSnapshotSchema.parse({ ...body, schema: 'x', input_digest: digest }), /schema/);
    const many = Array.from({ length: RULE_REVIEW_SNAPSHOT_MAX_RULES + 1 }, (_, i) => ({
      ...body.rules[0],
      rule_id: computeRuleId(RECORD_ID, `learning-${String(i + 1).padStart(3, '0')}`),
    }));
    assert.equal(ruleReviewSnapshotSchema.safeParse({ ...body, rules: many, input_digest: digest }).success, false);
    assert.equal(
      ruleReviewSnapshotSchema.safeParse({
        ...body,
        rules: [{ ...body.rules[0], content: 'x'.repeat(RULE_CONTENT_MAX_BYTES + 1) }],
        input_digest: digest,
      }).success,
      false,
    );
  });
});

describe('rule review submission and observations (design 31.6)', () => {
  const ruleId = computeRuleId(RECORD_ID, 'learning-001');
  const rule = mkRule();

  function mkObservation(overrides: Record<string, unknown> = {}) {
    return ruleObservationSubmissionSchema.parse({
      rule_id: ruleId,
      version: rule.version,
      content_hash: rule.content_hash,
      relation: 'recurrence_detected',
      episode_id: `ep-${'a'.repeat(16)}`,
      evidence: ['ev-1'],
      explanation: 'the same missing typecheck step reappeared at line 40',
      ...overrides,
    });
  }

  it('accepts the three allowed relations and nothing else', () => {
    assert.equal(mkObservation().relation, 'recurrence_detected');
    assert.equal(mkObservation({ relation: 'possibly_related', evidence: ['ev-1'] }).relation, 'possibly_related');
    assert.equal(
      mkObservation({ relation: 'no_recurrence_observed', episode_id: undefined, evidence: [] }).relation,
      'no_recurrence_observed',
    );
    assert.throws(() => mkObservation({ relation: 'rule_violated' }), /relation/);
  });

  it('requires evidence behind a claimed recurrence', () => {
    assert.throws(() => mkObservation({ evidence: [] }), /evidence/);
    assert.throws(() => mkObservation({ episode_id: undefined }), /episode_id/);
    assert.throws(
      () => mkObservation({ relation: 'no_recurrence_observed', evidence: [] }),
      /episode_id/,
    );
    assert.throws(() => mkObservation({ explanation: '' }), /explanation/);
    assert.throws(() => mkObservation({ explanation: 'x'.repeat(RULE_OBSERVATION_EXPLANATION_MAX_BYTES + 1) }), /explanation/);
  });

  it('never lets the model submit authority fields', () => {
    assert.equal(
      ruleReviewSubmissionSchema.safeParse({
        snapshot_digest: sha256Tag('snap'),
        coverage: { status: 'full', considered: [ruleId], reviewed: [ruleId], skipped: [] },
        observations: [{ ...mkObservation(), status: 'active' }],
      }).success,
      false,
    );
    assert.equal(
      ruleReviewSubmissionSchema.safeParse({
        snapshot_digest: sha256Tag('snap'),
        coverage: { status: 'full', considered: [ruleId], reviewed: [ruleId], skipped: [] },
        observations: [mkObservation()],
        delivery: { state: 'verified' },
      }).success,
      false,
    );
  });

  it('deduplicates observations by rule, version and episode', () => {
    const submission = {
      snapshot_digest: sha256Tag('snap'),
      coverage: { status: 'full', considered: [ruleId], reviewed: [ruleId], skipped: [] },
      observations: [mkObservation(), mkObservation()],
    };
    assert.equal(ruleReviewSubmissionSchema.safeParse(submission).success, false);
    assert.equal(
      ruleReviewSubmissionSchema.safeParse({
        ...submission,
        observations: [mkObservation(), mkObservation({ episode_id: `ep-${'b'.repeat(16)}` })],
      }).success,
      true,
    );
  });

  it('classifies time relationships conservatively', () => {
    assert.equal(
      classifyTemporal({ rule_version_effective_at: EFFECTIVE_AT }),
      'temporal_unknown',
    );
    assert.equal(
      classifyTemporal({ episode_event_at: '2025-12-31T00:00:00.000Z', rule_version_effective_at: EFFECTIVE_AT }),
      'historical_relation',
    );
    assert.equal(
      classifyTemporal({ episode_event_at: '2026-03-01T00:00:00.000Z', rule_version_effective_at: EFFECTIVE_AT }),
      'subsequent_recurrence',
    );
    assert.equal(
      classifyTemporal({
        episode_event_at: '2026-03-01T00:00:00.000Z',
        rule_version_effective_at: EFFECTIVE_AT,
        delivered_at: '2026-02-01T00:00:00.000Z',
      }),
      'post_delivery_recurrence',
    );
    assert.equal(
      classifyTemporal({
        episode_event_at: '2026-01-15T00:00:00.000Z',
        rule_version_effective_at: EFFECTIVE_AT,
        delivered_at: '2026-02-01T00:00:00.000Z',
      }),
      'subsequent_recurrence',
    );
    assert.equal(
      classifyTemporal({ episode_event_at: 'garbage', rule_version_effective_at: EFFECTIVE_AT }),
      'temporal_unknown',
    );
  });

  it('binds a committed observation to the snapshot and its timestamps', () => {
    function committed(overrides: Record<string, unknown> = {}) {
      return ruleObservationSchema.parse({
        rule_id: ruleId,
        version: rule.version,
        content_hash: rule.content_hash,
        relation: 'recurrence_detected',
        episode_id: `ep-${'a'.repeat(16)}`,
        evidence: ['ev-1'],
        explanation: 'reappeared',
        temporal: 'subsequent_recurrence',
        episode_event_at: '2026-03-01T00:00:00.000Z',
        rule_version_effective_at: EFFECTIVE_AT,
        snapshot_digest: sha256Tag('snap'),
        observed_at: '2026-03-02T00:00:00.000Z',
        ...overrides,
      });
    }
    assert.equal(committed().temporal, 'subsequent_recurrence');
    assert.equal(committed({ delivered_at: '2026-02-01T00:00:00.000Z', temporal: 'post_delivery_recurrence' }).temporal, 'post_delivery_recurrence');
    assert.throws(() => committed({ temporal: 'post_delivery_recurrence' }), /delivered_at/);
    assert.throws(() => committed({ temporal: 'historical_relation' }), /historical_relation/);
    assert.throws(() => committed({ temporal: 'temporal_unknown' }), /temporal_unknown/);
    assert.doesNotThrow(() =>
      committed({
        relation: 'no_recurrence_observed',
        episode_id: undefined,
        episode_event_at: undefined,
        evidence: [],
        temporal: 'temporal_unknown',
      }),
    );
  });

  it('reports review coverage separately from transcript coverage', () => {
    const base = { considered: [ruleId], reviewed: [ruleId], skipped: [] };
    assert.equal(ruleReviewCoverageSchema.parse({ status: 'full', ...base }).status, 'full');
    assert.throws(() => ruleReviewCoverageSchema.parse({ status: 'unknown', ...base }), /status/);
    assert.throws(
      () => ruleReviewCoverageSchema.parse({ status: 'full', considered: [ruleId], reviewed: [], skipped: [{ rule_id: ruleId, reason: 'budget' }] }),
      /full/,
    );
    assert.throws(
      () => ruleReviewCoverageSchema.parse({ status: 'partial', considered: [], reviewed: [ruleId], skipped: [] }),
      /considered/,
    );
    assert.throws(
      () => ruleReviewCoverageSchema.parse({ status: 'partial', considered: [ruleId], reviewed: [ruleId], skipped: [{ rule_id: ruleId, reason: 'budget' }] }),
      /both/,
    );
    assert.equal(
      ruleReviewCoverageSchema.parse({
        status: 'unavailable',
        considered: [],
        reviewed: [],
        skipped: [],
        reason: 'registry corrupt',
      }).status,
      'unavailable',
    );
  });
});

describe('analyze.md rule review block (design 31.2)', () => {
  const ruleId = computeRuleId(RECORD_ID, 'learning-001');
  const rule = mkRule();
  const digest = sha256Tag('snapshot');

  function analyzeDoc(overrides: Record<string, unknown> = {}) {
    return analyzeDocumentSchema.parse({
      schema: SCHEMA_ID,
      session_id: 'thr_1',
      source: 'codex',
      trigger: 'manual_skill',
      analysis_status: 'completed',
      analyzer_version: '0.1.0',
      revision: 4,
      created_at: ACCEPTED_AT,
      ...overrides,
    });
  }

  function reviewBlock(overrides: Record<string, unknown> = {}) {
    return {
      analysis_id: 'an-1',
      snapshot_digest: digest,
      rules_revision: 1,
      taken_at: EFFECTIVE_AT,
      coverage: { status: 'full', considered: [ruleId], reviewed: [ruleId], skipped: [] },
      used_rules: [
        {
          rule_id: ruleId,
          version: 1,
          content_hash: rule.content_hash,
          title: rule.title,
          content: rule.content,
          scope: rule.scope,
          status: 'active',
          accepted_at: rule.accepted_at,
          version_effective_at: rule.version_effective_at,
          delivery: rule.delivery,
          source: rule.source,
        },
      ],
      observations: [
        {
          rule_id: ruleId,
          version: 1,
          content_hash: rule.content_hash,
          relation: 'recurrence_detected',
          episode_id: `ep-${'a'.repeat(16)}`,
          evidence: ['ev-1'],
          explanation: 'reappeared',
          temporal: 'subsequent_recurrence',
          episode_event_at: '2026-03-01T00:00:00.000Z',
          rule_version_effective_at: EFFECTIVE_AT,
          snapshot_digest: digest,
          observed_at: '2026-03-02T00:00:00.000Z',
        },
      ],
      ...overrides,
    };
  }

  it('leaves a session document without rule review untouched', () => {
    assert.equal(analyzeDoc().rule_review, undefined);
  });

  it('stores the used-rule snapshot and observations together', () => {
    const doc = analyzeDoc({ rule_review: reviewBlock() });
    assert.equal(doc.rule_review?.observations.at(-1)?.rule_id, ruleId);
    assert.equal(doc.rule_review?.used_rules.length, 1);
  });

  it('refuses observations for a rule the snapshot never carried', () => {
    assert.throws(
      () =>
        analyzeDoc({
          rule_review: reviewBlock({
            observations: [
              { ...reviewBlock().observations[0], rule_id: computeRuleId(RECORD_ID, 'learning-077') },
            ],
          }),
        }),
      /used_rules/,
    );
    assert.throws(
      () =>
        analyzeDoc({
          rule_review: reviewBlock({
            coverage: { status: 'full', considered: [computeRuleId(RECORD_ID, 'learning-077')], reviewed: [computeRuleId(RECORD_ID, 'learning-077')], skipped: [] },
          }),
        }),
      /considered/,
    );
    assert.throws(
      () => analyzeDoc({ rule_review: reviewBlock({ observations: [reviewBlock().observations[0], reviewBlock().observations[0]] }) }),
      /duplicate/,
    );
  });

  it('keeps the snapshot digest consistent across the block', () => {
    assert.throws(
      () => analyzeDoc({ rule_review: reviewBlock({ snapshot_digest: sha256Tag('other') }) }),
      /snapshot_digest/,
    );
  });
});

describe('change request contracts (design 31.4/31.5)', () => {
  const ruleId = computeRuleId(RECORD_ID, 'learning-001');

  it('requires explicit user confirmation before a rule version replaces content', () => {
    const update = {
      request_id: 'upd-1',
      rule_id: ruleId,
      expected_revision: 1,
      expected_version: 1,
      expected_content_hash: mkRule().content_hash,
      content: 'new body',
      note: 'user confirmed in the Skill session',
      confirmed: true,
    };
    assert.equal(ruleUpdateRequestSchema.parse(update).confirmed, true);
    assert.throws(() => ruleUpdateRequestSchema.parse({ ...update, confirmed: false }), /confirm/);
    assert.throws(() => ruleUpdateRequestSchema.parse({ ...update, confirmed: undefined }));
    assert.throws(() => ruleUpdateRequestSchema.parse({ ...update, content: undefined, scope: undefined, title: undefined }), /content|scope|title/);
    assert.throws(() => ruleUpdateRequestSchema.parse({ ...update, status: 'active' }));
    assert.throws(() => ruleUpdateRequestSchema.parse({ ...update, content: 'x'.repeat(RULE_CONTENT_MAX_BYTES + 1) }), /content/);
  });

  it('routes adoption and revocation through request ids and expected versions', () => {
    assert.equal(
      ruleAdoptRequestSchema.parse({
        request_id: 'adopt-1',
        record_id: RECORD_ID,
        candidate_id: 'learning-001',
        expected_revision: 3,
        expected_candidate_content_hash: sha256Tag('body'),
        scope: SCOPE,
        confirmed: true,
      }).candidate_id,
      'learning-001',
    );
    assert.throws(
      () => ruleAdoptRequestSchema.parse({ request_id: 'a', record_id: RECORD_ID, candidate_id: 'learning-001', expected_revision: 3, scope: SCOPE, confirmed: true }),
      /expected_candidate_content_hash/,
    );
    assert.throws(
      () => ruleAdoptRequestSchema.parse({ request_id: 'a', record_id: RECORD_ID, candidate_id: 'learning-001', expected_revision: 3, expected_candidate_content_hash: sha256Tag('b'), scope: { kind: 'user' }, confirmed: false }),
      /confirm/,
    );
    assert.throws(
      () => ruleRevokeRequestSchema.parse({ request_id: 'r', rule_id: ruleId, expected_revision: 1, expected_version: 1, confirmed: true, rollback_target: true }),
      /rollback/,
    );
  });

  it('freezes the migrate request to explicit, backed-up apply', () => {
    assert.equal(rulesMigrateRequestSchema.parse({ mode: 'dry_run', expected_revision: 1 }).mode, 'dry_run');
    assert.equal(
      rulesMigrateRequestSchema.parse({ mode: 'apply', expected_revision: 1, backup_dir: '/tmp/backup', batch_size: 20 })
        .mode,
      'apply',
    );
    assert.throws(() => rulesMigrateRequestSchema.parse({ mode: 'apply', expected_revision: 1 }), /backup_dir/);
    assert.throws(() => rulesMigrateRequestSchema.parse({ mode: 'apply', expected_revision: 1, backup_dir: '/tmp/b', batch_size: RULES_MIGRATE_BATCH_MAX + 1 }), /batch_size/);
    assert.throws(() => rulesMigrateRequestSchema.parse({ mode: 'apply', expected_revision: 1, backup_dir: '/tmp/b', record_ids: ['nope'] }), /record_ids/);
  });

  it('never fabricates scope or adoption time during migration', () => {
    const importable = {
      record_id: RECORD_ID,
      candidate_id: 'learning-001',
      disposition: 'import',
      reason: 'approval matches the current content version',
      candidate_content_hash: sha256Tag('body'),
      rule_id: ruleId,
      proposed_scope: SCOPE,
      accepted_at: ACCEPTED_AT,
    };
    assert.equal(migrationItemSchema.parse(importable).disposition, 'import');
    assert.throws(
      () => migrationItemSchema.parse({ ...importable, accepted_at: undefined }),
      /accepted_at/,
    );
    assert.throws(
      () => migrationItemSchema.parse({ ...importable, disposition: 'needs_review_missing_scope', proposed_scope: SCOPE }),
      /needs_review/,
    );
    assert.equal(
      migrationItemSchema.parse({
        ...importable,
        disposition: 'needs_review_missing_time',
        rule_id: undefined,
        proposed_scope: undefined,
        accepted_at: undefined,
      }).disposition,
      'needs_review_missing_time',
    );
    assert.throws(
      () =>
        migrationItemSchema.parse({
          ...importable,
          disposition: 'needs_review_missing_time',
          proposed_scope: undefined,
          accepted_at: undefined,
        }),
      /needs_review/,
    );
    assert.throws(() => migrationItemSchema.parse({ ...importable, disposition: 'auto_promote' }), /disposition/);
  });
});

describe('registry paths, lock order and frozen budgets (design 31.5)', () => {
  it('puts the registry in the data root as authoritative business data', () => {
    const paths = resolvePaths('/tmp/sca-root');
    assert.equal(acceptedRulesPath(paths), path.join('/tmp/sca-root', ACCEPTED_RULES_FILE_NAME));
    assert.ok(!acceptedRulesPath(paths).includes('runtime'), 'the registry is never a cache');
    assert.equal(registryLockTarget(paths), path.join(paths.locksDir, REGISTRY_LOCK_NAME));
    assert.ok(registryLockTarget(paths).includes('runtime'));
  });

  it('freezes the global lock acquisition order', () => {
    assert.deepEqual([...LOCK_ORDER], ['registry', 'session', 'target']);
  });

  it('pins the LC-01 numbers and their ordering invariants', () => {
    assert.equal(RULE_CONTENT_MAX_BYTES, 4_000);
    assert.equal(RULE_SCOPE_NOTE_MAX_BYTES, 500);
    assert.equal(RULE_HISTORY_MAX_ENTRIES, 200);
    assert.equal(ACCEPTED_RULES_MAX_RULES, 5_000);
    assert.equal(ACCEPTED_RULES_READ_MAX_BYTES, 16 * 1024 * 1024);
    assert.equal(RULES_REQUEST_LOG_MAX, 500);
    assert.equal(RULES_MIGRATE_BATCH_MAX, 50);
    assert.equal(RULE_REVIEW_SNAPSHOT_MAX_BYTES, 192 * 1024);
    assert.equal(RULE_REVIEW_SNAPSHOT_MAX_RULES, 40);
    assert.equal(RULE_OBSERVATION_EXPLANATION_MAX_BYTES, 1_000);
    assert.ok(
      RULE_REVIEW_SNAPSHOT_MAX_BYTES < PENDING_COMMIT_MAX_BYTES,
      'a review snapshot must fit inside the single pending budget',
    );
    assert.ok(ACCEPTED_RULES_READ_MAX_BYTES > RULE_REVIEW_SNAPSHOT_MAX_BYTES);
  });

  it('adds the registry error codes with a next step each', () => {
    for (const code of [
      'rules_registry_missing',
      'migration_required',
      'rule_not_found',
      'rule_scope_unknown',
      'rule_version_mismatch',
      'rule_acceptance_recovery_failed',
      'registry_changed',
      'request_conflict',
    ] as const) {
      const spec = ERROR_CODES[code];
      assert.ok(spec, `${code} must exist`);
      assert.ok(spec.nextStep.length > 0);
    }
  });

  it('keeps the frozen contract document in sync with the code', async () => {
    const doc = await fs.readFile(
      path.join(import.meta.dirname, '../../../..', 'packaging', 'accepted-rules-contract.md'),
      'utf8',
    );
    for (const id of [ROOT_ID, SCHEMA_ID, RULE_REVIEW_SNAPSHOT_SCHEMA_ID, MIGRATION_SCHEMA_ID]) {
      assert.ok(doc.includes(id), `${id} must be documented`);
    }
    for (const code of ['rules_registry_missing', 'migration_required', 'rule_scope_unknown', 'registry_changed', 'request_conflict']) {
      assert.ok(doc.includes(code), `${code} must be documented`);
    }
    for (const value of [RULE_CONTENT_MAX_BYTES, ACCEPTED_RULES_READ_MAX_BYTES, RULE_REVIEW_SNAPSHOT_MAX_RULES, RULES_MIGRATE_BATCH_MAX]) {
      assert.ok(doc.includes(String(value)), `${value} must be documented with its measurement`);
    }
    for (const command of ['list', 'show', 'update', 'revoke', 'migrate', 'review-prepare', 'review-ingest']) {
      assert.ok(doc.includes(`rules ${command}`), `sca rules ${command} must be documented`);
    }
    assert.ok(doc.includes(ACCEPTED_RULES_FILE_NAME));
    assert.ok(doc.includes(REGISTRY_LOCK_NAME));
    assert.ok(doc.includes('1000'));
  });
});
