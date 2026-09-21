import { isFormalConfidence, type EpisodeCommitted } from '../domain/episodes.js';
import type { ProcessedUser } from '../domain/episodes.js';
import { ScaError } from '../domain/errors.js';
import { goldLabelSchema, type GoldEpisode, type GoldLabel, type GoldSession, type MatchEntry } from './gold.js';

/**
 * Deterministic gold-vs-prediction scoring (design 29.3). The scorer only
 * validates and counts the frozen, human-confirmed match table; it never judges
 * matches itself, and text similarity can never substitute for a table entry.
 * Metrics are micro across sessions with per-session detail preserved.
 */

export const REWORK_CLAIM_OUTCOMES = new Set(['undone', 'replaced', 'fixed']);

export interface PredictionEpisode {
  id: string;
  /** Formal = label asserted with high/medium confidence (design 29.1). */
  labels: GoldLabel[];
  /** Label asserted but low/uncertain — kept out of every metric denominator. */
  review_labels: GoldLabel[];
  anchor_evidence_id: string;
  cited_evidence_ids: string[];
  rework_claimed: boolean;
}

export function predictionsFromEpisodes(episodes: readonly EpisodeCommitted[]): PredictionEpisode[] {
  return episodes.map((episode) => {
    const labels: GoldLabel[] = [];
    const reviewLabels: GoldLabel[] = [];
    for (const label of goldLabelSchema.options) {
      const judgement = label === 'correction' ? episode.correction : episode.intervention;
      if (!judgement.detected) {
        continue;
      }
      (isFormalConfidence(judgement.confidence) ? labels : reviewLabels).push(label);
    }
    return {
      id: episode.id,
      labels,
      review_labels: reviewLabels,
      anchor_evidence_id: episode.anchor_event_id,
      cited_evidence_ids: episode.citations.map((citation) => citation.evidence_id),
      rework_claimed:
        episode.correction.rework !== undefined && REWORK_CLAIM_OUTCOMES.has(episode.correction.rework.outcome),
    };
  });
}

export interface SessionAnalysis {
  /** 'failed' = parse/whole-analysis failure: no predictions accepted, gold still counts as FN. */
  status: 'ok' | 'failed';
  coverage: 'full' | 'partial' | 'unknown';
  predictions: PredictionEpisode[];
  /** Full model receipt, including negative judgments; omitted legacy input has coverage gaps. */
  processed_users?: ProcessedUser[];
}

export interface ScoredSessionInput {
  session_id: string;
  gold?: GoldSession;
  analysis?: SessionAnalysis;
}

export interface LabelCounts {
  tp: number;
  fp: number;
  fn: number;
}

export interface Metrics extends LabelCounts {
  /** N/A (null) whenever the denominator is zero — never a fake 100%. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** 95% Wilson intervals, reported as small-sample reference only (acceptance uses point estimates). */
  precision_wilson_95: [number, number] | null;
  recall_wilson_95: [number, number] | null;
}

export interface FpDetail {
  session_id: string;
  kind: 'prediction_unmatched';
  prediction_id: string;
  label: GoldLabel;
  anchor_evidence_id: string;
}

export interface FnDetail {
  session_id: string;
  kind: 'gold_unmatched' | 'gold_session_failed';
  gold_id: string;
  label: GoldLabel;
  anchor_evidence_id: string;
}

export interface ReworkDetail {
  session_id: string;
  gold_id: string;
  prediction_id?: string;
  kind: 'hit' | 'miss' | 'false_claim' | 'unknown_excluded' | 'missed_episode';
}

export interface SessionResult {
  session_id: string;
  status: 'scored' | 'failed' | 'excluded_unlabeled' | 'excluded_unused' | 'missing_gold';
  coverage: 'full' | 'partial' | 'unknown' | 'n/a';
  correction: Metrics;
  intervention: Metrics;
  rework: Metrics;
  fp_details: FpDetail[];
  fn_details: FnDetail[];
  rework_details: ReworkDetail[];
  review_only_predictions: number;
}

export interface EvalReport {
  per_session: SessionResult[];
  micro: { correction: Metrics; intervention: Metrics; rework: Metrics };
  abstention: { arbitrated_units: number; uncertain_units: number; rate: number | null };
  /** Model-unprocessed user messages; gold uncertainty is reported separately. */
  coverage_gap_units: number;
  gold_excluded_units: number;
  gold_coverage_gap_units: number;
  totals: {
    sessions: number;
    scored: number;
    failed: number;
    partial_coverage: number;
    excluded: number;
    missing_gold: number;
    awaiting_review_predictions: number;
  };
}

function fail(detail: string): never {
  throw new ScaError('schema_invalid', `eval input rejected: ${detail}`);
}

export function wilsonInterval(successes: number, total: number, z = 1.96): [number, number] | null {
  if (total === 0) {
    return null;
  }
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function toMetrics(counts: LabelCounts): Metrics {
  const precision = counts.tp + counts.fp === 0 ? null : counts.tp / (counts.tp + counts.fp);
  const recall = counts.tp + counts.fn === 0 ? null : counts.tp / (counts.tp + counts.fn);
  const f1 =
    2 * counts.tp + counts.fp + counts.fn === 0
      ? null
      : (2 * counts.tp) / (2 * counts.tp + counts.fp + counts.fn);
  return {
    ...counts,
    precision,
    recall,
    f1,
    precision_wilson_95: wilsonInterval(counts.tp, counts.tp + counts.fp),
    recall_wilson_95: wilsonInterval(counts.tp, counts.tp + counts.fn),
  };
}

interface ResolvedMatch {
  prediction: PredictionEpisode;
  gold: GoldEpisode;
  label: GoldLabel;
}

/** Validates every table entry against design 29.3 and enforces one-to-one per label. */
function resolveMatches(
  sessions: readonly ScoredSessionInput[],
  matchTable: readonly MatchEntry[],
): Map<string, ResolvedMatch[]> {
  const bySession = new Map<string, ScoredSessionInput>();
  for (const session of sessions) {
    if (bySession.has(session.session_id)) {
      fail(`duplicate session ${session.session_id}`);
    }
    bySession.set(session.session_id, session);
  }
  const resolved = new Map<string, ResolvedMatch[]>();
  const usedPredictions = new Set<string>();
  const usedGold = new Set<string>();
  for (const entry of matchTable) {
    const session = bySession.get(entry.session_id);
    if (session === undefined) {
      fail(`match entry references unknown session ${entry.session_id}`);
    }
    const goldSession = usableGold(session);
    if (goldSession === undefined) {
      fail(`match entry for session ${entry.session_id} has no labeled dev/test gold`);
    }
    const analysis = session.analysis;
    if (analysis === undefined || analysis.status !== 'ok') {
      fail(`match entry ${entry.prediction_id} references a session whose analysis failed`);
    }
    const prediction = analysis.predictions.find((item) => item.id === entry.prediction_id);
    if (prediction === undefined) {
      fail(`match entry references unknown prediction ${entry.prediction_id} in session ${entry.session_id}`);
    }
    if (!prediction.labels.includes(entry.label)) {
      fail(
        `prediction ${entry.prediction_id} is not a formal ${entry.label} prediction (awaiting-review predictions cannot be matched)`,
      );
    }
    const gold = goldSession.episodes.find((episode) => episode.id === entry.gold_id);
    if (gold === undefined) {
      fail(`match entry references unknown gold ${entry.gold_id} in session ${entry.session_id}`);
    }
    if (!gold.labels.includes(entry.label)) {
      fail(`gold ${entry.gold_id} does not carry the label ${entry.label}`);
    }
    if (prediction.anchor_evidence_id !== gold.anchor_evidence_id) {
      fail(`match ${entry.prediction_id}<->${entry.gold_id}: problem anchors differ (design 29.3)`);
    }
    const feedbackHit =
      gold.feedback_evidence_ids.includes(prediction.anchor_evidence_id) ||
      prediction.cited_evidence_ids.some((id) => gold.feedback_evidence_ids.includes(id));
    if (!feedbackHit) {
      fail(`match ${entry.prediction_id}<->${entry.gold_id}: no user-feedback evidence hits the gold feedback set`);
    }
    const predictionKey = `${entry.label}\u0000${entry.session_id}\u0000${entry.prediction_id}`;
    const goldKey = `${entry.label}\u0000${entry.session_id}\u0000${entry.gold_id}`;
    if (usedPredictions.has(predictionKey) || usedGold.has(goldKey)) {
      fail(`match table breaks one-to-one for label ${entry.label} in session ${entry.session_id}`);
    }
    usedPredictions.add(predictionKey);
    usedGold.add(goldKey);
    const list = resolved.get(entry.session_id) ?? [];
    list.push({ prediction, gold, label: entry.label });
    resolved.set(entry.session_id, list);
  }
  return resolved;
}

function usableGold(session: ScoredSessionInput): GoldSession | undefined {
  if (session.gold === undefined || !session.gold.labeled || session.gold.split === 'unused') {
    return undefined;
  }
  const excluded = new Set(session.gold.units.filter((unit) => unit.status !== 'arbitrated').map((unit) => unit.evidence_id));
  return { ...session.gold, episodes: session.gold.episodes.filter((episode) => !excluded.has(episode.anchor_evidence_id)) };
}

function sessionStatus(session: ScoredSessionInput): SessionResult['status'] {
  if (session.gold === undefined) {
    return 'missing_gold';
  }
  if (session.gold.split === 'unused') {
    return 'excluded_unused';
  }
  if (!session.gold.labeled) {
    return 'excluded_unlabeled';
  }
  if (session.analysis !== undefined && session.analysis.status === 'failed') {
    return 'failed';
  }
  return 'scored';
}

function scoreSession(session: ScoredSessionInput, matches: ResolvedMatch[]): SessionResult {
  const status = sessionStatus(session);
  const goldSession = usableGold(session);
  const base = {
    session_id: session.session_id,
    status,
    coverage: session.analysis?.coverage ?? ('n/a' as const),
    fp_details: [] as FpDetail[],
    fn_details: [] as FnDetail[],
    rework_details: [] as ReworkDetail[],
    review_only_predictions:
      session.analysis?.predictions.filter((p) => p.labels.length === 0 && p.review_labels.length > 0).length ?? 0,
  };
  if (goldSession === undefined || !goldSession.labeled || goldSession.split === 'unused') {
    return {
      ...base,
      correction: toMetrics({ tp: 0, fp: 0, fn: 0 }),
      intervention: toMetrics({ tp: 0, fp: 0, fn: 0 }),
      rework: toMetrics({ tp: 0, fp: 0, fn: 0 }),
    };
  }
  const failed = session.analysis === undefined || session.analysis.status === 'failed';
  const excluded = new Set(goldSession.units.filter((unit) => unit.status !== 'arbitrated').map((unit) => unit.evidence_id));
  const predictions = (session.analysis?.predictions ?? []).filter((prediction) => !excluded.has(prediction.anchor_evidence_id));
  const corrections: MetricsCounts = { tp: 0, fp: 0, fn: 0 };
  const interventions: MetricsCounts = { tp: 0, fp: 0, fn: 0 };
  const rework: MetricsCounts = { tp: 0, fp: 0, fn: 0 };
  const matchedPredictionIds = new Map<GoldLabel, Set<string>>();
  for (const match of matches) {
    const bucket = match.label === 'correction' ? corrections : interventions;
    bucket.tp += 1;
    const set = matchedPredictionIds.get(match.label) ?? new Set<string>();
    set.add(match.prediction.id);
    matchedPredictionIds.set(match.label, set);
  }
  for (const label of ['correction', 'intervention'] as const) {
    const bucket = label === 'correction' ? corrections : interventions;
    const matched = matchedPredictionIds.get(label) ?? new Set<string>();
    for (const prediction of predictions) {
      if (prediction.labels.includes(label) && !matched.has(prediction.id)) {
        bucket.fp += 1;
        base.fp_details.push({
          session_id: session.session_id,
          kind: 'prediction_unmatched',
          prediction_id: prediction.id,
          label,
          anchor_evidence_id: prediction.anchor_evidence_id,
        });
      }
    }
    const matchedGold = new Set(matches.filter((match) => match.label === label).map((match) => match.gold.id));
    for (const gold of goldSession.episodes) {
      if (!gold.labels.includes(label) || matchedGold.has(gold.id)) {
        continue;
      }
      bucket.fn += 1;
      base.fn_details.push({
        session_id: session.session_id,
        kind: failed ? 'gold_session_failed' : 'gold_unmatched',
        gold_id: gold.id,
        label,
        anchor_evidence_id: gold.anchor_evidence_id,
      });
    }
  }
  // Rework quality is evaluated only on human-judgeable episodes matched by correction (design 29.3).
  const matchedByGold = new Map(matches.filter((match) => match.label === 'correction').map((match) => [match.gold.id, match]));
  for (const gold of goldSession.episodes) {
    if (!gold.labels.includes('correction') || !gold.rework_judgeable) {
      continue;
    }
    if (gold.rework === 'unknown') {
      base.rework_details.push({ session_id: session.session_id, gold_id: gold.id, kind: 'unknown_excluded' });
      continue;
    }
    const match = matchedByGold.get(gold.id);
    if (match === undefined) {
      if (gold.rework === 'yes') {
        rework.fn += 1;
      }
      base.rework_details.push({ session_id: session.session_id, gold_id: gold.id, kind: 'missed_episode' });
      continue;
    }
    if (gold.rework === 'yes' && match.prediction.rework_claimed) {
      rework.tp += 1;
      base.rework_details.push({
        session_id: session.session_id,
        gold_id: gold.id,
        prediction_id: match.prediction.id,
        kind: 'hit',
      });
    } else if (gold.rework === 'no' && match.prediction.rework_claimed) {
      rework.fp += 1;
      base.rework_details.push({
        session_id: session.session_id,
        gold_id: gold.id,
        prediction_id: match.prediction.id,
        kind: 'false_claim',
      });
    } else if (gold.rework === 'yes') {
      rework.fn += 1;
      base.rework_details.push({
        session_id: session.session_id,
        gold_id: gold.id,
        prediction_id: match.prediction.id,
        kind: 'miss',
      });
    }
  }
  return {
    ...base,
    correction: toMetrics(corrections),
    intervention: toMetrics(interventions),
    rework: toMetrics(rework),
  };
}

interface MetricsCounts {
  tp: number;
  fp: number;
  fn: number;
}

export function scoreEval(
  sessions: readonly ScoredSessionInput[],
  matchTable: readonly MatchEntry[],
): EvalReport {
  const resolved = resolveMatches(sessions, matchTable);
  const perSession = sessions.map((session) =>
    scoreSession(session, session.analysis === undefined ? [] : (resolved.get(session.session_id) ?? [])),
  );
  const sum = (pick: (r: SessionResult) => LabelCounts): Metrics =>
    toMetrics(
      perSession.reduce<MetricsCounts>(
        (acc, result) => {
          const counts = pick(result);
          return { tp: acc.tp + counts.tp, fp: acc.fp + counts.fp, fn: acc.fn + counts.fn };
        },
        { tp: 0, fp: 0, fn: 0 },
      ),
    );
  let arbitrated = 0;
  let uncertain = 0;
  let coverageGap = 0;
  let goldExcluded = 0;
  let goldCoverageGap = 0;
  for (const session of sessions) {
    const gold = usableGold(session);
    if (gold === undefined) {
      continue;
    }
    const unitIds = new Set(gold.units.map((unit) => unit.evidence_id));
    const receipts = new Map<string, ProcessedUser>();
    for (const receipt of session.analysis?.processed_users ?? []) {
      if (!gold.all_user_evidence_ids.includes(receipt.evidence_id) || receipts.has(receipt.evidence_id) ||
          !['reviewed', 'uncertain'].includes(receipt.status)) {
        fail('processed_users contains an unknown, duplicate or invalid user receipt');
      }
      receipts.set(receipt.evidence_id, receipt);
    }
    for (const unit of gold.units) {
      if (unit.status === 'arbitrated') {
        arbitrated += 1;
        if (session.analysis?.status === 'ok' && receipts.get(unit.evidence_id)?.status === 'uncertain') uncertain += 1;
      } else {
        goldExcluded += 1;
      }
    }
    for (const id of gold.all_user_evidence_ids) {
      if (!unitIds.has(id)) {
        goldCoverageGap += 1;
      }
      if (session.analysis?.status !== 'ok' || !receipts.has(id)) coverageGap += 1;
    }
  }
  return {
    per_session: perSession,
    micro: {
      correction: sum((r) => r.correction),
      intervention: sum((r) => r.intervention),
      rework: sum((r) => r.rework),
    },
    abstention: {
      arbitrated_units: arbitrated,
      uncertain_units: uncertain,
      rate: arbitrated === 0 ? null : uncertain / arbitrated,
    },
    coverage_gap_units: coverageGap,
    gold_excluded_units: goldExcluded,
    gold_coverage_gap_units: goldCoverageGap,
    totals: {
      sessions: sessions.length,
      scored: perSession.filter((r) => r.status === 'scored' || r.status === 'failed').length,
      failed: perSession.filter((r) => r.status === 'failed').length,
      partial_coverage: perSession.filter((r) => r.coverage === 'partial').length,
      excluded: perSession.filter((r) => r.status === 'excluded_unlabeled' || r.status === 'excluded_unused').length,
      missing_gold: perSession.filter((r) => r.status === 'missing_gold').length,
      awaiting_review_predictions: perSession.reduce((acc, r) => acc + r.review_only_predictions, 0),
    },
  };
}

/** Session run-report counts (design 29.2): deduped episodes, never message counts. */
export function sessionEpisodeCounts(episodes: readonly EpisodeCommitted[]): {
  corrections: number;
  interventions: number;
  union: number;
  both: number;
  reworked: number;
} {
  const predictions = predictionsFromEpisodes(episodes);
  const corrections = predictions.filter((p) => p.labels.includes('correction'));
  const interventions = predictions.filter((p) => p.labels.includes('intervention'));
  return {
    corrections: corrections.length,
    interventions: interventions.length,
    union: predictions.filter((p) => p.labels.length > 0).length,
    both: predictions.filter((p) => p.labels.length === 2).length,
    reworked: corrections.filter((p) => p.rework_claimed).length,
  };
}
