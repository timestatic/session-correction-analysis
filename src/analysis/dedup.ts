import type { Candidate } from '../domain/candidates.js';

export interface MergeSuggestion {
  candidate_ids: [string, string];
  category: string;
  similarity: number;
}

/**
 * Tuned for the local dev set (T11 replays it); semantic similarity only ever
 * produces suggestions for the human reviewer, never an automatic merge
 * (design 23.3). This is a pure read-time function; nothing is stored.
 */
export const MERGE_SUGGESTION_THRESHOLD = 0.6;

const LATIN_TOKEN = /[a-z0-9_]{2,}/g;
const CJK_RUN = /[\u4e00-\u9fff]+/g;

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(LATIN_TOKEN)) {
    const token = match[0];
    if (token !== undefined) {
      tokens.add(token);
    }
  }
  for (const run of text.matchAll(CJK_RUN)) {
    const sequence = run[0];
    if (sequence === undefined) {
      continue;
    }
    if (sequence.length === 1) {
      tokens.add(sequence);
      continue;
    }
    for (let i = 0; i + 1 < sequence.length; i += 1) {
      tokens.add(sequence.slice(i, i + 2));
    }
  }
  return tokens;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

export function suggestMerges(candidates: readonly Candidate[]): MergeSuggestion[] {
  const suggestions: MergeSuggestion[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const left = candidates[i];
    if (left === undefined) {
      continue;
    }
    const leftText = tokenize(`${left.title}\n${left.proposed_content}`);
    for (let j = i + 1; j < candidates.length; j += 1) {
      const right = candidates[j];
      if (right === undefined || right.category !== left.category) {
        continue;
      }
      const similarity = jaccard(leftText, tokenize(`${right.title}\n${right.proposed_content}`));
      if (similarity >= MERGE_SUGGESTION_THRESHOLD) {
        suggestions.push({
          candidate_ids: [left.id, right.id],
          category: left.category,
          similarity: Number(similarity.toFixed(4)),
        });
      }
    }
  }
  return suggestions;
}
