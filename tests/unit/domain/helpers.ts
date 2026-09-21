import type { Candidate } from '../../../src/domain/candidates.js';
import type { EpisodeCommitted } from '../../../src/domain/episodes.js';

export const HASH_A = `sha256:${'a'.repeat(64)}`;
export const HASH_B = `sha256:${'b'.repeat(64)}`;

export function makeEpisode(overrides?: Partial<EpisodeCommitted>): EpisodeCommitted {
  return {
    id: 'ep-0123456789abcdef',
    run_id: 'run-1',
    recorded_at: '2026-09-19T15:00:00+08:00',
    anchor_event_id: 'ev-1',
    issue_anchor: '字段来源理解错误',
    correction: {
      detected: true,
      confidence: 'high',
      prior_agent_behavior: ['ev-1'],
      agent_behavior_after: ['ev-2'],
      rework: { outcome: 'replaced', evidence: ['ev-2'] },
      explanation: '用户指出字段来源理解错误后，Agent 重写了过滤逻辑。',
    },
    intervention: {
      detected: false,
      confidence: 'uncertain',
      evidence: [],
      explanation: '未观察到执行介入。',
    },
    citations: [{ evidence_id: 'ev-1', quote: '不是这个来源' }],
    ...overrides,
  };
}

export function makeCandidate(overrides?: Partial<Candidate>): Candidate {
  return {
    id: 'learning-001',
    fingerprint: HASH_A,
    category: 'implementation_boundary',
    title: '回调参数字段为空时不得提前过滤',
    confidence: 'high',
    status: 'proposed',
    maturity: 'single_session',
    target: { kind: 'harness', path: 'AGENTS.md', section: 'Callback handling' },
    evidence: ['correction-001'],
    source_episodes: ['ep-0123456789abcdef'],
    proposed_content: '处理回调参数兼容问题时，先核对下游真实参数格式。',
    decision: null,
    decision_history: [],
    publication: { published: false, attempts: [] },
    created_at: '2026-09-19T15:00:00+08:00',
    updated_at: '2026-09-19T15:00:00+08:00',
    ...overrides,
  };
}
