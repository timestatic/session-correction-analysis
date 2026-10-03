import assert from 'node:assert/strict';
import test from 'node:test';

import { evidencePage } from '../../src/batch/index.js';
import type { BatchManifest } from '../../src/batch/schema.js';
import { sha256Tag, stableHash, stableStringify } from '../../src/domain/hash.js';

test('whole page budget remains bounded across multi-digit source cursor transitions', () => {
  const sources: BatchManifest['sources'] = Array.from({ length: 11 }, (_, index) => ({
    source_id: `s${String(index)}`, input: { path: `/synthetic/${String(index)}`, host: 'codex', session_id: 's',
      created_at: '2026-09-01T00:00:00Z', role: 'direct', role_basis: 'user_declared' },
    source_hash: sha256Tag(''), byte_length: 0, frozen_bytes_base64: '', parser_version: 'test', coverage: 'full',
    parent_status: 'not_declared', excluded_sidechain_records: 0, compacted_records: 0,
    events: [{ evidence_id: `e${String(index)}`, body_hash: sha256Tag(''),
      event: { id: 'u'.repeat(1054), kind: 'assistant_message', ordinal: 0, text: '', source_ref: { hash: sha256Tag('') } } }],
  }));
  const manifest: BatchManifest = { schema: 'session-correction-analysis/batch-manifest/v1', batch_id: 'budget',
    scope: { time_zone: 'UTC', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', time_mode: 'created', inclusion_rule: 'synthetic' },
    sources, targets: [] };
  const unicodeManifest: BatchManifest = { ...manifest, sources: [{ ...sources[0]!,
    events: [{ evidence_id: 'emoji', body_hash: sha256Tag('😀'), event: {
      id: 'u'.repeat(900), kind: 'assistant_message', ordinal: 0, text: '😀', source_ref: { hash: sha256Tag('x') },
    } }] }] };
  let firstFits: number | undefined;
  for (let budget = 2048; budget < 4096; budget += 1) {
    try {
      const page = evidencePage(unicodeManifest, { max_bytes: budget });
      assert.equal(page.items[0]?.text, '😀');
      firstFits = budget; break;
    } catch (error) { assert.ok(error instanceof Error); }
  }
  assert.ok(firstFits !== undefined);
  for (const maxBytes of [2048, 2300, 2600, 3000, 4096]) {
    try {
      const page = evidencePage(manifest, { max_bytes: maxBytes,
        cursor: { manifest_hash: stableHash(manifest), source_index: 9, event_index: 0, text_offset: 0 } });
      assert.ok(Buffer.byteLength(stableStringify(page)) <= maxBytes);
    } catch (error) {
      assert.ok(error instanceof Error && error.message.includes('metadata'));
    }
  }
});
