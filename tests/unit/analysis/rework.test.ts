import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  changeSignalsByEvidence,
  computeEditSignals,
  extractPaths,
  hasAnyChangeSignal,
} from '../../../src/analysis/rework.js';
import type { EvidenceItem, EvidenceKind } from '../../../src/domain/episodes.js';
import type { Event, EventKind } from '../../../src/domain/events.js';
import { sha256Tag } from '../../../src/domain/hash.js';

function mkEvent(id: string, kind: EventKind, ordinal: number, line: number, text: string, callId?: string): Event {
  return {
    id,
    kind,
    ordinal,
    ...(callId !== undefined ? { call_id: callId } : {}),
    text,
    source_ref: { line, hash: sha256Tag(`raw-${id}`) },
  };
}

interface EditSpec {
  id: string;
  line: number;
  text: string;
  callId: string;
  result?: string;
  resultLine?: number;
}

/** Patch events (optionally followed by their result) plus parallel evidence. */
function buildEdits(specs: readonly EditSpec[]): { events: Event[]; evidence: EvidenceItem[] } {
  const events: Event[] = [];
  const evidence: EvidenceItem[] = [];
  let ordinal = 0;
  function push(kind: EventKind, id: string, line: number, text: string, callId: string): void {
    events.push(mkEvent(id, kind, ordinal, line, text, callId));
    const itemKind: EvidenceKind = kind === 'file_edit' ? 'file_edit' : 'tool_result';
    evidence.push({
      id: `ev-${id}`,
      kind: itemKind,
      excerpt: text,
      source_ref: { line, hash: sha256Tag(`raw-${id}`) },
      truncated: false,
    });
    ordinal += 1;
  }
  for (const spec of specs) {
    push('file_edit', spec.id, spec.line, spec.text, spec.callId);
    if (spec.result !== undefined) {
      push('tool_result', `${spec.id}-out`, spec.resultLine ?? spec.line + 1, spec.result, spec.callId);
    }
  }
  return { events, evidence };
}

function patch(file: string, removed: string, added: string): string {
  return `*** Begin Patch\n*** Update File: ${file}\n@@\n-${removed}\n+${added}\n*** End Patch`;
}

describe('edit signal extraction (design 23.3)', () => {
  it('does not promote edits without successful results into rework hints', () => {
    const { events, evidence } = buildEdits([
      { id: 'p1', line: 1, text: patch('a.ts', 'one', 'two'), callId: 'c1' },
      { id: 'p2', line: 4, text: patch('a.ts', 'two', 'three'), callId: 'c2' },
    ]);
    assert.equal(computeEditSignals(evidence, events).hints.length, 0);
  });
  it('extracts paths from patch headers and json path fields, sorted and unique', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: src/b.ts',
      '*** Add File: src/a.ts',
      '*** End Patch',
      '{"file_path": "src/a.ts", "path": "docs/c.md"}',
    ].join('\n');
    assert.deepEqual(extractPaths(text), ['docs/c.md', 'src/a.ts', 'src/b.ts']);
  });

  it('links a change to its paired result by call id and records success', () => {
    const { events, evidence } = buildEdits([
      { id: 'p1', line: 2, text: patch('src/a.ts', 'old()', 'new()'), callId: 'c1', result: 'Script completed' },
    ]);
    const { signals } = computeEditSignals(evidence, events);
    assert.equal(signals.length, 2);
    const change = signals[0];
    const result = signals[1];
    assert.ok(change && result);
    assert.equal(change.role, 'change');
    assert.deepEqual(change.paths, ['src/a.ts']);
    assert.equal(change.region_keys.length, 1);
    assert.equal(change.success, true);
    assert.equal(result.role, 'result');
    assert.equal(result.success, true);
  });

  it('marks a change failed when its paired result failed', () => {
    const { events, evidence } = buildEdits([
      { id: 'p1', line: 2, text: patch('src/a.ts', 'old()', 'new()'), callId: 'c1', result: 'error: permission denied' },
    ]);
    const { signals, hints } = computeEditSignals(evidence, events);
    const change = signals.find((signal) => signal.role === 'change');
    assert.equal(change?.success, false);
    assert.equal(hints.length, 0, 'failed edits produce no rework hints');
  });

  it('suggests file-level pairs for the same path and upgrades to region when changed lines repeat', () => {
    const disjoint = buildEdits([
      { id: 'p1', line: 2, text: patch('src/a.ts', 'one()', 'two()'), callId: 'c1', result: 'completed' },
      { id: 'p2', line: 6, text: patch('src/a.ts', 'three()', 'four()'), callId: 'c2', result: 'completed' },
    ]);
    const fileHints = computeEditSignals(disjoint.evidence, disjoint.events).hints;
    assert.equal(fileHints.length, 1);
    assert.equal(fileHints[0]?.level, 'file');
    assert.deepEqual(fileHints[0]?.paths, ['src/a.ts']);

    const repeated = buildEdits([
      { id: 'p1', line: 2, text: patch('src/a.ts', 'one()', 'two()'), callId: 'c1', result: 'completed' },
      { id: 'p2', line: 6, text: patch('src/a.ts', 'one()', 'two()'), callId: 'c2', result: 'completed' },
    ]);
    const regionHints = computeEditSignals(repeated.evidence, repeated.events).hints;
    assert.equal(regionHints[0]?.level, 'region');
  });

  it('skips failed changes when pairing hints', () => {
    const { events, evidence } = buildEdits([
      { id: 'p1', line: 2, text: patch('src/a.ts', 'one()', 'two()'), callId: 'c1', result: 'failed' },
      { id: 'p2', line: 4, text: patch('src/a.ts', 'three()', 'four()'), callId: 'c2', result: 'completed' },
      { id: 'p3', line: 6, text: patch('src/a.ts', 'five()', 'six()'), callId: 'c3', result: 'completed' },
    ]);
    const { signals, hints } = computeEditSignals(evidence, events);
    assert.equal(signals.length, 6);
    assert.deepEqual(
      hints.map((hint) => [hint.earlier_evidence_id, hint.later_evidence_id]),
      [['ev-p2', 'ev-p3']],
    );
  });

  it('exposes change lookups for the ingest corroboration', () => {
    const { events, evidence } = buildEdits([
      { id: 'p1', line: 2, text: patch('src/a.ts', 'one()', 'two()'), callId: 'c1', result: 'completed' },
    ]);
    const { signals } = computeEditSignals(evidence, events);
    assert.equal(hasAnyChangeSignal(signals), true);
    assert.equal(changeSignalsByEvidence(signals).get('ev-p1')?.event_id, 'p1');
    assert.equal(hasAnyChangeSignal([]), false);
  });

  it('produces nothing for sessions without edit or result events', () => {
    const events = [mkEvent('u1', 'user_message', 0, 1, 'hi')];
    const evidence: EvidenceItem[] = [
      { id: 'ev-u1', kind: 'user_text', excerpt: 'hi', source_ref: { line: 1, hash: sha256Tag('u1') }, truncated: false },
    ];
    const { signals, hints } = computeEditSignals(evidence, events);
    assert.deepEqual(signals, []);
    assert.deepEqual(hints, []);
  });
});
