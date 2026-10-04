import { extractPaths, toolResultSuccess } from '../analysis/rework.js';
import { isNativeIntervention } from '../domain/events.js';
import { ScaError } from '../domain/errors.js';
import type { BatchManifest, Judgment } from './schema.js';

export function validateReworkClaim(manifest: BatchManifest, judgment: Judgment): void {
  const nativeTarget = manifest.targets.find(item => item.target_id === judgment.target_id);
  const nativeSource = manifest.sources.find(item => item.source_id === nativeTarget?.source_id);
  const nativeEvent = nativeSource?.events.find(item => item.evidence_id === nativeTarget?.evidence_id)?.event;
  if (nativeEvent !== undefined && isNativeIntervention(nativeEvent) && judgment.judgment === 'positive' &&
      (judgment.classification !== 'intervention' || ('labels' in judgment && (judgment.labels.correction || !judgment.labels.intervention)))) {
    throw new ScaError('schema_invalid', 'native intervention targets cannot be labeled as textual corrections');
  }
  if (!('rework' in judgment) || judgment.rework === undefined) return;
  const claim = judgment.rework;
  const target = manifest.targets.find(item => item.target_id === judgment.target_id);
  const source = manifest.sources.find(item => item.source_id === target?.source_id);
  const fail = (): never => { throw new ScaError('schema_invalid', 'rework requires unique successful edit/result pairs around feedback in the same source and shared artifact'); };
  if (source === undefined || target === undefined || judgment.judgment !== 'positive') return fail();
  const ids = [claim.earlier_edit, claim.earlier_result, claim.later_edit, claim.later_result];
  if (new Set(ids).size !== 4 || ids.some(id => !judgment.inspected_evidence_ids.includes(id))) return fail();
  const position = (id: string): number => source.events.findIndex(item => item.evidence_id === id);
  const anchor = position(target.evidence_id);
  const [a, ar, b, br] = ids.map(position);
  if (a === undefined || ar === undefined || b === undefined || br === undefined || a < 0 || !(a < ar && ar < anchor && anchor < b && b < br)) return fail();
  const before = source.events[a]; const after = source.events[b];
  if (before === undefined || after === undefined) return fail();
  const pairValid = (editIndex: number, resultIndex: number): boolean => {
    const edit = source.events[editIndex]?.event; const result = source.events[resultIndex]?.event;
    if (edit?.kind !== 'file_edit' || result?.kind !== 'tool_result' || edit.call_id === undefined || edit.call_id !== result.call_id) return false;
    if (source.events.filter(item => item.event.kind === 'file_edit' && item.event.call_id === edit.call_id).length !== 1 || source.events.filter(item => item.event.kind === 'tool_result' && item.event.call_id === edit.call_id).length !== 1) return false;
    return toolResultSuccess(result) === true;
  };
  if (!pairValid(a, ar) || !pairValid(b, br)) return fail();
  const laterPaths = new Set(after.event.edit?.paths ?? extractPaths(after.event.text ?? ''));
  if (!(before.event.edit?.paths ?? extractPaths(before.event.text ?? '')).some(file => laterPaths.has(file))) return fail();
}
