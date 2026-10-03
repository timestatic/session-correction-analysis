import assert from 'node:assert/strict';
import test from 'node:test';
import { batchSubmissionSchema } from '../../src/batch/schema.js';
import { stableHash } from '../../src/domain/hash.js';

test('batch candidates require cited inspected evidence and reject authority and duplicates', () => {
  const candidate = { kind: 'memory', content: '核对后再改动', evidence_ids: ['e'] };
  const judgment = { target_id: 't', expected_version: 0, reading: 'inspected', judgment: 'positive', classification: 'correction',
    evidence_status: 'sufficient', inspected_evidence_ids: ['e'], unresolved_evidence_ids: [], citations: [{ evidence_id: 'e', quote: 'q' }],
    labels: { correction: true, intervention: false }, candidates: [candidate] };
  const make = (candidates: unknown[]): unknown => ({ schema: 'session-correction-analysis/batch-submission/v2', manifest_hash: stableHash('x'), request_id: 'r', judgments: [{ ...judgment, candidates }] });
  assert.equal(batchSubmissionSchema.safeParse(make([candidate])).success, true);
  assert.equal(batchSubmissionSchema.safeParse(make([{ ...candidate, status: 'approved' }])).success, false);
  assert.equal(batchSubmissionSchema.safeParse(make([{ ...candidate, published: true }])).success, false);
  assert.equal(batchSubmissionSchema.safeParse(make([{ ...candidate, evidence_ids: ['unknown'] }])).success, false);
  assert.equal(batchSubmissionSchema.safeParse(make([{ ...candidate, evidence_ids: ['e', 'e'] }])).success, false);
  assert.equal(batchSubmissionSchema.safeParse(make([candidate, candidate])).success, false);
});
