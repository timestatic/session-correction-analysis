import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeDocumentSchema,
  candidatesDocumentSchema,
  pendingCommitSchema,
} from '../../../src/domain/documents.js';
import { episodeSubmissionSchema, evidenceItemSchema } from '../../../src/domain/episodes.js';
import { candidateSchema } from '../../../src/domain/candidates.js';
import { HASH_A } from './helpers.js';
import { makeCandidate, makeEpisode } from './helpers.js';

function makeAnalyzeDocument() {
  return {
    schema: 'session-correction-analysis/v1',
    session_id: 'thr_123',
    session_title: '第四批联调测试-2',
    source: 'codex',
    project_name: 'dpp_v3',
    workspace: '/repo/dpp_v3',
    transcript_path: '/logs/rollout.jsonl',
    trigger: 'session_end',
    analysis_status: 'completed',
    analysis_id: 'an-001',
    transcript_fingerprint: HASH_A,
    analyzer_version: '0.1.0',
    revision: 3,
    created_at: '2026-09-19T14:30:00+08:00',
    analyzed_at: '2026-09-19T15:00:00+08:00',
    error: null,
    facts: {
      snapshot: {
        source_kind: 'codex_transcript',
        host: 'codex',
        source_session_id: 'thr_123',
        coverage: 'full',
        parser_version: '0.1.0',
        rule_version: 'r-1',
      },
      episodes: [makeEpisode()],
      evidence: [
        {
          id: 'ev-1',
          kind: 'user_text',
          excerpt: '不是这个来源，字段来自流程变量',
          source_ref: { line: 42, hash: HASH_A },
          truncated: false,
        },
      ],
      runs: [],
      parse_errors: [],
    },
  };
}

describe('analyze.md frontmatter schema', () => {
  it('accepts a completed document with Chinese content and offset timezone', () => {
    const parsed = analyzeDocumentSchema.safeParse(makeAnalyzeDocument());
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? {}));
  });

  it('rejects unknown root keys instead of silently storing them', () => {
    const parsed = analyzeDocumentSchema.safeParse({
      ...makeAnalyzeDocument(),
      surprise: true,
    });
    assert.equal(parsed.success, false);
  });

  it('rejects a foreign schema id (unknown schema opens read-only path later)', () => {
    const parsed = analyzeDocumentSchema.safeParse({
      ...makeAnalyzeDocument(),
      schema: 'session-correction-analysis/v9',
    });
    assert.equal(parsed.success, false);
  });

  it('rejects non-monotonic revisions', () => {
    const parsed = analyzeDocumentSchema.safeParse({ ...makeAnalyzeDocument(), revision: 0 });
    assert.equal(parsed.success, false);
  });

  it('accepts a pending skeleton without facts (register slice)', () => {
    const doc = makeAnalyzeDocument();
    const parsed = analyzeDocumentSchema.safeParse({
      schema: doc.schema,
      session_id: doc.session_id,
      source: doc.source,
      trigger: doc.trigger,
      analysis_status: 'pending',
      analyzer_version: '0.1.0',
      revision: 1,
      created_at: doc.created_at,
    });
    assert.equal(parsed.success, true);
  });
});

describe('evidence items', () => {
  it('require a source hash locator', () => {
    assert.equal(
      evidenceItemSchema.safeParse({
        id: 'ev-1',
        kind: 'user_text',
        excerpt: 'x',
        source_ref: { line: 1 },
        truncated: false,
      }).success,
      false,
    );
  });
});

describe('model episode submission', () => {
  it('rejects authority fields such as status or published', () => {
    const submission = {
      anchor_event_id: 'ev-1',
      issue_anchor: 'a',
      correction: {
        detected: true,
        confidence: 'high',
        prior_agent_behavior: [],
        agent_behavior_after: [],
        explanation: 'x',
      },
      intervention: {
        detected: false,
        confidence: 'uncertain',
        evidence: [],
        explanation: 'x',
      },
      citations: [{ evidence_id: 'ev-1', quote: 'q' }],
      status: 'published',
    };
    assert.equal(episodeSubmissionSchema.safeParse(submission).success, false);
  });

  it('rejects an episode that asserts no label', () => {
    const base = {
      anchor_event_id: 'ev-1',
      issue_anchor: 'a',
      citations: [{ evidence_id: 'ev-1', quote: 'q' }],
      correction: {
        detected: false,
        confidence: 'low',
        prior_agent_behavior: [],
        agent_behavior_after: [],
        explanation: 'x',
      },
      intervention: {
        detected: false,
        confidence: 'low',
        evidence: [],
        explanation: 'x',
      },
    };
    assert.equal(episodeSubmissionSchema.safeParse(base).success, false);
  });
});

describe('learning_candidates.md frontmatter schema', () => {
  function makeDoc(candidates: ReturnType<typeof makeCandidate>[]) {
    return {
      schema: 'session-correction-analysis/v1',
      session_id: 'thr_123',
      analysis_id: 'an-001',
      analysis_revision: 3,
      revision: 5,
      candidate_count: candidates.length,
      published_count: candidates.filter((c) => c.publication.published).length,
      updated_at: '2026-09-19T16:00:00+08:00',
      candidates,
    };
  }

  it('accepts harness and memory candidates together', () => {
    const doc = makeDoc([
      makeCandidate(),
      makeCandidate({
        id: 'learning-002',
        target: { kind: 'memory', scope: 'project' },
      }),
    ]);
    const parsed = candidatesDocumentSchema.safeParse(doc);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? {}));
  });

  it('keeps a published harness record consistent', () => {
    const published = makeCandidate({
      status: 'published',
      decision: {
        action: 'approve',
        content_hash: HASH_A,
        target_kind: 'harness',
        at: '2026-09-19T15:40:00+08:00',
      },
      publication: {
        published: true,
        result: 'success',
        attempts: [
          {
            publication_id: 'pub-1',
            phase: 'done',
            candidate_hash: HASH_A,
            targets: [
              {
                target_id: 't1',
                display_path: 'AGENTS.md',
                status: 'verified',
                hash_before: HASH_A,
                hash_after_expected: HASH_A,
                hash_after_actual: HASH_A,
              },
            ],
            started_at: '2026-09-19T15:42:00+08:00',
          },
        ],
      },
    });
    assert.equal(candidateSchema.safeParse(published).success, true);
  });

  it('rejects published=true without a successful result', () => {
    assert.equal(
      candidateSchema.safeParse(
        makeCandidate({
          status: 'published',
          publication: { published: true, result: 'failed', attempts: [] },
        }),
      ).success,
      false,
    );
  });

  it('rejects unknown fields inside a candidate', () => {
    const bad = { ...makeCandidate(), sneaky: 1 };
    assert.equal(candidateSchema.safeParse(bad).success, false);
  });
});

describe('pending_commit payload', () => {
  it('round-trips the two-file commit intent', () => {
    const facts = makeAnalyzeDocument().facts;
    const parsed = pendingCommitSchema.safeParse({
      analysis_id: 'an-002',
      input_digest: HASH_A,
      created_at: '2026-09-19T16:10:00+08:00',
      facts,
      candidates: [makeCandidate()],
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? {}));
  });
});
