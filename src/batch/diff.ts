import { z } from 'zod';

import { stableStringify } from '../domain/hash.js';
import type { BatchManifest, SourceSnapshot } from './schema.js';

export const sourceDifferenceSchema = z.object({
  left_source_id: z.string(),
  right_source_id: z.string(),
  relation: z.enum(['exact_events', 'right_extends', 'left_extends', 'divergent']),
  shared_prefix_events: z.number().int().nonnegative(),
  shared_suffix_events: z.number().int().nonnegative(),
  left_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  right_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  left_target_ids: z.array(z.string()),
  right_target_ids: z.array(z.string()),
  identity_verified: z.literal(false),
  semantic_reuse_authorized: z.literal(false),
}).strict();
export type SourceDifference = z.infer<typeof sourceDifferenceSchema>;

function eventKey(item: SourceSnapshot['events'][number]): string {
  const event = item.event;
  return stableStringify({ id: event.id, kind: event.kind, role: event.role, origin: event.origin,
    turn_id: event.turn_id, call_id: event.call_id, timestamp: event.timestamp, text: event.text });
}

/** Exact normalized events, not fuzzy text matching or source identity authentication. */
export function sourceDifferences(manifest: BatchManifest): SourceDifference[] {
  const differences: SourceDifference[] = [];
  for (const [leftIndex, left] of manifest.sources.entries()) {
    for (const right of manifest.sources.slice(leftIndex + 1)) {
      if (left.input.host !== right.input.host || left.input.session_id !== right.input.session_id) continue;
      const a = left.events.map(eventKey);
      const b = right.events.map(eventKey);
      let prefix = 0;
      while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
      let suffix = 0;
      while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
      const relation = prefix === a.length && prefix === b.length ? 'exact_events'
        : prefix === a.length ? 'right_extends' : prefix === b.length ? 'left_extends' : 'divergent';
      const targetsIn = (source: SourceSnapshot, start: number, end: number): string[] => {
        const ids = new Set(source.events.slice(start, end).map(event => event.evidence_id));
        return manifest.targets.filter(target => target.source_id === source.source_id && ids.has(target.evidence_id)).map(target => target.target_id);
      };
      differences.push({ left_source_id: left.source_id, right_source_id: right.source_id, relation,
        shared_prefix_events: prefix, shared_suffix_events: suffix,
        left_range: [prefix, a.length - suffix], right_range: [prefix, b.length - suffix],
        left_target_ids: targetsIn(left, prefix, a.length - suffix), right_target_ids: targetsIn(right, prefix, b.length - suffix),
        identity_verified: false, semantic_reuse_authorized: false });
    }
  }
  return differences;
}
