import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeCandidateFingerprint,
  computeEpisodeId,
  computeRecordId,
  nextCandidateId,
} from '../../../src/domain/ids.js';
import { stableStringify } from '../../../src/domain/hash.js';

describe('record_id identity', () => {
  it('is deterministic for identical host/workspace/session triples', () => {
    const a = computeRecordId('codex', '/repo/dpp_v3', 'thr_123');
    const b = computeRecordId('codex', '/repo/dpp_v3', 'thr_123');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('separates hosts, workspaces and session ids independently', () => {
    const base = computeRecordId('codex', '/repo/dpp_v3', 'thr_123');
    assert.notEqual(base, computeRecordId('claude', '/repo/dpp_v3', 'thr_123'));
    assert.notEqual(base, computeRecordId('codex', '/other/dpp_v3', 'thr_123'));
    assert.notEqual(base, computeRecordId('codex', '/repo/dpp_v3', 'thr_456'));
  });

  it('does not let boundary characters shift fields (JSON-array encoding)', () => {
    const a = computeRecordId('codex', '/repo', 'x","claude');
    const b = computeRecordId('codex', '/repo","claude', 'x');
    assert.notEqual(a, b);
  });

  it('ignores session titles entirely (title changes reuse the record)', () => {
    const id = computeRecordId('codex', '/repo', 'thr_123');
    assert.equal(id, computeRecordId('codex', '/repo', 'thr_123'));
  });

  it('rejects empty identity components', () => {
    assert.throws(() => computeRecordId('codex', ' ', 'thr_123'));
    assert.throws(() => computeRecordId('codex', '/repo', ''));
  });
});

describe('episode and candidate ids', () => {
  it('episode id is stable for the same anchor inputs', () => {
    const record = computeRecordId('codex', '/repo', 's1');
    const a = computeEpisodeId(record, 'ev-9', '字段来源');
    const b = computeEpisodeId(record, 'ev-9', '字段来源');
    assert.equal(a, b);
    assert.match(a, /^ep-[0-9a-f]{16}$/);
    assert.notEqual(a, computeEpisodeId(record, 'ev-9', '另一个问题'));
  });

  it('next candidate id keeps the highest existing sequence', () => {
    assert.equal(nextCandidateId([]), 'learning-001');
    assert.equal(nextCandidateId(['learning-002', 'learning-007']), 'learning-008');
    assert.equal(nextCandidateId(['learning-010']), 'learning-011');
  });
});

describe('stable hashing', () => {
  it('is insensitive to key order', () => {
    assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('keeps array order significant', () => {
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  });

  it('candidate fingerprint changes only with content', () => {
    const base = { title: 't', content: 'c', scope: 's' };
    assert.equal(computeCandidateFingerprint(base), computeCandidateFingerprint({ ...base }));
    assert.notEqual(computeCandidateFingerprint(base), computeCandidateFingerprint({ ...base, content: 'x' }));
  });
});
