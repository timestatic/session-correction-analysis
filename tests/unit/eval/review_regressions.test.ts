import assert from 'node:assert/strict';
import { it } from 'node:test';
import { gSession, gUnit, gEpisode, pAnalysis, pPrediction } from '../../../src/eval/offline.js';
import { scoreEval } from '../../../src/eval/scorer.js';

it('measures model abstention independently from excluded uncertain gold and missing receipts', () => {
  const gold = gSession('s', { units: [gUnit('u1'), gUnit('u2'), gUnit('u3', 'uncertain')],
    episodes: [gEpisode('g3', ['correction'], 'u3')] });
  const run = (status: 'reviewed' | 'uncertain') => scoreEval([{ session_id: 's', gold,
    analysis: pAnalysis([pPrediction('p3', ['correction'], 'u3')], { processed_users: [
      { evidence_id: 'u1', status }, { evidence_id: 'u3', status: 'uncertain' },
    ] }),
  }], []);
  const clear = run('reviewed');
  const abstained = run('uncertain');
  assert.equal(clear.abstention.rate, 0);
  assert.equal(abstained.abstention.rate, 0.5);
  assert.equal(abstained.abstention.arbitrated_units, 2);
  assert.equal(abstained.gold_excluded_units, 1);
  assert.equal(abstained.coverage_gap_units, 1);
  assert.equal(abstained.micro.correction.fp, 0);
  assert.equal(abstained.micro.correction.fn, 0);
});

it('does not infer processing or abstention from positive predictions', () => {
  const report = scoreEval([{ session_id: 's', gold: gSession('s', { units: [gUnit('u1')] }),
    analysis: pAnalysis([pPrediction('p1', [], 'u1', { review: ['correction'] })]),
  }], []);
  assert.equal(report.abstention.uncertain_units, 0);
  assert.equal(report.coverage_gap_units, 1);
});

it('rejects unknown and duplicate processing receipts', () => {
  for (const ids of [['unknown'], ['u1', 'u1']]) {
    assert.throws(() => scoreEval([{ session_id: 's', gold: gSession('s', { units: [gUnit('u1')] }),
      analysis: pAnalysis([], { processed_users: ids.map((evidence_id) => ({ evidence_id, status: 'reviewed' })) }),
    }], []), /processed_users/);
  }
});
