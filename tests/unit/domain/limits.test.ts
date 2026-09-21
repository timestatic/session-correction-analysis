import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_LEASE_TTL_MS,
  DRAIN_MAX_SESSIONS_PER_RUN,
  FORMAT_SNIFF_LINES,
  HOOK_STDIN_MAX_BYTES,
  HOST_PROBE,
  HTTP_BODY_MAX_BYTES,
  HTTP_REQUEST_TIMEOUT_MS,
  INGEST_MAX_CORRECTIVE_RESUBMISSIONS,
  LOCK_RETRY_COUNT,
  LOCK_RETRY_MAX_MS,
  LOCK_RETRY_MIN_MS,
  LOCK_STALE_MS,
  LOCK_UPDATE_MS,
  PENDING_COMMIT_MAX_BYTES,
  PREPARE_EVENT_MAX_TEXT_CHARS,
  PREPARE_PACKET_MAX_BYTES,
} from '../../../src/domain/limits.js';

describe('frozen contract numbers (T07a, design 30)', () => {
  it('pins the agreed values verbatim', () => {
    assert.equal(PENDING_COMMIT_MAX_BYTES, 262_144);
    assert.equal(DEFAULT_LEASE_TTL_MS, 900_000);
    assert.equal(LOCK_STALE_MS, 30_000);
    assert.equal(LOCK_UPDATE_MS, 5_000);
    assert.deepEqual({ LOCK_RETRY_COUNT, LOCK_RETRY_MIN_MS, LOCK_RETRY_MAX_MS }, {
      LOCK_RETRY_COUNT: 10,
      LOCK_RETRY_MIN_MS: 25,
      LOCK_RETRY_MAX_MS: 250,
    });
    assert.equal(HOOK_STDIN_MAX_BYTES, 65_536);
    assert.equal(FORMAT_SNIFF_LINES, 16);
    assert.equal(PREPARE_PACKET_MAX_BYTES, 196_608);
    assert.equal(PREPARE_EVENT_MAX_TEXT_CHARS, 8_192);
    assert.equal(INGEST_MAX_CORRECTIVE_RESUBMISSIONS, 1);
    assert.equal(DRAIN_MAX_SESSIONS_PER_RUN, 3);
    assert.equal(HTTP_BODY_MAX_BYTES, 262_144);
    assert.equal(HTTP_REQUEST_TIMEOUT_MS, 30_000);
  });

  it('keeps the ordering invariants that make the protocol coherent', () => {
    assert.ok(LOCK_UPDATE_MS < LOCK_STALE_MS, 'heartbeat must refresh before stale takeover');
    assert.ok(LOCK_RETRY_MAX_MS > LOCK_RETRY_MIN_MS);
    assert.ok(DEFAULT_LEASE_TTL_MS > LOCK_STALE_MS, 'a lease outlives a transient lock takeover window');
    assert.ok(
      PREPARE_PACKET_MAX_BYTES < PENDING_COMMIT_MAX_BYTES,
      'a packet must always fit inside the pending commit budget',
    );
    assert.ok(HTTP_BODY_MAX_BYTES === PENDING_COMMIT_MAX_BYTES, 'ingest HTTP body shares the pending budget');
  });

  it('all budget values are positive integers', () => {
    const numbers = [
      PENDING_COMMIT_MAX_BYTES,
      DEFAULT_LEASE_TTL_MS,
      LOCK_STALE_MS,
      LOCK_UPDATE_MS,
      LOCK_RETRY_COUNT,
      LOCK_RETRY_MIN_MS,
      LOCK_RETRY_MAX_MS,
      HOOK_STDIN_MAX_BYTES,
      FORMAT_SNIFF_LINES,
      PREPARE_PACKET_MAX_BYTES,
      PREPARE_EVENT_MAX_TEXT_CHARS,
      INGEST_MAX_CORRECTIVE_RESUBMISSIONS,
      DRAIN_MAX_SESSIONS_PER_RUN,
      HTTP_BODY_MAX_BYTES,
      HTTP_REQUEST_TIMEOUT_MS,
    ];
    for (const n of numbers) {
      assert.ok(Number.isInteger(n) && n > 0, `${String(n)} must be a positive integer`);
    }
  });

  it('HOST_PROBE stays in sync with the compat matrix document', async () => {
    const doc = await fs.readFile(
      path.join(import.meta.dirname, '../../../..', 'packaging', 'compat-matrix.md'),
      'utf8',
    );
    assert.ok(doc.includes(HOST_PROBE.codex.version), 'codex version must appear in compat-matrix.md');
    assert.ok(doc.includes(HOST_PROBE.claude.version), 'claude version must appear in compat-matrix.md');
    assert.ok(doc.includes(HOST_PROBE.codex.package));
    assert.ok(doc.includes(HOST_PROBE.claude.package));
  });
});
