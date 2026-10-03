import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeUsage } from '../../src/batch/usage.js';

const base = { agent_id: 'lead', model: 'model', request_id: 'r1', mode: 'cumulative', sequence: 0,
  noncached_input_tokens: 100, cache_read_tokens: 200, output_tokens: 10, active_ms: 1000 };
function input(entries: unknown[]): unknown {
  return { schema: 'session-correction-analysis/batch-usage-input/v1', expected_agents: ['lead', 'worker'], entries };
}

test('usage counts final once, separates agents and reports missing/provisional costs', () => {
  const report = summarizeUsage(input([base, base, { ...base, sequence: 1, output_tokens: 20 },
    { ...base, mode: 'final', sequence: 2, output_tokens: 30 },
    { ...base, mode: 'final', sequence: 3, output_tokens: 30 },
    { ...base, agent_id: 'worker', active_ms: undefined, output_tokens: 15 },
  ]));
  assert.equal(report.totals.requests, 2);
  assert.equal(report.totals.noncached_input_tokens, 200);
  assert.equal(report.totals.cache_read_tokens, 400);
  assert.equal(report.totals.output_tokens, 45);
  assert.equal(report.totals.active_ms, 1000);
  assert.equal(report.totals.requests_missing_active_ms, 1);
  assert.equal(report.duplicate_entries, 2);
  assert.equal(report.provisional_requests, 1);
  assert.deepEqual(report.missing_agents, []);
  assert.deepEqual(summarizeUsage(input([base])).missing_agents, ['worker']);
});

test('usage rejects conflicting receipts, decreasing streams and undeclared agents', () => {
  assert.throws(() => summarizeUsage(input([base, { ...base, output_tokens: 9 }])));
  assert.throws(() => summarizeUsage(input([base, { ...base, sequence: 1, output_tokens: 9 }])));
  assert.throws(() => summarizeUsage(input([base, { ...base, mode: 'final', sequence: 1, cache_read_tokens: 100 }])));
  assert.throws(() => summarizeUsage(input([{ ...base, mode: 'final' }, { ...base, mode: 'final', sequence: 1, output_tokens: 11 }])));
  assert.throws(() => summarizeUsage(input([{ ...base, agent_id: 'unknown' }])));
});
