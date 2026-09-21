import { sha256Hex } from '../domain/hash.js';
import type { Event } from '../domain/events.js';
import type { EvidenceItem } from '../domain/episodes.js';

/**
 * Deterministic edit-signal extraction and rework correlation (design 23.3).
 * Signals are integrity-bound corroboration material; hints remain advisory.
 * The current workspace is never read.
 */

export interface EditSignal {
  evidence_id: string;
  event_id: string;
  line: number;
  role: 'change' | 'result';
  call_id?: string | undefined;
  paths: string[];
  region_keys: string[];
  success?: boolean | undefined;
}

export interface ReworkHint {
  earlier_evidence_id: string;
  later_evidence_id: string;
  level: 'file' | 'region';
  paths: string[];
}

const MAX_HINTS_PER_PATH = 3;

function shortHash(value: string): string {
  return sha256Hex(value).slice(0, 16);
}

export function extractPaths(text: string): string[] {
  const paths = new Set<string>();
  const patchHeader = /\*\*\*\s+(?:Update|Add|Delete|Rename) File:\s*(.+)/g;
  for (const match of text.matchAll(patchHeader)) {
    const value = match[1]?.trim();
    if (value !== undefined && value.length > 0) {
      paths.add(value);
    }
  }
  const jsonPath = /"(?:path|file_path|abs_path|notebook_path)"\s*:\s*"([^"]+)"/g;
  for (const match of text.matchAll(jsonPath)) {
    const value = match[1]?.trim();
    if (value !== undefined && value.length > 0) {
      paths.add(value);
    }
  }
  return [...paths].sort();
}

function extractRegionKeys(text: string): string[] {
  const changedLines = text
    .split('\n')
    .filter((line) => /^[+-][^+-]/.test(line))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0);
  if (changedLines.length === 0) {
    return [];
  }
  const unique = [...new Set(changedLines)].sort();
  return [shortHash(JSON.stringify(unique))];
}

function classifySuccess(text: string): boolean | undefined {
  if (/(error|failed|failure|denied|not found|rejected)/i.test(text)) {
    return false;
  }
  if (/(completed|succeeded|success|applied|updated|created)/i.test(text)) {
    return true;
  }
  return undefined;
}

/** Evidence and events arrive parallel from the frozen packet (same order). */
export function computeEditSignals(
  evidence: readonly EvidenceItem[],
  events: readonly Event[],
): { signals: EditSignal[]; hints: ReworkHint[] } {
  const signals: EditSignal[] = [];
  for (const [position, event] of events.entries()) {
    const item = evidence[position];
    if (item === undefined) {
      continue;
    }
    if (event.kind === 'file_edit') {
      const text = event.text ?? '';
      signals.push({
        evidence_id: item.id,
        event_id: event.id,
        line: event.source_ref.line ?? 0,
        role: 'change',
        ...(event.call_id !== undefined ? { call_id: event.call_id } : {}),
        paths: extractPaths(text),
        region_keys: extractRegionKeys(text),
      });
    } else if (event.kind === 'tool_result') {
      const text = event.text ?? '';
      signals.push({
        evidence_id: item.id,
        event_id: event.id,
        line: event.source_ref.line ?? 0,
        role: 'result',
        ...(event.call_id !== undefined ? { call_id: event.call_id } : {}),
        paths: extractPaths(text),
        region_keys: [],
        success: classifySuccess(text),
      });
    }
  }

  // A change is a failed modification when its paired result failed (by call id)
  // or when the immediately following result event (same call) reports failure.
  for (const change of signals) {
    if (change.role !== 'change' || change.call_id === undefined) {
      continue;
    }
    const result = signals.find(
      (candidate) => candidate.role === 'result' && candidate.call_id === change.call_id,
    );
    if (result?.success === false) {
      change.success = false;
    } else if (result !== undefined && result.success === true) {
      change.success = true;
    }
  }

  const successfulChanges = signals
    .filter((signal) => signal.role === 'change' && signal.success === true)
    .sort((a, b) => a.line - b.line);
  const hints: ReworkHint[] = [];
  const byPath = new Map<string, EditSignal[]>();
  for (const change of successfulChanges) {
    for (const target of change.paths) {
      const list = byPath.get(target) ?? [];
      list.push(change);
      byPath.set(target, list);
    }
  }
  for (const [target, changes] of byPath) {
    let emitted = 0;
    for (let i = 0; i < changes.length && emitted < MAX_HINTS_PER_PATH; i += 1) {
      for (let j = i + 1; j < changes.length && emitted < MAX_HINTS_PER_PATH; j += 1) {
        const earlier = changes[i] as EditSignal;
        const later = changes[j] as EditSignal;
        const regionOverlap = earlier.region_keys.some((key) => later.region_keys.includes(key));
        hints.push({
          earlier_evidence_id: earlier.evidence_id,
          later_evidence_id: later.evidence_id,
          level: regionOverlap ? 'region' : 'file',
          paths: [target],
        });
        emitted += 1;
      }
    }
  }
  return { signals, hints };
}

export function changeSignalsByEvidence(signals: readonly EditSignal[]): Map<string, EditSignal> {
  return new Map(signals.filter((signal) => signal.role === 'change').map((signal) => [signal.evidence_id, signal]));
}

export function hasAnyChangeSignal(signals: readonly EditSignal[]): boolean {
  return signals.some((signal) => signal.role === 'change');
}
