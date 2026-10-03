import assert from 'node:assert/strict';
import test from 'node:test';
import { batchSubmissionSchema } from '../../src/batch/schema.js';
import { stableHash } from '../../src/domain/hash.js';

test('v2 supports correction and intervention together while v1 remains strict', () => {
  const judgment = { target_id: 't', expected_version: 0, reading: 'inspected', judgment: 'positive', classification: 'correction',
    evidence_status: 'sufficient', inspected_evidence_ids: ['e'], unresolved_evidence_ids: [], citations: [{ evidence_id: 'e', quote: 'q' }],
    labels: { correction: true, intervention: true } };
  const input = { schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: stableHash('x'), request_id: 'r', judgments: [judgment] };
  assert.equal(batchSubmissionSchema.safeParse(input).success, true);
  assert.equal(batchSubmissionSchema.safeParse({ ...input, schema: 'session-correction-analysis/batch-submission/v1' }).success, false);
  assert.equal(batchSubmissionSchema.safeParse({ ...input, judgments: [{ ...judgment, labels: { correction: false, intervention: true } }] }).success, false);
  assert.equal(batchSubmissionSchema.safeParse({ ...input, judgments: [{ ...judgment, judgment: 'negative', labels: { correction: true, intervention: false } }] }).success, false);
});
