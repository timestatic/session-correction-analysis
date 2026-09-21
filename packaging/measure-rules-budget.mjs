// LC-01 budget measurement for the accepted-rules registry (design 31.1/31.6).
// Build synthetic registries, serialize them the way the store does, and print
// the sizes and parse costs the frozen limits in src/domain/limits.ts are set
// against. Run after `npm run build`:  node packaging/measure-rules-budget.mjs
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { Buffer } from 'node:buffer';

import {
  ACCEPTED_RULES_READ_MAX_BYTES,
  RULE_CONTENT_MAX_BYTES,
  RULE_REVIEW_SNAPSHOT_MAX_BYTES,
  RULE_REVIEW_SNAPSHOT_MAX_RULES,
  RULE_SCOPE_NOTE_MAX_BYTES,
} from '../dist/src/domain/limits.js';
import {
  acceptedRulesDocumentSchema,
  computeRuleId,
  computeRuleReviewDigest,
  ruleContentHash,
  ruleReviewSnapshotSchema,
} from '../dist/src/domain/rules.js';
import { parseFrontmatterYaml, renderDocument, splitFrontmatter } from '../dist/src/store/frontmatter.js';

const RECORD_ID = 'a'.repeat(64);
const BODY_UNIT = 'run the frozen typecheck and lint gates before proposing a commit; report failures verbatim instead of claiming success. ';
const CJK_UNIT = '提交任何改动之前必须运行冻结的 typecheck 与 lint 门禁，失败原样报告，不得声称已通过。';

function ruleBody(targetBytes, cjk = false) {
  const unit = cjk ? CJK_UNIT : BODY_UNIT;
  let text = '';
  while (Buffer.byteLength(text, 'utf8') < targetBytes) {
    text += unit;
  }
  // Trim on a byte boundary without splitting a multi-byte character.
  const buf = Buffer.from(text, 'utf8').subarray(0, targetBytes);
  return buf.toString('utf8').replace(/\uFFFD$/u, '');
}

function mkRule(index, bodyBytes, cjk = false) {
  const content = ruleBody(bodyBytes, cjk);
  const scope = { kind: 'project', canonical_workspace: `/work/project-${index % 25}` };
  const hash = ruleContentHash({ content, scope });
  const ruleId = computeRuleId(RECORD_ID, `learning-${String(index + 1).padStart(3, '0')}`);
  return {
    rule_id: ruleId,
    title: cjk ? `规则第 ${index + 1} 条：提交前必须通过冻结门禁` : `Rule ${index + 1}`,
    content,
    scope,
    status: 'active',
    version: 1,
    content_hash: hash,
    accepted_at: '2026-01-01T00:00:00.000Z',
    version_effective_at: '2026-01-01T00:00:00.000Z',
    source: {
      record_id: RECORD_ID,
      candidate_id: `learning-${String(index + 1).padStart(3, '0')}`,
      candidate_path: `records/${RECORD_ID}/learning_candidates.md`,
      candidate_content_hash: `sha256:${'b'.repeat(64)}`,
    },
    delivery: index % 2 === 0
      ? null
      : {
          kind: 'harness',
          version: 1,
          content_hash: hash,
          target_id: 'target-agents',
          display_path: 'AGENTS.md',
          state: 'verified',
          publication_id: `pub-${'c'.repeat(6)}`,
          updated_at: '2026-01-02T00:00:00.000Z',
        },
    history: [{ at: '2026-01-01T00:00:00.000Z', action: 'accepted', version: 1, content_hash: hash }],
    updated_at: '2026-01-02T00:00:00.000Z',
  };
}

/** Same human-readable projection the session documents carry (design 31.2). */
function projection(rules) {
  const lines = ['# Accepted rules', ''];
  for (const rule of rules) {
    lines.push(`## ${rule.title} (${rule.rule_id} v${rule.version})`, '', rule.content, '');
  }
  return lines.join('\n');
}

function measureRegistry(count, bodyBytes, cjk = false) {
  const rules = Array.from({ length: count }, (_, i) => mkRule(i, bodyBytes, cjk));
  const doc = {
    schema: 'session-correction-analysis/accepted-rules/v1',
    revision: 1,
    updated_at: '2026-01-02T00:00:00.000Z',
    rules,
    request_log: [],
    pending_acceptance: null,
  };
  const text = renderDocument(doc, projection(rules));
  const yamlText = splitFrontmatter(text).yamlText;
  const start = performance.now();
  const parsed = acceptedRulesDocumentSchema.parse(parseFrontmatterYaml(yamlText));
  const parseMs = performance.now() - start;
  return {
    rules: count,
    body_bytes: Buffer.byteLength(rules[0].content, 'utf8'),
    script: cjk ? 'cjk' : 'ascii',
    file_bytes: Buffer.byteLength(text, 'utf8'),
    frontmatter_bytes: Buffer.byteLength(yamlText, 'utf8'),
    avg_rule_bytes: Math.round(Buffer.byteLength(text, 'utf8') / count),
    parse_ms: Math.round(parseMs * 10) / 10,
    reparsed_rules: parsed.rules.length,
  };
}

function measureSnapshot(count, bodyBytes, cjk = false) {
  const rules = Array.from({ length: count }, (_, i) => {
    const rule = mkRule(i, bodyBytes, cjk);
    if (!cjk) {
      return rule;
    }
    // A scope note changes the content hash, so the frozen body stays consistent.
    const scope = { ...rule.scope, note: ruleBody(RULE_SCOPE_NOTE_MAX_BYTES, true) };
    return { ...rule, scope, content_hash: ruleContentHash({ content: rule.content, scope }) };
  });
  const body = {
    schema: 'session-correction-analysis/rule-review-snapshot/v1',
    record_id: RECORD_ID,
    analysis_id: 'an-measure',
    analyze_revision: 1,
    rules_revision: 1,
    rules_file_hash: `sha256:${'d'.repeat(64)}`,
    session_workspace: '/work/project-0',
    created_at: '2026-01-02T00:00:00.000Z',
    coverage: 'full',
    rules: rules.map((rule) => ({
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
    })),
    episodes: [{ episode_id: `ep-${'a'.repeat(16)}`, evidence: ['ev-1'] }],
    evidence: [
      {
        id: 'ev-1',
        kind: 'user_text',
        excerpt: 'you skipped the typecheck again',
        source_ref: { line: 12, hash: `sha256:${'e'.repeat(64)}` },
      },
    ],
  };
  const snapshot = ruleReviewSnapshotSchema.parse({ ...body, input_digest: computeRuleReviewDigest(body) });
  return {
    rules: count,
    body_bytes: Buffer.byteLength(snapshot.rules[0].content, 'utf8'),
    script: cjk ? 'cjk' : 'ascii',
    snapshot_bytes: Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
    envelope_bytes: Buffer.byteLength(JSON.stringify({ ...snapshot, rules: [], episodes: [], evidence: [] }), 'utf8'),
  };
}

const out = {
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  frozen_limits: {
    RULE_CONTENT_MAX_BYTES,
    RULE_SCOPE_NOTE_MAX_BYTES,
    ACCEPTED_RULES_READ_MAX_BYTES,
    RULE_REVIEW_SNAPSHOT_MAX_BYTES,
    RULE_REVIEW_SNAPSHOT_MAX_RULES,
  },
  registry: [
    measureRegistry(100, 1_024),
    measureRegistry(1_000, 1_024),
    measureRegistry(1_000, RULE_CONTENT_MAX_BYTES),
    measureRegistry(1_000, RULE_CONTENT_MAX_BYTES, true),
  ].map((row) => ({ ...row, within_read_budget: row.file_bytes <= ACCEPTED_RULES_READ_MAX_BYTES })),
  snapshot: [
    measureSnapshot(10, 1_024),
    measureSnapshot(RULE_REVIEW_SNAPSHOT_MAX_RULES, 1_024),
    measureSnapshot(RULE_REVIEW_SNAPSHOT_MAX_RULES, RULE_CONTENT_MAX_BYTES),
    measureSnapshot(RULE_REVIEW_SNAPSHOT_MAX_RULES, RULE_CONTENT_MAX_BYTES, true),
    measureSnapshot(30, RULE_CONTENT_MAX_BYTES, true),
    measureSnapshot(1, RULE_CONTENT_MAX_BYTES, true),
  ].map((row) => ({ ...row, within_snapshot_budget: row.snapshot_bytes <= RULE_REVIEW_SNAPSHOT_MAX_BYTES })),
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
