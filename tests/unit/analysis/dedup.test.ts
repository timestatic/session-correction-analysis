import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MERGE_SUGGESTION_THRESHOLD, suggestMerges } from '../../../src/analysis/dedup.js';
import { candidateSchema, type Candidate } from '../../../src/domain/candidates.js';

function mkCandidate(id: string, category: string, title: string, proposedContent: string): Candidate {
  const now = new Date().toISOString();
  return candidateSchema.parse({
    id,
    fingerprint: `sha256:${'0'.repeat(64)}`,
    category,
    title,
    confidence: 'high',
    status: 'proposed',
    maturity: 'single_session',
    target: { kind: 'harness' },
    evidence: ['ev-aaaa'],
    source_episodes: ['ep-bbbb'],
    proposed_content: proposedContent,
    created_at: now,
    updated_at: now,
  });
}

describe('candidate merge suggestions (design 23.3)', () => {
  it('suggests latin near-duplicates within the same category', () => {
    const suggestions = suggestMerges([
      mkCandidate(
        'learning-001',
        'process',
        'Read design doc first',
        'Always read the design document before changing the schema to keep migrations consistent',
      ),
      mkCandidate(
        'learning-002',
        'process',
        'Design doc before schema work',
        'Always read the design document before changing a schema so migrations stay consistent',
      ),
    ]);
    assert.equal(suggestions.length, 1);
    assert.deepEqual(suggestions[0]?.candidate_ids, ['learning-001', 'learning-002']);
    assert.ok((suggestions[0]?.similarity ?? 0) >= MERGE_SUGGESTION_THRESHOLD);
  });

  it('suggests CJK near-duplicates via character bigrams', () => {
    const suggestions = suggestMerges([
      mkCandidate(
        'learning-001',
        '流程',
        '提交前先跑测试',
        '在提交任何代码修改之前，必须先运行相关单元测试并确认通过，再交付结果。',
      ),
      mkCandidate(
        'learning-002',
        '流程',
        '修改代码后先测试',
        '在提交任何代码修改之前，必须先运行相关的单元测试并确认通过后再交付。',
      ),
    ]);
    assert.equal(suggestions.length, 1);
    assert.ok((suggestions[0]?.similarity ?? 0) >= MERGE_SUGGESTION_THRESHOLD);
  });

  it('never pairs across categories or weakly related content', () => {
    const candidates = [
      mkCandidate('learning-001', 'process', 'Run tests', 'Always run the unit tests before delivering any change'),
      mkCandidate('learning-002', 'style', 'Run tests', 'Always run the unit tests before delivering any change'),
      mkCandidate('learning-003', 'tooling', 'Use pnpm', 'Install dependencies exclusively with pnpm, never npm'),
    ];
    const sameContentAcrossCategories = suggestMerges([candidates[0] as Candidate, candidates[1] as Candidate]);
    assert.equal(sameContentAcrossCategories.length, 0);
    const unrelated = suggestMerges([candidates[0] as Candidate, candidates[2] as Candidate]);
    assert.equal(unrelated.length, 0);
  });

  it('is a pure read-time helper: it never mutates candidates or merges them', () => {
    const left = mkCandidate('learning-001', 'process', 'A title', 'alpha beta gamma delta epsilon zeta');
    const right = mkCandidate('learning-002', 'process', 'A title', 'alpha beta gamma delta epsilon zeta');
    const frozen = JSON.parse(JSON.stringify([left, right])) as unknown;
    const suggestions = suggestMerges([left, right]);
    assert.equal(suggestions.length, 1);
    assert.equal(left.status, 'proposed');
    assert.equal(right.status, 'proposed');
    assert.deepEqual(JSON.parse(JSON.stringify([left, right])), frozen);
  });
});
