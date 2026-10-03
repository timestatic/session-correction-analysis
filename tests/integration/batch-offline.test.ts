import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../../src/cli.js';

const usage = { schema: 'session-correction-analysis/batch-usage-input/v1', expected_agents: ['lead', 'worker'], entries: [
  { agent_id: 'lead', model: 'synthetic', request_id: 'r', mode: 'final', sequence: 1,
    noncached_input_tokens: 100, cache_read_tokens: 200, output_tokens: 10 },
] };

test('offline batch tools return explicit unknown budget without creating any data root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-offline-'));
  try {
    const dataRoot = path.join(root, 'must-not-be-created');
    const file = path.join(root, 'input.json');
    const output: string[] = [];
    const io = { env: {}, stdout: (line: string): void => { output.push(line); }, stderr: (line: string): void => { output.push(line); } };
    await fs.writeFile(file, JSON.stringify(usage));
    assert.equal(await runCli(['batch', '--action', 'usage', '--input', file, '--data-root', dataRoot], io), 0);
    const report: unknown = JSON.parse(output[0] ?? '{}');
    assert.ok(typeof report === 'object' && report !== null && 'missing_agents' in report);
    assert.deepEqual(report.missing_agents, ['worker']);
    await assert.rejects(fs.access(dataRoot));
    await fs.writeFile(file, JSON.stringify({ schema: 'session-correction-analysis/batch-budget-input/v1', usage,
      limits: { noncached_input_tokens: 200 }, warning_fraction: 0.8 }));
    output.length = 0;
    assert.equal(await runCli(['batch', '--action', 'budget', '--input', file, '--data-root', dataRoot], io), 0);
    const budget: unknown = JSON.parse(output[0] ?? '{}');
    assert.ok(typeof budget === 'object' && budget !== null && 'status' in budget);
    assert.equal(budget.status, 'indeterminate');
    await assert.rejects(fs.access(dataRoot));
    await fs.writeFile(file, JSON.stringify({ ...usage, entries: [{ ...usage.entries[0], mode: 'SECRET_API_TOKEN_ENUM' }] }));
    output.length = 0;
    assert.equal(await runCli(['batch', '--action', 'usage', '--input', file, '--data-root', dataRoot], io), 2);
    assert.ok(output.join('').includes('schema_invalid'));
    assert.equal(output.join('').includes('SECRET_API'), false);
    await assert.rejects(fs.access(dataRoot));
    output.length = 0;
    assert.equal(await runCli(['batch', '--action', 'budget', '--input', file], io), 2);
    assert.ok(output.join('').includes('explicit --data-root'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
