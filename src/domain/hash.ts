import { createHash } from 'node:crypto';

import { z } from 'zod';

export const sha256HashSchema: z.ZodString = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 lowercase hex>');

export type Sha256Hash = string;

export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function sha256Tag(payload: string): Sha256Hash {
  return `sha256:${sha256Hex(payload)}`;
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item));
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries) {
    out[key] = canonical(v);
  }
  return out;
}

export function stableStringify(value: unknown): string {
  const c = canonical(value);
  return JSON.stringify(c === undefined ? null : c);
}

export function stableHash(value: unknown): Sha256Hash {
  return sha256Tag(stableStringify(value));
}
