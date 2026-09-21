import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CandidateStatus } from '../../../src/domain/candidates.js';
import { makeCandidate, makeEpisode } from './helpers.js';
import {
  allowedActions,
  allowedTransitions,
  canTransition,
  hasReworkEvidence,
  isEffective,
  isFormalCorrection,
  isFormalIntervention,
} from '../../../src/domain/states.js';

describe('candidate status machine', () => {
  it('follows the single review workflow', () => {
    assert.deepEqual(allowedTransitions('proposed'), ['approved', 'rejected', 'superseded']);
    assert.equal(canTransition('proposed', 'published'), false);
    assert.equal(canTransition('approved', 'published'), false);
    assert.equal(canTransition('publish_failed', 'published'), false);
    assert.equal(canTransition('published', 'proposed'), false);
    assert.deepEqual(allowedTransitions('superseded'), []);
  });

  it('revocation and content edit return to proposed via transition table', () => {
    assert.equal(canTransition('approved', 'proposed'), true);
    assert.equal(canTransition('rejected', 'proposed'), true);
  });

  it('every status is covered by the table', () => {
    const all: CandidateStatus[] = [
      'proposed',
      'approved',
      'published',
      'rejected',
      'publish_failed',
      'superseded',
    ];
    for (const status of all) {
      assert.ok(Array.isArray(allowedTransitions(status)));
    }
  });
});

describe('allowed actions by target kind', () => {
  it('memory approved candidates get content output, never publish', () => {
    const memory = makeCandidate({
      status: 'approved',
      target: { kind: 'memory', scope: 'project' },
    });
    const actions = allowedActions(memory);
    assert.ok(actions.includes('copy_content'));
    assert.ok(actions.includes('export_content'));
  });

  it('harness approved candidates can copy and export text', () => {
    const harness = makeCandidate({ status: 'approved' });
    assert.ok(allowedActions(harness).includes('copy_content'));
    assert.ok(allowedActions(harness).includes('export_content'));
  });

  it('unapproved candidates cannot export', () => {
    assert.ok(!allowedActions(makeCandidate({ status: 'rejected' })).includes('approve'));
    assert.ok(!allowedActions(makeCandidate({ status: 'proposed' })).includes('copy_content'));
  });
});

describe('effectiveness and formal labels (design 29)', () => {
  it('counts approved and publish_failed as effective, not proposed or rejected', () => {
    assert.equal(isEffective(makeCandidate({ status: 'proposed' })), false);
    assert.equal(isEffective(makeCandidate({ status: 'approved' })), true);
    assert.equal(isEffective(makeCandidate({ status: 'publish_failed' })), true);
    assert.equal(isEffective(makeCandidate({ status: 'rejected' })), false);
    assert.equal(isEffective(makeCandidate({ status: 'superseded' })), false);
  });

  it('low/uncertain labels stay out of the formal detection set', () => {
    assert.equal(isFormalCorrection(makeEpisode()), true);
    assert.equal(
      isFormalCorrection(
        makeEpisode({
          correction: {
            detected: true,
            confidence: 'uncertain',
            prior_agent_behavior: [],
            agent_behavior_after: [],
            explanation: '证据不足',
          },
        }),
      ),
      false,
    );
    assert.equal(
      isFormalIntervention(
        makeEpisode({
          intervention: {
            detected: true,
            kind: 'interrupt_turn',
            confidence: 'medium',
            evidence: ['ev-3'],
            explanation: '用户打断了执行',
          },
        }),
      ),
      true,
    );
  });

  it('rework requires a concrete outcome with evidence', () => {
    assert.equal(hasReworkEvidence(makeEpisode()), true);
    assert.equal(
      hasReworkEvidence(
        makeEpisode({
          correction: {
            detected: true,
            confidence: 'high',
            prior_agent_behavior: [],
            agent_behavior_after: [],
            rework: { outcome: 'unknown', evidence: [] },
            explanation: '会话在反馈后结束',
          },
        }),
      ),
      false,
    );
  });
});
