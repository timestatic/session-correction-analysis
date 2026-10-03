import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceDifferences } from '../../src/batch/diff.js';
import type { BatchManifest, SourceSnapshot } from '../../src/batch/schema.js';
import { sha256Tag } from '../../src/domain/hash.js';

function source(id: string, texts: string[], session = 'same'): SourceSnapshot {
  return { source_id: id, input: { path: `/synthetic/${id}`, host: 'codex', session_id: session,
    created_at: '2026-09-01T00:00:00Z', role: 'direct', role_basis: 'user_declared' },
    source_hash: sha256Tag(''), byte_length: 0, frozen_bytes_base64: '', parser_version: 'test', coverage: 'full',
    parent_status: 'not_declared', excluded_sidechain_records: 0, compacted_records: 0,
    events: texts.map((text, index) => ({ evidence_id: `${id}-${String(index)}`, body_hash: sha256Tag(text),
      event: { id: `event-${String(index)}`, kind: 'user_message', ordinal: index, text, source_ref: { hash: sha256Tag(text) } } })),
  };
}
function manifest(sources: SourceSnapshot[]): BatchManifest {
  return { schema: 'session-correction-analysis/batch-manifest/v1', batch_id: 'diff',
    scope: { time_zone: 'UTC', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'synthetic' }, sources,
    targets: sources.flatMap(item => item.events.map(event => ({ target_id: `target-${event.evidence_id}`, source_id: item.source_id, evidence_id: event.evidence_id }))),
  };
}

test('source differences retain suffix, distinguish negation and identify append-only event growth', () => {
  const diff = sourceDifferences(manifest([source('a', ['start', '修改', 'end']), source('b', ['start', '不修改', 'end'])]))[0];
  assert.equal(diff?.shared_prefix_events, 1);
  assert.equal(diff?.shared_suffix_events, 1);
  assert.deepEqual(diff?.left_range, [1, 2]);
  assert.deepEqual(diff?.right_target_ids, ['target-b-1']);
  assert.equal(sourceDifferences(manifest([source('a', ['start']), source('b', ['start', 'more'])]))[0]?.relation, 'right_extends');
  assert.equal(sourceDifferences(manifest([source('a', ['start', 'more']), source('b', ['start'])]))[0]?.relation, 'left_extends');
  assert.equal(sourceDifferences(manifest([source('a', []), source('b', [])]))[0]?.relation, 'exact_events');
  assert.equal(sourceDifferences(manifest([source('a', ['same']), source('b', ['same'], 'other')])).length, 0);
});
