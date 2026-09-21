import { ScaError } from '../domain/errors.js';

/**
 * Deterministic harness target editing (design 14.1). Writes are confined to
 * one managed marker region; anything beyond "append or update the managed
 * region" must go through the agent semantic-merge path instead (design 14.2),
 * never a silent rewrite of the user's file.
 */

export const MANAGED_START = '<!-- session-correction-analysis:start -->';
export const MANAGED_END = '<!-- session-correction-analysis:end -->';
export const MANAGED_HEADING = '## Session Correction Rules';

export interface RuleInput {
  readonly title: string;
  readonly proposed_content: string;
}

/** The exact markdown block a candidate contributes inside the region. */
export function ruleBlock(candidate: RuleInput): string {
  return `### ${candidate.title}\n\n${candidate.proposed_content.trim()}`;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export interface HarnessApplyResult {
  readonly after: string;
  readonly duplicate: boolean;
}

/**
 * Insert `block` into the managed region, creating the region when absent.
 * A block whose trimmed text already appears verbatim in the region is a
 * duplicate: nothing changes and the caller reports `unchanged`.
 */
export function applyRule(before: string, block: string): HarnessApplyResult {
  const starts = countOccurrences(before, MANAGED_START);
  const ends = countOccurrences(before, MANAGED_END);
  if (starts === 0 && ends === 0) {
    const prefix = before.length === 0 || before.endsWith('\n') ? '' : '\n';
    const region = `${prefix}${MANAGED_START}\n\n${MANAGED_HEADING}\n\n${block}\n\n${MANAGED_END}\n`;
    return { after: `${before}${region}`, duplicate: false };
  }
  if (starts !== 1 || ends !== 1 || before.indexOf(MANAGED_END) < before.indexOf(MANAGED_START)) {
    throw new ScaError(
      'unsupported_operation',
      'the target file has no single well-formed managed region; stop automatic publishing and repair it by hand',
    );
  }
  const startIdx = before.indexOf(MANAGED_START);
  const endIdx = before.indexOf(MANAGED_END);
  const inner = before.slice(startIdx + MANAGED_START.length, endIdx);
  if (inner.includes(block.trim())) {
    return { after: before, duplicate: true };
  }
  const body = inner.trim();
  const rebuilt = body.length === 0 ? `\n\n${block}\n\n` : `\n\n${body}\n\n${block}\n\n`;
  const after = `${before.slice(0, startIdx + MANAGED_START.length)}${rebuilt}${before.slice(endIdx)}`;
  return { after, duplicate: false };
}

/**
 * One-hunk line diff over the changed span: common prefix/suffix lines are
 * trimmed, so the hunk is exactly what the write inserts or replaces. With the
 * prefix/suffix trim the hunk is a precise, deterministic diff for the
 * contiguous edits applyRule can produce.
 */
export function lineDiff(before: string, after: string, context = 3): string {
  if (before === after) {
    return '';
  }
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const ctxBefore = a.slice(Math.max(0, head - context), head);
  const ctxAfter = b.slice(b.length - tail, b.length - tail + context);
  const oldStart = Math.max(1, head - context + 1);
  const oldLen = ctxBefore.length + removed.length + ctxAfter.length;
  const newLen = ctxBefore.length + added.length + ctxAfter.length;
  const lines = [
    `@@ -${oldStart},${oldLen} +${oldStart},${newLen} @@`,
    ...ctxBefore.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...ctxAfter.map((l) => ` ${l}`),
  ];
  return lines.join('\n');
}
