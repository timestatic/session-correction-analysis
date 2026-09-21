import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { buildPacket } from '../../../src/analysis/prepare.js';
import { ScaError } from '../../../src/domain/errors.js';
import { GOLD_SCHEMA, goldSessionSchema } from '../../../src/eval/gold.js';
import { runOfflineReplay } from '../../../src/eval/offline.js';
import { assertLabeledForScoring, buildWorksheet } from '../../../src/eval/worksheet.js';

const REPO = path.join(import.meta.dirname, '../../../..');
const CODEX_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'codex', 'basic.jsonl');

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function packet() {
  return buildPacket({
    recordId: 'rec-worksheet-1',
    runId: 'run-worksheet-1',
    analysisId: 'analysis-worksheet-1',
    transcriptPath: CODEX_FIXTURE,
    ruleVersion: '0.1.0',
  });
}

describe('annotation worksheet (plan 2.2)', () => {
  it('mirrors the frozen coverage list as unlabeled units with aids, versions pinned', async () => {
    const p = await packet();
    const worksheet = buildWorksheet(p, 'dev');
    assert.equal(worksheet.labeled, false);
    assert.equal(worksheet.session_id, p.record_id);
    assert.equal(worksheet.source_fingerprint, p.snapshot.source_fingerprint);
    assert.equal(worksheet.parser_version, p.snapshot.parser_version);
    assert.equal(worksheet.rule_version, p.rule_version);
    assert.equal(worksheet.units.length, p.user_coverage.length);
    assert.deepEqual(
      worksheet.all_user_evidence_ids,
      p.user_coverage.map((entry) => entry.evidence_id),
    );
    for (const unit of worksheet.units) {
      assert.equal(unit.status, 'unarbited');
      assert.ok(unit.excerpt && unit.excerpt.length > 0);
    }
  });

  it('refuses to treat a draft worksheet as scoreable gold', async () => {
    const worksheet = buildWorksheet(await packet(), 'dev');
    assert.throws(() => assertLabeledForScoring(worksheet), ScaError);
  });
});

describe('gold schema', () => {
  const unit = (evidenceId: string) => ({ evidence_id: evidenceId, event_id: `x-${evidenceId}`, status: 'arbitrated' });

  it('rejects units that are not user messages of the frozen packet', () => {
    const parsed = goldSessionSchema.safeParse({
      schema: GOLD_SCHEMA,
      session_id: 's1',
      host: 'codex',
      source_fingerprint: `sha256:${'1'.repeat(64)}`,
      parser_version: 'p',
      rule_version: 'r',
      split: 'dev',
      labeled: true,
      all_user_evidence_ids: ['u1'],
      units: [unit('u9')],
      episodes: [],
    });
    assert.equal(parsed.success, false);
  });

  it('rejects duplicate units, duplicate episodes and an anchor outside the feedback set', () => {
    const dupUnits = goldSessionSchema.safeParse({
      schema: GOLD_SCHEMA,
      session_id: 's1',
      host: 'codex',
      source_fingerprint: `sha256:${'1'.repeat(64)}`,
      parser_version: 'p',
      rule_version: 'r',
      split: 'dev',
      labeled: true,
      all_user_evidence_ids: ['u1', 'u2'],
      units: [unit('u1'), unit('u1')],
      episodes: [],
    });
    assert.equal(dupUnits.success, false);

    const episode = {
      id: 'g1',
      labels: ['correction'],
      anchor_evidence_id: 'u2',
      feedback_evidence_ids: ['u1'],
      rework: 'unknown',
      rework_judgeable: false,
      rationale: 'x',
    };
    const dupEpisode = goldSessionSchema.safeParse({
      schema: GOLD_SCHEMA,
      session_id: 's1',
      host: 'codex',
      source_fingerprint: `sha256:${'1'.repeat(64)}`,
      parser_version: 'p',
      rule_version: 'r',
      split: 'dev',
      labeled: true,
      all_user_evidence_ids: ['u1', 'u2'],
      units: [unit('u1'), unit('u2')],
      episodes: [episode, episode],
    });
    assert.equal(dupEpisode.success, false);
  });

  it('a labeled gold may list fewer units than the packet — the difference is coverage gap, not schema violation', () => {
    const parsed = goldSessionSchema.safeParse({
      schema: GOLD_SCHEMA,
      session_id: 's1',
      host: 'codex',
      source_fingerprint: `sha256:${'1'.repeat(64)}`,
      parser_version: 'p',
      rule_version: 'r',
      split: 'test',
      labeled: true,
      all_user_evidence_ids: ['u1', 'u2', 'u3'],
      units: [unit('u1')],
      episodes: [],
    });
    assert.equal(parsed.success, true);
  });
});

describe('offline end-to-end replay (state machine + scorer)', () => {
  it('register → prepare → worksheet → fixed submission → ingest → scores tp=1', async () => {
    const root = await tempDir('sca-offline-replay-');
    const outcome = await runOfflineReplay(root);
    assert.equal(outcome.message, undefined);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.report?.micro.correction.tp, 1);
    assert.equal(outcome.report?.micro.correction.fp, 0);
  });
});
