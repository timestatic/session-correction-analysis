import { extractPaths } from '../analysis/rework.js';
import { ScaError } from '../domain/errors.js';
import type { BatchManifest, Judgment } from './schema.js';

export function validateReworkClaim(manifest: BatchManifest, judgment: Judgment): void {
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
    const text = result.text ?? '';
    return !/(error|failed|failure|denied|not found|rejected)/i.test(text) && /(completed|succeeded|success|applied|updated|created)/i.test(text);
  };
  if (!pairValid(a, ar) || !pairValid(b, br)) return fail();
  const laterPaths = new Set(extractPaths(after.event.text ?? ''));
  if (!extractPaths(before.event.text ?? '').some(file => laterPaths.has(file))) return fail();
}
