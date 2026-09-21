import type { PreparePacket } from '../analysis/prepare.js';

import { ScaError } from '../domain/errors.js';
import { GOLD_SCHEMA, goldSessionSchema, type EvalSplit, type GoldSession, type GoldUserUnit } from './gold.js';

/**
 * Annotation worksheet generator (plan 2.2): turns a frozen prepare packet
 * into an unlabeled gold draft so human annotators see exactly the evidence ids
 * the model will be allowed to cite. Everything stays in the local evaluation
 * data root — transcripts excerpts included — and the draft is never scored
 * until a human sets labeled=true with arbitrated units and gold episodes.
 */
export function buildWorksheet(packet: PreparePacket, split: EvalSplit): GoldSession {
  const evidenceById = new Map(packet.evidence.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const units: GoldUserUnit[] = [];
  for (const entry of packet.user_coverage) {
    if (seen.has(entry.evidence_id)) {
      throw new ScaError('schema_invalid', `worksheet: duplicate user coverage evidence id ${entry.evidence_id}`);
    }
    seen.add(entry.evidence_id);
    const item = evidenceById.get(entry.evidence_id);
    if (item === undefined) {
      throw new ScaError('schema_invalid', `worksheet: coverage entry references unknown evidence ${entry.evidence_id}`);
    }
    units.push({
      evidence_id: entry.evidence_id,
      event_id: entry.event_id,
      status: 'unarbited',
      line: item.source_ref.line ?? 0,
      excerpt: item.excerpt,
    });
  }
  return goldSessionSchema.parse({
    schema: GOLD_SCHEMA,
    session_id: packet.record_id,
    host: packet.snapshot.host,
    source_fingerprint: packet.snapshot.source_fingerprint,
    parser_version: packet.snapshot.parser_version,
    rule_version: packet.rule_version,
    split,
    labeled: false,
    all_user_evidence_ids: units.map((unit) => unit.evidence_id),
    units,
    episodes: [],
  });
}

/** Refuse to score a file that is still a draft; annotated gold must say so itself. */
export function assertLabeledForScoring(gold: GoldSession): void {
  if (!gold.labeled) {
    throw new ScaError('schema_invalid', 'gold worksheet is still unlabeled; human annotation must complete first');
  }
}
