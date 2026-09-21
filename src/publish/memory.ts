import fs from 'node:fs/promises';
import path from 'node:path';

import type { Candidate } from '../domain/candidates.js';
import { ScaError } from '../domain/errors.js';
import { allowedActions, type CandidateAction } from '../domain/states.js';
import type { RecordRepository } from '../store/repository.js';

/**
 * Memory content surface (design 26.4): there is NO memory sink this phase —
 * no MemoryAdapter, no plugin probing, no writes into any memory store. A
 * memory candidate only ever renders editable, human-copyable markdown, and
 * copy/export never touch approval state or revision.
 */

/** Concise, portable markdown: no raw transcript text, no private paths. */
export function renderMemoryContent(candidate: Candidate): string {
  const lines = [
    `# ${candidate.title}`,
    '',
    '## 规则正文',
    '',
    candidate.proposed_content.trim(),
  ];
  if (candidate.applicable_scope !== undefined) {
    lines.push('', '## 适用范围', '', candidate.applicable_scope);
  }
  if (candidate.trigger_condition !== undefined) {
    lines.push('', '## 触发条件', '', candidate.trigger_condition);
  }
  if (candidate.exceptions !== undefined) {
    lines.push('', '## 例外', '', candidate.exceptions);
  }
  if (candidate.not_applicable !== undefined) {
    lines.push('', '## 不适用场景', '', candidate.not_applicable);
  }
  lines.push(
    '',
    '## 来源摘要',
    '',
    `类别 ${candidate.category} · 证据 ${candidate.evidence.length} 条 · 来源 episode ${candidate.source_episodes.length} 个（明细见 learning_candidates.md）`,
  );
  return `${lines.join('\n')}\n`;
}

export interface MemoryContentOutcome {
  content: string;
  exported_to?: string;
}

/**
 * copy_content prints the markdown; export_content additionally writes it to
 * a user-chosen path. Both are gated by the review state machine, are
 * read-only with respect to candidate state, and never count as a result.
 */
export async function memoryContent(
  repo: RecordRepository,
  recordId: string,
  candidateId: string,
  action: Extract<CandidateAction, 'copy_content' | 'export_content'>,
  opts: { outPath?: string; force?: boolean } = {},
): Promise<MemoryContentOutcome> {
  const { doc } = await repo.loadCandidates(recordId);
  const candidate = doc.candidates.find((c) => c.id === candidateId);
  if (candidate === undefined) {
    throw new ScaError('schema_invalid', `no candidate ${candidateId} in this record`);
  }
  if (candidate.rule_ref !== undefined) throw new ScaError('unsupported_operation', 'linked rules require version-bound memory export; legacy candidate export is disabled');
  if (!allowedActions(candidate).includes(action)) {
    throw new ScaError(
      'unsupported_operation',
      `${action} is not allowed for candidate ${candidate.id} (status ${candidate.status}, target ${candidate.target.kind}); ` +
        'approve the current version first',
    );
  }
  const content = renderMemoryContent(candidate);
  if (action === 'copy_content') {
    return { content };
  }
  if (opts.outPath === undefined) {
    throw new ScaError('schema_invalid', 'export_content needs --out <path>');
  }
  const out = path.resolve(opts.outPath);
  if (!opts.force) {
    const exists = await fs
      .stat(out)
      .then((s) => s.isFile())
      .catch(() => false);
    if (exists) {
      throw new ScaError('schema_invalid', `${out} already exists; pass force to overwrite`);
    }
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, content, 'utf8');
  return { content, exported_to: out };
}
