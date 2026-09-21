import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ScaError } from '../../../src/domain/errors.js';
import { episodeCommittedSchema, type EpisodeCommitted } from '../../../src/domain/episodes.js';
import { computeEpisodeId } from '../../../src/domain/ids.js';
import {
  INVALID_TABLE_SCENARIOS,
  SCORER_SCENARIOS,
  gSession,
  gUnit,
  pAnalysis,
  pPrediction,
  runScorerMatrix,
} from '../../../src/eval/offline.js';
import {
  predictionsFromEpisodes,
  scoreEval,
  sessionEpisodeCounts,
  wilsonInterval,
  type ScoredSessionInput,
} from '../../../src/eval/scorer.js';

function committed(
  correction: { detected: boolean; confidence: 'high' | 'medium' | 'low'; rework?: { outcome: string; evidence: string[] } },
  intervention: { detected: boolean; confidence: 'high' | 'medium' | 'low' },
  anchor = 'ev-user-1',
  issueAnchor = '对照范围错了',
): EpisodeCommitted {
  return episodeCommittedSchema.parse({
    id: computeEpisodeId('rec-eval', anchor, issueAnchor),
    anchor_event_id: anchor,
    issue_anchor: issueAnchor,
    correction: {
      detected: correction.detected,
      subtype: 'wrong_scope',
      confidence: correction.confidence,
      prior_agent_behavior: [],
      agent_behavior_after: [],
      explanation: '固定输出。',
      ...(correction.rework !== undefined ? { rework: correction.rework } : {}),
    },
    intervention: { detected: intervention.detected, confidence: intervention.confidence, evidence: [], explanation: '固定输出。' },
    citations: [{ evidence_id: anchor, quote: '固定' }],
    run_id: 'run-eval',
    recorded_at: '2026-09-20T00:00:00.000Z',
  });
}

describe('predictions from committed episodes (design 29.1)', () => {
  it('splits formal high/medium labels from low-confidence awaiting-review labels', () => {
    const [formal, review] = predictionsFromEpisodes([
      committed({ detected: true, confidence: 'high', rework: { outcome: 'fixed', evidence: ['ev-tool-1'] } }, { detected: false, confidence: 'high' }),
      committed({ detected: false, confidence: 'high' }, { detected: true, confidence: 'low' }),
    ]);
    assert.ok(formal && review);
    assert.deepEqual(formal.labels, ['correction']);
    assert.deepEqual(formal.review_labels, []);
    assert.equal(formal.rework_claimed, true);
    assert.equal(formal.anchor_evidence_id, 'ev-user-1');
    assert.deepEqual(review.labels, []);
    assert.deepEqual(review.review_labels, ['intervention']);
    // an episode asserting nothing cannot be committed at all (schema-level guarantee)
    assert.throws(() => committed({ detected: false, confidence: 'high' }, { detected: false, confidence: 'high' }), /at least one label/);
  });
});

describe('session run-report counts (design 29.2)', () => {
  it('counts deduped episodes, not messages, and reports the label intersection', () => {
    const counts = sessionEpisodeCounts([
      committed({ detected: true, confidence: 'high', rework: { outcome: 'fixed', evidence: ['ev-t'] } }, { detected: false, confidence: 'high' }, 'ev-user-1', '问题一'),
      committed({ detected: false, confidence: 'high' }, { detected: true, confidence: 'medium' }, 'ev-user-2', '问题二'),
      committed({ detected: true, confidence: 'medium' }, { detected: true, confidence: 'high' }, 'ev-user-3', '问题三'),
      committed({ detected: true, confidence: 'low' }, { detected: false, confidence: 'high' }, 'ev-user-4', '低置信待复核'),
    ]);
    assert.equal(counts.corrections, 2);
    assert.equal(counts.interventions, 2);
    assert.equal(counts.union, 3);
    assert.equal(counts.both, 1);
    assert.equal(counts.reworked, 1);
  });
});

describe('wilson interval', () => {
  it('matches hand-computed 95% boundaries and stays null on empty denominators', () => {
    const one = wilsonInterval(1, 1);
    assert.ok(one);
    assert.ok(Math.abs(one[0] - 0.2065) < 0.001);
    assert.equal(one[1], 1);
    const half = wilsonInterval(5, 10);
    assert.ok(half);
    assert.ok(Math.abs(half[0] - 0.2366) < 0.001);
    assert.ok(Math.abs(half[1] - 0.7634) < 0.001);
    assert.equal(wilsonInterval(0, 0), null);
  });
});

describe('scoreEval edges', () => {
  it('reports N/A (never 100%) when every denominator is zero', () => {
    const report = scoreEval([], []);
    assert.equal(report.micro.correction.precision, null);
    assert.equal(report.micro.correction.recall, null);
    assert.equal(report.micro.correction.f1, null);
    assert.equal(report.abstention.rate, null);
  });

  it('micro sums across sessions while per-session detail is preserved', () => {
    const session = (id: string): ScoredSessionInput => ({
      session_id: id,
      gold: gSession(id, { units: [gUnit('u2')] }),
      analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]),
    });
    const report = scoreEval([session('s-a'), session('s-b')], []);
    assert.equal(report.micro.correction.tp, 0);
    assert.equal(report.micro.correction.fp, 2);
    assert.equal(report.per_session.length, 2);
    assert.equal(report.per_session[0]?.session_id, 's-a');
    assert.equal(report.per_session[1]?.fp_details.length, 1);
  });

  it('rejects a match table entry that fabricates a cross-session link', () => {
    const sessions = [
      { session_id: 's-a', gold: gSession('s-a', { units: [] }), analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]) },
      { session_id: 's-b', gold: gSession('s-b', { units: [] }), analysis: pAnalysis([pPrediction('ep2', ['correction'], 'u2')]) },
    ];
    assert.throws(
      () => scoreEval(sessions, [{ session_id: 's-b', prediction_id: 'ep1', gold_id: 'g1', label: 'correction' }]),
      (error: unknown) => error instanceof ScaError && /unknown prediction/.test(error.message),
    );
  });
});

describe('offline scenario matrix (plan 2.3 fixtures)', () => {
  it('passes every valid scoring scenario', () => {
    const { results } = runScorerMatrix();
    const failed = results.filter((result) => !result.ok);
    assert.deepEqual(
      failed.map((f) => `${f.name}: ${f.message ?? ''}`),
      [],
    );
    assert.equal(results.length, SCORER_SCENARIOS.length + INVALID_TABLE_SCENARIOS.length);
  });

  it('covers the mandated fixture cases of plan 2.3', () => {
    const names = new Set([...SCORER_SCENARIOS.map((s) => s.name), ...INVALID_TABLE_SCENARIOS.map((s) => s.name)]);
    for (const required of [
      'one_to_one_clean',
      'duplicate_prediction_counts_fp',
      'missed_gold_counts_fn',
      'same_episode_double_label',
      'abstention_and_unarbited_excluded',
      'coverage_gap_not_abstention',
      'failed_analysis_all_gold_fn',
      'partial_coverage_still_scored_and_flagged',
      'rework_hit_false_claim_miss_and_unknown',
      'exclusions_and_missing_gold',
      'table_prediction_from_other_session',
      'table_anchor_mismatch',
      'table_breaks_one_to_one',
      'table_awaiting_review_prediction',
    ]) {
      assert.ok(names.has(required), `missing fixture scenario ${required}`);
    }
  });
});
