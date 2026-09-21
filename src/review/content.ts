import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Candidate } from '../domain/candidates.js';
import { ScaError } from '../domain/errors.js';
import { hasCurrentApproval } from './decide.js';
import { allowedActions, type CandidateAction } from '../domain/states.js';
import type { RecordRepository } from '../store/repository.js';

/** Render approved text without injecting transcript excerpts or source filesystem paths. */
export function renderCandidateContent(candidate: Candidate): string {
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

export interface ContentOutcome {
  content: string;
  exported_to?: string;
}

/**
 * copy_content prints the markdown; export_content additionally writes it to
 * a user-chosen path. Both are gated by the review state machine, are
 * read-only with respect to candidate state, and never count as a result.
 */
export async function candidateContent(
  repo: RecordRepository,
  recordId: string,
  candidateId: string,
  action: Extract<CandidateAction, 'copy_content' | 'export_content'>,
  opts: { outPath?: string } = {},
): Promise<ContentOutcome> {
  const { candidates: { doc } } = await repo.loadRecord(recordId);
  const candidate = doc.candidates.find((c) => c.id === candidateId);
  if (candidate === undefined) {
    throw new ScaError('schema_invalid', `no candidate ${candidateId} in this record`);
  }
  if (!hasCurrentApproval(candidate) || !allowedActions(candidate).includes(action)) {
    throw new ScaError(
      'unsupported_operation',
      `${action} is not allowed for candidate ${candidate.id} (status ${candidate.status}, target ${candidate.target.kind}); ` +
        'approve the current version first',
    );
  }
  const content = renderCandidateContent(candidate);
  if (action === 'copy_content') {
    return { content };
  }
  if (opts.outPath === undefined) {
    throw new ScaError('schema_invalid', 'export_content needs --out <path>');
  }
  const out = path.resolve(opts.outPath);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const tmp = path.join(path.dirname(out), `.sca-export-${randomUUID()}.tmp`);
  try {
    const file = await fs.open(tmp, 'wx', 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    // link publishes the complete file atomically and refuses an existing destination.
    await fs.link(tmp, out);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new ScaError('schema_invalid', 'export destination already exists; choose a new file');
    }
    throw error;
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return { content, exported_to: out };
}
