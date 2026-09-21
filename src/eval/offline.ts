import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareRecord } from '../analysis/prepare.js';
import { ingestSubmission } from '../analysis/ingest.js';
import type { PreparePacket } from '../analysis/prepare.js';
import { ScaError } from '../domain/errors.js';
import type { Sha256Hash } from '../domain/hash.js';
import { RecordRepository } from '../store/repository.js';
import {
  GOLD_SCHEMA,
  goldSessionSchema,
  type EvalSplit,
  type GoldEpisode,
  type GoldLabel,
  type GoldSession,
  type GoldUnitStatus,
  type GoldUserUnit,
  type MatchEntry,
  type ReworkGold,
} from './gold.js';
import {
  predictionsFromEpisodes,
  scoreEval,
  type EvalReport,
  type Metrics,
  type PredictionEpisode,
  type ScoredSessionInput,
  type SessionAnalysis,
} from './scorer.js';
import { assertLabeledForScoring, buildWorksheet } from './worksheet.js';

/**
 * Offline semantic replay (plan 1.3 / 2.3): fixed inputs exercise the ingest
 * state machine, the prediction protocol and the scorer. It proves the
 * engineering pipeline; it never stands in for live model quality.
 * stdout carries only ids, counts and rates — no transcript text.
 */

const REPO_ROOT = path.join(import.meta.dirname, '../../..');
const CODEX_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'codex', 'basic.jsonl');
const NULL_FP: Sha256Hash = `sha256:${'0'.repeat(64)}`;

export function gUnit(evidenceId: string, status: GoldUnitStatus = 'arbitrated'): GoldUserUnit {
  return { evidence_id: evidenceId, event_id: `ev-${evidenceId}`, status };
}

export function gEpisode(
  id: string,
  labels: GoldLabel[],
  anchor: string,
  options: {
    feedback?: string[];
    rework?: ReworkGold;
    judgeable?: boolean;
  } = {},
): GoldEpisode {
  return {
    id,
    labels,
    anchor_evidence_id: anchor,
    feedback_evidence_ids: options.feedback ?? [anchor],
    rework: options.rework ?? 'unknown',
    rework_judgeable: options.judgeable ?? false,
    rationale: `fixture gold ${id}`,
  };
}

export function gSession(
  sessionId: string,
  options: {
    episodes?: GoldEpisode[];
    units?: GoldUserUnit[];
    all?: string[];
    labeled?: boolean;
    split?: EvalSplit;
  } = {},
): GoldSession {
  const units = options.units ?? [];
  return goldSessionSchema.parse({
    schema: GOLD_SCHEMA,
    session_id: sessionId,
    host: 'codex',
    source_fingerprint: NULL_FP,
    parser_version: 'test',
    rule_version: 'test',
    split: options.split ?? 'dev',
    labeled: options.labeled ?? true,
    all_user_evidence_ids: options.all ?? units.map((unit) => unit.evidence_id),
    units,
    episodes: options.episodes ?? [],
  });
}

export function pPrediction(
  id: string,
  labels: GoldLabel[],
  anchor: string,
  options: { cited?: string[]; review?: GoldLabel[]; reworkClaimed?: boolean } = {},
): PredictionEpisode {
  return {
    id,
    labels,
    review_labels: options.review ?? [],
    anchor_evidence_id: anchor,
    cited_evidence_ids: options.cited ?? [anchor],
    rework_claimed: options.reworkClaimed ?? false,
  };
}

export function pAnalysis(
  predictions: PredictionEpisode[],
  options: { status?: 'ok' | 'failed'; coverage?: 'full' | 'partial' | 'unknown'; processed_users?: SessionAnalysis['processed_users'] } = {},
): SessionAnalysis {
  return { status: options.status ?? 'ok', coverage: options.coverage ?? 'full', predictions,
    ...(options.processed_users !== undefined ? { processed_users: options.processed_users } : {}) };
}

export function gMatch(sessionId: string, predictionId: string, goldId: string, label: GoldLabel): MatchEntry {
  return { session_id: sessionId, prediction_id: predictionId, gold_id: goldId, label };
}

function countsOk(m: Metrics, tp: number, fp: number, fn: number): string | null {
  if (m.tp !== tp || m.fp !== fp || m.fn !== fn) {
    return `expected tp=${String(tp)} fp=${String(fp)} fn=${String(fn)}, got tp=${String(m.tp)} fp=${String(m.fp)} fn=${String(m.fn)}`;
  }
  return null;
}

function firstError(...checks: (string | null)[]): string | null {
  return checks.find((check) => check !== null) ?? null;
}

interface Scenario {
  name: string;
  sessions: ScoredSessionInput[];
  table: MatchEntry[];
  verify(report: EvalReport): string | null;
}

interface InvalidScenario {
  name: string;
  sessions: ScoredSessionInput[];
  table: MatchEntry[];
  expect: RegExp;
}

const cleanGold = gSession('s-clean', { episodes: [gEpisode('g1', ['correction'], 'u2')], units: [gUnit('u1'), gUnit('u2')] });
const doubleGold = gSession('s-double', {
  episodes: [gEpisode('g1', ['correction'], 'u2'), gEpisode('g2', ['correction'], 'u3')],
  units: [gUnit('u1'), gUnit('u2'), gUnit('u3')],
});
const labelGold = gSession('s-labels', {
  episodes: [gEpisode('g1', ['correction', 'intervention'], 'u2')],
  units: [gUnit('u1'), gUnit('u2')],
});
const reworkGoldSession = gSession('s-rework', {
  episodes: [
    gEpisode('r1', ['correction'], 'u1', { rework: 'yes', judgeable: true }),
    gEpisode('r2', ['correction'], 'u2', { rework: 'no', judgeable: true }),
    gEpisode('r3', ['correction'], 'u3', { rework: 'yes', judgeable: true }),
    gEpisode('r4', ['correction'], 'u4', { rework: 'unknown', judgeable: true }),
    gEpisode('r5', ['correction'], 'u5', { rework: 'yes', judgeable: true }),
  ],
  units: ['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => gUnit(id)),
});

export const SCORER_SCENARIOS: Scenario[] = [
  {
    name: 'one_to_one_clean',
    sessions: [{ session_id: 's-clean', gold: cleanGold, analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]) }],
    table: [gMatch('s-clean', 'ep1', 'g1', 'correction')],
    verify: (r) =>
      firstError(
        countsOk(r.micro.correction, 1, 0, 0),
        r.micro.correction.precision === 1 ? null : 'precision should be 1',
        r.totals.scored === 1 ? null : 'should score one session',
      ),
  },
  {
    name: 'duplicate_prediction_counts_fp',
    sessions: [
      {
        session_id: 's-clean',
        gold: cleanGold,
        analysis: pAnalysis([
          pPrediction('ep1', ['correction'], 'u2'),
          pPrediction('ep2', ['correction'], 'u2'),
        ]),
      },
    ],
    table: [gMatch('s-clean', 'ep1', 'g1', 'correction')],
    verify: (r) => countsOk(r.micro.correction, 1, 1, 0),
  },
  {
    name: 'missed_gold_counts_fn',
    sessions: [
      {
        session_id: 's-double',
        gold: doubleGold,
        analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]),
      },
    ],
    table: [gMatch('s-double', 'ep1', 'g1', 'correction')],
    verify: (r) =>
      firstError(
        countsOk(r.micro.correction, 1, 0, 1),
        r.per_session[0]?.fn_details[0]?.kind === 'gold_unmatched' ? null : 'fn kind should be gold_unmatched',
      ),
  },
  {
    name: 'same_episode_double_label',
    sessions: [
      {
        session_id: 's-labels',
        gold: labelGold,
        analysis: pAnalysis([pPrediction('ep1', ['correction', 'intervention'], 'u2')]),
      },
    ],
    table: [gMatch('s-labels', 'ep1', 'g1', 'correction'), gMatch('s-labels', 'ep1', 'g1', 'intervention')],
    verify: (r) => firstError(countsOk(r.micro.correction, 1, 0, 0), countsOk(r.micro.intervention, 1, 0, 0)),
  },
  {
    name: 'awaiting_review_excluded_from_denominators',
    sessions: [
      {
        session_id: 's-clean',
        gold: cleanGold,
        analysis: pAnalysis([
          pPrediction('ep1', ['correction'], 'u2'),
          pPrediction('ep2', [], 'u1', { review: ['correction'] }),
        ]),
      },
    ],
    table: [gMatch('s-clean', 'ep1', 'g1', 'correction')],
    verify: (r) =>
      firstError(
        countsOk(r.micro.correction, 1, 0, 0),
        r.totals.awaiting_review_predictions === 1 ? null : 'review-only prediction should be reported, not scored',
      ),
  },
  {
    name: 'abstention_and_unarbited_excluded',
    sessions: [
      {
        session_id: 's-abstain',
        gold: gSession('s-abstain', {
          units: [gUnit('u1'), gUnit('u2'), gUnit('u3', 'uncertain'), gUnit('u4', 'unarbited')],
        }),
        analysis: pAnalysis([], { processed_users: [
          { evidence_id: 'u1', status: 'reviewed' }, { evidence_id: 'u2', status: 'uncertain' },
          { evidence_id: 'u3', status: 'reviewed' }, { evidence_id: 'u4', status: 'reviewed' },
        ] }),
      },
    ],
    table: [],
    verify: (r) =>
      firstError(
        r.abstention.arbitrated_units === 2 ? null : `arbitrated units ${String(r.abstention.arbitrated_units)}`,
        r.abstention.rate === 0.5 ? null : `abstention rate ${String(r.abstention.rate)}`,
        r.micro.correction.precision === null ? null : 'zero denominator must be N/A, never 100%',
      ),
  },
  {
    name: 'coverage_gap_not_abstention',
    sessions: [
      {
        session_id: 's-gap',
        gold: gSession('s-gap', {
          units: [gUnit('u1'), gUnit('u2')],
          all: ['u1', 'u2', 'u3'],
        }),
        analysis: pAnalysis([], { processed_users: [
          { evidence_id: 'u1', status: 'reviewed' }, { evidence_id: 'u2', status: 'reviewed' },
        ] }),
      },
    ],
    table: [],
    verify: (r) =>
      firstError(
        r.coverage_gap_units === 1 ? null : `coverage gap ${String(r.coverage_gap_units)}`,
        r.abstention.rate === 0 ? null : 'unhandled messages must not inflate the abstention rate',
      ),
  },
  {
    name: 'failed_analysis_all_gold_fn',
    sessions: [
      {
        session_id: 's-double',
        gold: doubleGold,
        analysis: pAnalysis([], { status: 'failed' }),
      },
    ],
    table: [],
    verify: (r) =>
      firstError(
        countsOk(r.micro.correction, 0, 0, 2),
        r.per_session[0]?.status === 'failed' ? null : 'session should be reported as failed',
        r.per_session[0]?.fn_details.every((d) => d.kind === 'gold_session_failed') ? null : 'fn kind should be failed',
        r.totals.failed === 1 ? null : 'failed sessions stay in the report, never deleted',
      ),
  },
  {
    name: 'partial_coverage_still_scored_and_flagged',
    sessions: [
      {
        session_id: 's-clean',
        gold: cleanGold,
        analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')], { coverage: 'partial' }),
      },
    ],
    table: [gMatch('s-clean', 'ep1', 'g1', 'correction')],
    verify: (r) =>
      firstError(
        countsOk(r.micro.correction, 1, 0, 0),
        r.totals.partial_coverage === 1 ? null : 'partial coverage must be counted separately',
      ),
  },
  {
    name: 'exclusions_and_missing_gold',
    sessions: [
      { session_id: 's-unlabeled', gold: gSession('s-unlabeled', { labeled: false }), analysis: pAnalysis([]) },
      { session_id: 's-unused', gold: gSession('s-unused', { split: 'unused' }), analysis: pAnalysis([]) },
      { session_id: 's-nogold', analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]) },
    ],
    table: [],
    verify: (r) =>
      firstError(
        r.totals.excluded === 2 ? null : `excluded ${String(r.totals.excluded)}`,
        r.totals.missing_gold === 1 ? null : 'missing gold must be listed, not counted as a perfect run',
        countsOk(r.micro.correction, 0, 0, 0),
      ),
  },
  {
    name: 'rework_hit_false_claim_miss_and_unknown',
    sessions: [
      {
        session_id: 's-rework',
        gold: reworkGoldSession,
        analysis: pAnalysis([
          pPrediction('p1', ['correction'], 'u1', { reworkClaimed: true }),
          pPrediction('p2', ['correction'], 'u2', { reworkClaimed: true }),
          pPrediction('p3', ['correction'], 'u3', { reworkClaimed: false }),
        ]),
      },
    ],
    table: [
      gMatch('s-rework', 'p1', 'r1', 'correction'),
      gMatch('s-rework', 'p2', 'r2', 'correction'),
      gMatch('s-rework', 'p3', 'r3', 'correction'),
    ],
    verify: (r) =>
      firstError(
        countsOk(r.micro.correction, 3, 0, 2),
        countsOk(r.micro.rework, 1, 1, 2),
        r.per_session[0]?.rework_details.some((d) => d.kind === 'unknown_excluded') ? null : 'unknown rework must be reported separately',
        r.per_session[0]?.rework_details.some((d) => d.kind === 'missed_episode') ? null : 'missed gold rework must count FN',
      ),
  },
];

export const INVALID_TABLE_SCENARIOS: InvalidScenario[] = [
  {
    name: 'table_unknown_session',
    sessions: [{ session_id: 's-clean', gold: cleanGold, analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]) }],
    table: [gMatch('s-other', 'ep1', 'g1', 'correction')],
    expect: /unknown session/,
  },
  {
    name: 'table_prediction_from_other_session',
    sessions: [
      { session_id: 's-clean', gold: cleanGold, analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]) },
      { session_id: 's-double', gold: doubleGold, analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]) },
    ],
    table: [gMatch('s-double', 'ep1', 'g2', 'correction')],
    expect: /problem anchors differ/,
  },
  {
    name: 'table_awaiting_review_prediction',
    sessions: [
      {
        session_id: 's-clean',
        gold: cleanGold,
        analysis: pAnalysis([pPrediction('ep1', [], 'u2', { review: ['correction'] })]),
      },
    ],
    table: [gMatch('s-clean', 'ep1', 'g1', 'correction')],
    expect: /not a formal|awaiting-review/,
  },
  {
    name: 'table_anchor_mismatch',
    sessions: [
      {
        session_id: 's-double',
        gold: doubleGold,
        analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u3')]),
      },
    ],
    table: [gMatch('s-double', 'ep1', 'g1', 'correction')],
    expect: /problem anchors differ/,
  },
  {
    name: 'table_no_feedback_hit',
    sessions: [
      {
        session_id: 's-fb',
        gold: gSession('s-fb', {
          episodes: [gEpisode('g1', ['correction'], 'u2', { feedback: ['u2'] })],
          units: [gUnit('u1'), gUnit('u2'), gUnit('u3')],
        }),
        analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u3', { cited: ['u3'] })]),
      },
    ],
    table: [gMatch('s-fb', 'ep1', 'g1', 'correction')],
    expect: /problem anchors differ|no user-feedback/,
  },
  {
    name: 'table_breaks_one_to_one',
    sessions: [{ session_id: 's-clean', gold: cleanGold, analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]) }],
    table: [gMatch('s-clean', 'ep1', 'g1', 'correction'), gMatch('s-clean', 'ep1', 'g1', 'correction')],
    expect: /one-to-one|duplicate/,
  },
  {
    name: 'table_on_failed_analysis',
    sessions: [{ session_id: 's-clean', gold: cleanGold, analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')], { status: 'failed' }) }],
    table: [gMatch('s-clean', 'ep1', 'g1', 'correction')],
    expect: /analysis failed/,
  },
  {
    name: 'table_on_unlabeled_gold',
    sessions: [
      {
        session_id: 's-unlabeled',
        gold: gSession('s-unlabeled', { episodes: [gEpisode('g1', ['correction'], 'u2')], labeled: false }),
        analysis: pAnalysis([pPrediction('ep1', ['correction'], 'u2')]),
      },
    ],
    table: [gMatch('s-unlabeled', 'ep1', 'g1', 'correction')],
    expect: /no labeled dev\/test gold|has no labeled/,
  },
  {
    name: 'table_gold_missing_matched_label',
    sessions: [
      {
        session_id: 's-clean',
        gold: cleanGold,
        analysis: pAnalysis([pPrediction('ep1', ['correction', 'intervention'], 'u2')]),
      },
    ],
    table: [gMatch('s-clean', 'ep1', 'g1', 'intervention')],
    expect: /does not carry the label/,
  },
];

export interface ScenarioResult {
  name: string;
  ok: boolean;
  message?: string;
}

export function runScorerMatrix(): { results: ScenarioResult[]; reports: Record<string, EvalReport> } {
  const results: ScenarioResult[] = [];
  const reports: Record<string, EvalReport> = {};
  for (const scenario of SCORER_SCENARIOS) {
    try {
      const report = scoreEval(scenario.sessions, scenario.table);
      reports[scenario.name] = report;
      const message = scenario.verify(report);
      results.push(message === null ? { name: scenario.name, ok: true } : { name: scenario.name, ok: false, message });
    } catch (error) {
      results.push({ name: scenario.name, ok: false, message: `unexpected throw: ${String(error)}` });
    }
  }
  for (const scenario of INVALID_TABLE_SCENARIOS) {
    try {
      scoreEval(scenario.sessions, scenario.table);
      results.push({ name: scenario.name, ok: false, message: 'invalid match table was accepted' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(
        scenario.expect.test(message)
          ? { name: scenario.name, ok: true }
          : { name: scenario.name, ok: false, message: `rejected for the wrong reason: ${message}` },
      );
    }
  }
  return { results, reports };
}

function buildReplaySubmission(packet: PreparePacket): string {
  const anchorEntry = packet.user_coverage[0];
  const anchorItem = anchorEntry === undefined ? undefined : packet.evidence.find((e) => e.id === anchorEntry.evidence_id);
  if (anchorItem === undefined) {
    throw new ScaError('schema_invalid', 'replay fixture must contain at least one user message');
  }
  const assistant = packet.evidence.find((e) => e.kind === 'assistant_text');
  if (assistant === undefined) {
    throw new ScaError('schema_invalid', 'replay fixture must contain an assistant reply');
  }
  return JSON.stringify({
    processed_users: packet.user_coverage.map((entry) => ({ evidence_id: entry.evidence_id, status: 'reviewed' })),
    episodes: [
      {
        anchor_event_id: anchorItem.id,
        issue_anchor: '离线回放：对照范围错误',
        correction: {
          detected: true,
          subtype: 'wrong_scope',
          confidence: 'high',
          prior_agent_behavior: [],
          agent_behavior_after: [assistant.id],
          explanation: '离线回放固定输出：用户纠正后行为改变。',
        },
        intervention: { detected: false, confidence: 'medium', evidence: [], explanation: '无执行介入。' },
        citations: [{ evidence_id: anchorItem.id, quote: anchorItem.excerpt.slice(0, 6) }],
      },
    ],
    candidates: [],
  });
}

export interface ReplayOutcome {
  ok: boolean;
  message?: string;
  record_id: string;
  report?: EvalReport;
}

/** register → prepare → fixed submission → ingest → gold-vs-prediction scoring, in a throwaway root. */
export async function runOfflineReplay(root: string): Promise<ReplayOutcome> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-eval-ws-'));
  try {
    const repo = new RecordRepository(root);
    const { recordId } = await repo.register({
      host: 'codex',
      canonicalWorkspace: '/repo/dpp_v3',
      sessionId: 'thr_fixture_1',
      transcriptPath: CODEX_FIXTURE,
      trigger: 'manual_skill',
      analyzerVersion: '0.1.0',
    });
    const { packet } = await prepareRecord(repo, recordId, { owner: 'offline-eval', ruleVersion: '0.1.0' });

    const worksheet = buildWorksheet(packet, 'dev');
    const worksheetCheck =
      worksheet.units.length === packet.user_coverage.length &&
      worksheet.units.every((unit) => unit.status === 'unarbited') &&
      !worksheet.labeled
        ? null
        : 'worksheet must mirror the frozen coverage list as unlabeled units';
    let draftRejected = false;
    try {
      assertLabeledForScoring(worksheet);
    } catch (error) {
      draftRejected = error instanceof ScaError;
    }
    if (worksheetCheck !== null || !draftRejected) {
      return {
        ok: false,
        message: worksheetCheck ?? 'unlabeled worksheet must be rejected for scoring',
        record_id: recordId,
      };
    }

    const manifest = await ingestSubmission(repo, recordId, packet.run_id, buildReplaySubmission(packet), 'offline-eval');
    const { doc: analyzeDoc } = await repo.loadAnalyze(recordId);
    const episodes = analyzeDoc.facts?.episodes ?? [];
    const predictions = predictionsFromEpisodes(episodes);
    const prediction = predictions[0];
    if (prediction === undefined || manifest.episode_ids.length !== 1) {
      return { ok: false, message: 'replay ingest committed no prediction', record_id: recordId };
    }
    const gold = gSession(recordId, {
      episodes: [gEpisode('gold-1', ['correction'], prediction.anchor_evidence_id)],
      units: packet.user_coverage.map((entry) => gUnit(entry.evidence_id)),
      all: packet.user_coverage.map((entry) => entry.evidence_id),
    });
    const report = scoreEval(
      [{ session_id: recordId, gold, analysis: pAnalysis(predictions, { processed_users: analyzeDoc.facts?.processed_users }) }],
      [gMatch(recordId, prediction.id, 'gold-1', 'correction')],
    );
    const message = countsOk(report.micro.correction, 1, 0, 0);
    return message === null ? { ok: true, record_id: recordId, report } : { ok: false, message, record_id: recordId };
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
}

interface CliArgs {
  detailsOut?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--details-out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ScaError('schema_invalid', '--details-out needs a directory');
      }
      out.detailsOut = value;
      i += 1;
    } else {
      throw new ScaError('schema_invalid', `unknown argument ${String(arg)}`);
    }
  }
  return out;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof ScaError ? error.message : String(error)}\n`);
    return 2;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-eval-'));
  try {
    const { results, reports } = runScorerMatrix();
    const replay = await runOfflineReplay(root);
    const failed = results.filter((result) => !result.ok);
    if (!replay.ok) {
      failed.push({ name: 'end_to_end_replay', ok: false, message: replay.message ?? 'replay failed' });
    }
    const summary = {
      kind: 'offline_evaluation_engineering_check',
      note: 'fixed synthetic inputs only; this does NOT measure model semantic quality (plan 2.3)',
      rule_version: '0.1.0',
      scenarios: results.length + 1,
      passed: results.length + 1 - failed.length,
      failed: failed.map((f) => ({ name: f.name, message: f.message })),
      replay_correction_counts: replay.report?.micro.correction ?? null,
      ok: failed.length === 0,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (args.detailsOut !== undefined) {
      await fs.mkdir(args.detailsOut, { recursive: true });
      await fs.writeFile(
        path.join(args.detailsOut, 'offline-report.json'),
        JSON.stringify({ scenarios: reports, replay: replay.report ?? null }, null, 2),
      );
    }
    return failed.length === 0 ? 0 : 1;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await main();
}
