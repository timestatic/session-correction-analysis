import { extractPaths, toolResultSuccess } from '../analysis/rework.js';
import { validateManifest } from './integrity.js';
import type { BatchManifest } from './schema.js';

export interface ReworkEvidencePair {
  target_id: string; source_id: string;
  earlier_edit: string; earlier_result: string; later_edit: string; later_result: string;
  shared_paths: string[]; semantic_verified: false;
}
export function reworkEvidencePairs(input: BatchManifest): ReworkEvidencePair[] {
  const manifest = validateManifest(input);
  const pairs: ReworkEvidencePair[] = [];
  for (const source of manifest.sources) {
    const edits = new Map<string, number>();
    const results = new Map<string, { result: typeof source.events[number]; position: number }[]>();
    const positions = new Map<string, number>();
    for (const [position, item] of source.events.entries()) {
      positions.set(item.evidence_id, position);
      const call = item.event.call_id;
      if (call === undefined) continue;
      if (item.event.kind === 'file_edit') edits.set(call, (edits.get(call) ?? 0) + 1);
      if (item.event.kind === 'tool_result') {
        const entries = results.get(call) ?? [];
        entries.push({ result: item, position }); results.set(call, entries);
      }
    }
    const successful = source.events.flatMap((item, index) => {
      if (item.event.kind !== 'file_edit' || item.event.call_id === undefined) return [];
      if (edits.get(item.event.call_id) !== 1) return [];
      const paired = results.get(item.event.call_id);
      if (paired?.length !== 1) return [];
      const result = paired[0];
      if (result === undefined || result.position <= index) return [];
      if (toolResultSuccess(result.result.event) !== true) return [];
      return [{ item, index, result, paths: item.event.edit?.paths ?? extractPaths(item.event.text ?? '') }];
    });
    for (const target of manifest.targets.filter(target => target.source_id === source.source_id)) {
      const anchor = positions.get(target.evidence_id);
      if (anchor === undefined) continue;
      const before = successful.filter(edit => edit.result.position < anchor);
      const after = successful.filter(edit => edit.index > anchor);
      for (const earlier of before) for (const later of after) {
        const shared = earlier.paths.filter(file => later.paths.includes(file));
        if (shared.length === 0) continue;
        pairs.push({ target_id: target.target_id, source_id: source.source_id,
          earlier_edit: earlier.item.evidence_id, earlier_result: earlier.result.result.evidence_id,
          later_edit: later.item.evidence_id, later_result: later.result.result.evidence_id,
          shared_paths: shared, semantic_verified: false });
      }
    }
  }
  return pairs;
}
