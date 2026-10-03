import { sourceDifferences } from './diff.js';
import { validateManifest } from './integrity.js';
import type { BatchManifest } from './schema.js';

export interface IdentityIssue {
  source_ids: string[];
  reason: 'unknown_actor' | 'unverified_actor_basis' | 'unverified_parent' | 'partial_source' | 'same_session_divergence' | 'same_session_actor_conflict';
  target_count: number;
  identity_verified: false;
  semantic_reuse_authorized: false;
}
export interface IdentityInventory {
  schema: string; sources: number; affected_sources: number; affected_targets: number;
  issues: IdentityIssue[]; warning: string;
}
export function identityInventory(input: BatchManifest): IdentityInventory {
  const manifest = validateManifest(input);
  const issues: IdentityIssue[] = [];
  const add = (ids: string[], reason: IdentityIssue['reason']): void => {
    issues.push({ source_ids: ids, reason,
      target_count: manifest.targets.filter(target => ids.includes(target.source_id)).length,
      identity_verified: false, semantic_reuse_authorized: false });
  };
  for (const source of manifest.sources) {
    if (source.input.role === 'unknown') add([source.source_id], 'unknown_actor');
    if (source.input.role_basis === 'unavailable') add([source.source_id], 'unverified_actor_basis');
    if (source.parent_status === 'unverified') add([source.source_id], 'unverified_parent');
    if (source.coverage === 'partial') add([source.source_id], 'partial_source');
  }
  for (const difference of sourceDifferences(manifest)) {
    const ids = [difference.left_source_id, difference.right_source_id];
    if (difference.relation === 'divergent') add(ids, 'same_session_divergence');
    const left = manifest.sources.find(source => source.source_id === difference.left_source_id);
    const right = manifest.sources.find(source => source.source_id === difference.right_source_id);
    if (left !== undefined && right !== undefined && left.input.role !== right.input.role) add(ids, 'same_session_actor_conflict');
  }
  const affected = new Set(issues.flatMap(issue => issue.source_ids));
  return { schema: 'session-correction-analysis/batch-identity-inventory/v1', sources: manifest.sources.length,
    affected_sources: affected.size, affected_targets: manifest.targets.filter(target => affected.has(target.source_id)).length,
    issues, warning: 'Advisory unresolved identity inventory, not authentication. Native metadata and user declarations do not authorize semantic reuse. Keep source targets separate; no automatic identity merge or review decision.' };
}
