import { z } from 'zod';

import { stableHash } from '../domain/hash.js';
import { loadBatch, readLedger } from './index.js';
import { validateLedger, validateManifest } from './integrity.js';
import type { BatchManifest, BatchLedger, Judgment } from './schema.js';

export const auditOptionsSchema = z.object({
  seed: z.string().min(1), negative_fraction: z.number().min(0.2).max(1),
}).strict();
export interface AuditPlan {
  schema: string; manifest_hash: string; ledger_revision: number;
  seed: string; negative_fraction: number;
  pending_target_ids: string[];
  totals: { positive: number; uncertain: number; negative: number; sampled_negative: number };
  items: { target_id: string; evidence_id: string; version: number; judgment_hash: string;
    reason: 'positive' | 'uncertain' | 'sampled_negative'; review_status: 'unreviewed' }[];
  warning: string;
}

/** Hash-ranked sampling is deterministic across input iteration order, without inferring reviewer labels. */
export function planAudit(manifestInput: BatchManifest, ledgerInput: BatchLedger, optionsInput: unknown): AuditPlan {
  const manifest = validateManifest(manifestInput);
  const ledger = validateLedger(ledgerInput, manifest);
  const options = auditOptionsSchema.parse(optionsInput);
  const current = new Map<string, { judgment: Judgment; version: number }>();
  for (const transaction of ledger.history) for (const judgment of transaction.judgments) {
    current.set(judgment.target_id, { judgment, version: (current.get(judgment.target_id)?.version ?? 0) + 1 });
  }
  const positive = manifest.targets.filter(target => current.get(target.target_id)?.judgment.judgment === 'positive');
  const uncertain = manifest.targets.filter(target => current.get(target.target_id)?.judgment.judgment === 'uncertain');
  const negative = manifest.targets.filter(target => current.get(target.target_id)?.judgment.judgment === 'negative');
  const ranked = negative.map(target => ({ target, rank: stableHash([options.seed, target.target_id]) }))
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.target.target_id.localeCompare(b.target.target_id));
  const sampled = ranked.slice(0, Math.ceil(negative.length * options.negative_fraction)).map(item => item.target);
  const items: AuditPlan['items'] = [];
  for (const [targets, reason] of [[positive, 'positive'], [uncertain, 'uncertain'], [sampled, 'sampled_negative']] as const) {
    for (const target of targets) {
      const entry = current.get(target.target_id);
      if (entry === undefined) continue;
      items.push({ target_id: target.target_id, evidence_id: target.evidence_id, version: entry.version,
        judgment_hash: stableHash(entry.judgment), reason, review_status: 'unreviewed' });
    }
  }
  return { schema: 'session-correction-analysis/batch-audit-plan/v1', manifest_hash: stableHash(manifest),
    ledger_revision: ledger.revision, seed: options.seed, negative_fraction: options.negative_fraction,
    pending_target_ids: manifest.targets.filter(target => !current.has(target.target_id)).map(target => target.target_id),
    totals: { positive: positive.length, uncertain: uncertain.length, negative: negative.length, sampled_negative: sampled.length },
    items, warning: 'Unlabeled independent-review worklist only; not human gold or approval. Review all selected items. A discovered miss requires expanding the affected class; unchanged seed is not evidence of quality. Version changes invalidate corresponding review evidence.' };
}

export async function batchAuditPlan(root: string, id: string, options: unknown): Promise<AuditPlan> {
  const manifest = await loadBatch(root, id);
  return planAudit(manifest, await readLedger(root, manifest), options);
}
