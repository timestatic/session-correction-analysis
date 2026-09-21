import type { Candidate, CandidateStatus } from '../domain/candidates.js';
import type { AnalyzeDocument, CandidatesDocument } from '../domain/documents.js';
import type { EpisodeCommitted } from '../domain/episodes.js';
import {
  hasReworkEvidence,
  isFormalCorrection,
  isFormalIntervention,
} from '../domain/states.js';

/**
 * Deterministic human-readable projections of frontmatter state (design 24.1).
 * The frontmatter stays authoritative; regenerating this body never adds facts.
 */

function text(value: string): string {
  // Model-authored text must not forge headings or list structure in the projection.
  return value
    .split('\n')
    .map((line, i) => (i === 0 ? line : `    ${line.replace(/^#+\s*/, '')}`))
    .join('\n')
    .replace(/^#+\s*/gm, '');
}

function bullet(label: string, value: string): string {
  return `- ${label}：${text(value)}`;
}

export function renderAnalyzeProjection(doc: AnalyzeDocument): string {
  const lines: string[] = ['# Session 分析', ''];
  lines.push('## 会话摘要', '');
  lines.push(bullet('原始 Session ID', doc.session_id));
  lines.push(bullet('标题', doc.session_title ?? '（无，显示原始 Session ID）'));
  lines.push(bullet('宿主', doc.source));
  if (doc.project_name !== undefined) {
    lines.push(bullet('项目', doc.project_name));
  }
  if (doc.workspace !== undefined) {
    lines.push(bullet('Workspace', doc.workspace));
  }
  lines.push(bullet('触发', doc.trigger));
  lines.push(bullet('分析状态', doc.analysis_status));
  const snapshot = doc.facts?.snapshot;
  lines.push(bullet('覆盖度', snapshot?.coverage ?? 'unknown'));
  if (snapshot !== undefined && snapshot.coverage !== 'full') {
    lines.push(bullet('覆盖警告', '输入不完整，本记录不构成全会话结论'));
  }
  lines.push(bullet('解析器版本', snapshot?.parser_version ?? doc.analyzer_version));
  if (doc.analyzed_at !== undefined && doc.analyzed_at !== null) {
    lines.push(bullet('分析时间', doc.analyzed_at));
  }
  lines.push('');
  if (doc.facts?.summary !== undefined) {
    lines.push(text(doc.facts.summary), '');
  }
  if (doc.error !== undefined && doc.error !== null) {
    lines.push('## 错误', '', bullet('错误码', doc.error.code), bullet('说明', doc.error.message), bullet('下一步', doc.error.next_step), '');
  }

  const episodes = doc.facts?.episodes ?? [];
  const corrections = episodes.filter(isFormalCorrection);
  const interventions = episodes.filter(isFormalIntervention);
  const uncertain = episodes.filter(
    (ep) =>
      (ep.correction.detected && ep.correction.confidence === 'uncertain') ||
      (ep.intervention.detected && ep.intervention.confidence === 'uncertain'),
  );

  lines.push('## 人工纠错', '');
  if (corrections.length === 0) {
    lines.push('（无正式纠错）', '');
  }
  for (const ep of corrections) {
    lines.push(renderEpisode(ep), '');
  }

  lines.push('## 人工介入', '');
  if (interventions.length === 0) {
    lines.push('（无正式介入）', '');
  }
  for (const ep of interventions) {
    lines.push(renderEpisode(ep), '');
  }

  lines.push('## 重复代码修改', '');
  const reworks = corrections.filter(hasReworkEvidence);
  if (reworks.length === 0) {
    lines.push('（无返工证据）', '');
  }
  for (const ep of reworks) {
    const rework = ep.correction.rework;
    if (rework === undefined) {
      continue;
    }
    lines.push(bullet(ep.id, `返工结果：${rework.outcome}；证据：${rework.evidence.join(', ')}`));
  }
  lines.push('');

  lines.push('## 不确定事项', '');
  if (uncertain.length === 0) {
    lines.push('（无）', '');
  }
  for (const ep of uncertain) {
    lines.push(bullet(ep.id, ep.issue_anchor));
  }
  if ((doc.facts?.candidate_sources.length ?? 0) > 0) {
    lines.push('', '## 候选来源存档', '', '以下为候选创建时的证据，不计入本轮纠错/介入统计。', '');
    for (const source of doc.facts?.candidate_sources ?? []) {
      lines.push(`### ${source.candidate_id}`, '');
      for (const episode of source.episodes) lines.push(bullet('来源问题', `${episode.id}：${episode.issue_anchor}`));
      for (const item of source.evidence) lines.push(bullet(`证据 ${item.id}`, item.excerpt));
      lines.push('');
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderEpisode(ep: EpisodeCommitted): string {
  const lines: string[] = [`### ${ep.id}：${text(ep.issue_anchor)}`, ''];
  if (ep.correction.detected) {
    lines.push(bullet('纠错置信度', ep.correction.confidence));
    if (ep.correction.subtype !== undefined) {
      lines.push(bullet('纠错类型', ep.correction.subtype));
    }
    lines.push(bullet('前序 Agent 行为', ep.correction.prior_agent_behavior.join(', ') || '（未关联）'));
    lines.push(bullet('纠错后行为', ep.correction.agent_behavior_after.join(', ') || '（未关联）'));
    const rework = ep.correction.rework;
    if (rework !== undefined) {
      lines.push(bullet('是否产生返工', `${rework.outcome}（证据 ${String(rework.evidence.length)} 项）`));
    }
    lines.push(bullet('说明', ep.correction.explanation));
  }
  if (ep.intervention.detected) {
    lines.push(bullet('介入置信度', ep.intervention.confidence));
    if (ep.intervention.kind !== undefined) {
      lines.push(bullet('介入类型', ep.intervention.kind));
    }
    lines.push(bullet('介入证据', ep.intervention.evidence.join(', ') || '（未关联）'));
    lines.push(bullet('介入说明', ep.intervention.explanation));
  }
  lines.push(bullet('锚点事件', ep.anchor_event_id));
  for (const citation of ep.citations) {
    lines.push(bullet(`证据 ${citation.evidence_id}`, `"${citation.quote}"`));
  }
  return lines.join('\n');
}

const STATUS_LABELS: Record<CandidateStatus, string> = {
  proposed: '待审核',
  approved: '已批准',
  published: '已发布',
  rejected: '已拒绝',
  publish_failed: '发布失败',
  superseded: '已被替代',
};

export function renderCandidatesProjection(doc: CandidatesDocument): string {
  const lines: string[] = ['# Learning Candidates', ''];
  if (doc.candidates.length === 0) {
    lines.push('（本会话未产出候选）', '');
  }
  for (const candidate of doc.candidates) {
    lines.push(renderCandidate(candidate), '');
  }
  return lines.join('\n');
}

function renderCandidate(candidate: Candidate): string {
  const lines: string[] = [`## ${candidate.id}：${text(candidate.title)}`, ''];
  lines.push(bullet('状态', STATUS_LABELS[candidate.status]));
  lines.push(bullet('成熟度', candidate.maturity));
  lines.push(bullet('置信度', candidate.confidence));
  lines.push(bullet('类别', candidate.category));
  lines.push(
    bullet(
      '目标',
      candidate.target.kind === 'harness'
        ? `harness：${candidate.target.path ?? '（未定）'}${candidate.target.section !== undefined ? ` / ${candidate.target.section}` : ''}`
        : `memory：${candidate.target.scope ?? 'project'}（仅内容，不写入外部记忆）`,
    ),
  );
  lines.push(bullet('证据', candidate.evidence.join(', ')));
  lines.push(bullet('来源 episode', candidate.source_episodes.join(', ')));
  lines.push('- 建议内容：', '');
  for (const paragraph of candidate.proposed_content.split('\n\n')) {
    lines.push(`    ${text(paragraph)}`, '');
  }
  if (candidate.applicable_scope !== undefined) {
    lines.push(bullet('适用范围', candidate.applicable_scope));
  }
  if (candidate.trigger_condition !== undefined) {
    lines.push(bullet('触发条件', candidate.trigger_condition));
  }
  if (candidate.exceptions !== undefined) {
    lines.push(bullet('例外', candidate.exceptions));
  }
  if (candidate.not_applicable !== undefined) {
    lines.push(bullet('不适用', candidate.not_applicable));
  }
  if (candidate.decision !== null) {
    lines.push(
      bullet('最近决定', `${candidate.decision.action} @ ${candidate.decision.at}`),
    );
  }
  if (candidate.publication.published) {
    lines.push(bullet('发布', `成功 @ ${candidate.publication.published_at ?? '时间未知'}`));
  } else if (candidate.publication.result === 'failed') {
    lines.push(bullet('发布', `失败：${candidate.publication.error?.code ?? '未知错误'}`));
  }
  if (candidate.needs_review !== undefined) {
    lines.push(bullet('需要复核', candidate.needs_review.reason));
  }
  return lines.join('\n');
}
