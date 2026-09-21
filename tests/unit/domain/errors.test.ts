import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ERROR_CODES, ScaError, errorPayloadSchema, type ErrorCode } from '../../../src/domain/errors.js';

describe('error catalog', () => {
  const codes = Object.keys(ERROR_CODES) as ErrorCode[];

  it('gives every code a non-empty message, retryable flag and executable next step', () => {
    for (const code of codes) {
      const spec = ERROR_CODES[code];
      assert.ok(spec.message.length > 0, code);
      assert.equal(typeof spec.retryable, 'boolean', code);
      assert.ok(spec.nextStep.length > 0, code);
    }
  });

  it('covers the frozen degradation codes from design section 27', () => {
    for (const code of [
      'session_locator_unavailable',
      'unsupported_transcript',
      'runner_unavailable',
      'unsupported_operation',
    ] as const) {
      assert.ok(codes.includes(code), `missing ${code}`);
    }
  });

  it('serializes ScaError into the shared error payload schema', () => {
    const payload = new ScaError('target_changed', 'AGENTS.md').toPayload();
    assert.equal(errorPayloadSchema.safeParse(payload).success, true);
    assert.equal(payload.retryable, true);
  });

  it('never embeds free transcript text into catalog defaults', () => {
    for (const code of codes) {
      assert.ok(!ERROR_CODES[code].message.includes('\n'), code);
    }
  });
});
