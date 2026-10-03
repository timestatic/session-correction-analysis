import assert from 'node:assert/strict';
import test from 'node:test';

import { checkBudget } from '../../src/batch/budget.js';

const receipt = { agent_id: 'lead', model: 'model', request_id: 'one', mode: 'final', sequence: 1,
  noncached_input_tokens: 80, cache_read_tokens: 200, output_tokens: 10, active_ms: 1000 };
const input = { schema: 'session-correction-analysis/batch-budget-input/v1',
  usage: { schema: 'session-correction-analysis/batch-usage-input/v1', expected_agents: ['lead'], entries: [receipt] },
  limits: { noncached_input_tokens: 100 }, warning_fraction: 0.8 };

test('budget thresholds distinguish warning, exceeded, within and incomplete export', () => {
  assert.equal(checkBudget(input).status, 'warning');
  assert.equal(checkBudget({ ...input, limits: { noncached_input_tokens: 80 } }).status, 'exceeded');
  assert.equal(checkBudget({ ...input, limits: { noncached_input_tokens: 200 } }).status, 'within');
  assert.equal(checkBudget({ ...input, usage: { ...input.usage, expected_agents: ['lead', 'worker'] } }).status, 'indeterminate');
  assert.equal(checkBudget({ ...input, usage: { ...input.usage, expected_agents: ['lead', 'worker'] }, limits: { noncached_input_tokens: 80 } }).status, 'exceeded');
  assert.equal(checkBudget({ ...input, usage: { ...input.usage, entries: [{ ...receipt, mode: 'cumulative' }] } }).status, 'indeterminate');
  assert.equal(checkBudget({ ...input, usage: { ...input.usage, entries: [{ ...receipt, active_ms: undefined }] }, limits: { active_ms: 2000 } }).status, 'indeterminate');
});

test('budget rejects absent limits and unsafe values without mutating input', () => {
  assert.throws(() => checkBudget({ ...input, limits: {} }));
  assert.throws(() => checkBudget({ ...input, limits: { output_tokens: 0 } }));
  assert.throws(() => checkBudget({ ...input, warning_fraction: 0 }));
  const before = JSON.stringify(input);
  checkBudget(input);
  assert.equal(JSON.stringify(input), before);
});
