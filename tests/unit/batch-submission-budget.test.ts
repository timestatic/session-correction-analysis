import assert from 'node:assert/strict';
import test from 'node:test';

import { batchSubmissionSchema, MAX_BATCH_SUBMISSION_BYTES } from '../../src/batch/schema.js';
import { stableHash, stableStringify } from '../../src/domain/hash.js';

test('batch submission bounds whole UTF-8 JSON exactly, including envelope and citations', () => {
  const make = (quote: string): unknown => ({ schema: 'session-correction-analysis/batch-submission/v1', manifest_hash: stableHash('synthetic'),
    request_id: 'budget', judgments: [{ target_id: 'target', expected_version: 0, reading: 'inspected', judgment: 'positive',
      classification: 'correction', evidence_status: 'sufficient', inspected_evidence_ids: ['evidence'], unresolved_evidence_ids: [],
      citations: [{ evidence_id: 'evidence', quote }] }] });
  const overhead = Buffer.byteLength(stableStringify(make('')));
  const exact = make('x'.repeat(MAX_BATCH_SUBMISSION_BYTES - overhead));
  assert.equal(Buffer.byteLength(stableStringify(exact)), MAX_BATCH_SUBMISSION_BYTES);
  assert.equal(batchSubmissionSchema.safeParse(exact).success, true);
  assert.equal(batchSubmissionSchema.safeParse(make('x'.repeat(MAX_BATCH_SUBMISSION_BYTES - overhead + 1))).success, false);
  assert.equal(batchSubmissionSchema.safeParse(make('😀'.repeat(300_000))).success, false);
});
