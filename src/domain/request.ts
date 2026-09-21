import { z } from 'zod';

import { sha256HashSchema } from './hash.js';
import { isoDateTimeSchema } from './ids.js';

/**
 * Idempotency receipt for a user-triggered mutation (design 26.2/31.5). The
 * ledger is the only place a replayed request id is answered from, so the same
 * shape is shared by the session review log and the root rules registry.
 */
export const requestReceiptSchema = z
  .object({
    request_id: z.string().min(1),
    payload_hash: sha256HashSchema,
    result: z.enum(['applied', 'duplicate', 'stale', 'rejected']),
    at: isoDateTimeSchema,
  })
  .strict();
export type RequestReceipt = z.infer<typeof requestReceiptSchema>;
