import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { sha256Tag } from '../../../src/domain/hash.js';
import { applyDecision } from '../../../src/review/decide.js';
import { publishCandidate, setPublishCrashHook } from '../../../src/publish/publish.js';
import { readReceipt, reconcileReceipts, receiptsDir } from '../../../src/publish/receipt.js';
import { scenario, tempDirs } from '../publish/fixtures.js';

after(async () => {
  setPublishCrashHook(undefined);
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('publish crash hook (T14 injection point)', () => {
  it('fires at each boundary and is cleared afterwards', async () => {
    const sc = await scenario('crash-hook-1');
    const seen: string[] = [];
    setPublishCrashHook((point) => {
      seen.push(point);
    });
    const outcome = await publishCandidate(sc.repo, sc.recordId, {
      candidate_id: 'learning-001',
      preview_id: sc.preview.preview.preview_id,
      expected_revision: sc.revision,
    });
    setPublishCrashHook(undefined);
    assert.equal(outcome.phase, 'published');
    assert.deepEqual(seen, ['before_target', 'after_target', 'after_state']);
    const replay = await publishCandidate(sc.repo, sc.recordId, {
      candidate_id: 'learning-001',
      preview_id: sc.preview.preview.preview_id,
      expected_revision: sc.revision,
    });
    assert.equal(replay.already_published, true);
    assert.equal(replay.revision, outcome.revision);
  });

  it('a mid-flight abort leaves a durable receipt and untouched candidate state', async () => {
    const sc = await scenario('crash-hook-2');
    setPublishCrashHook((point) => {
      if (point === 'before_target') {
        throw new Error('simulated crash');
      }
    });
    await assert.rejects(
      () => publishCandidate(sc.repo, sc.recordId, {
        candidate_id: 'learning-001',
        preview_id: sc.preview.preview.preview_id,
        expected_revision: sc.revision,
      }),
      /simulated crash/,
    );
    setPublishCrashHook(undefined);

    const files = (await fs.readdir(receiptsDir(sc.repo.paths))).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const receipt = await readReceipt(sc.repo.paths, path.basename(files[0] as string, '.json'));
    assert.equal(receipt.record_id, sc.recordId);
    assert.equal(receipt.candidate_id, 'learning-001');
    assert.equal(receipt.target_written, false);
    assert.equal(receipt.hash_before, sc.preview.preview.hash_before);
    assert.equal(receipt.hash_after_expected, sc.preview.preview.hash_after);
    assert.equal(receipt.realpath, sc.preview.preview.realpath);

    // The crash never touched the target file or the candidate.
    assert.equal(sha256Tag(await fs.readFile(sc.agents, 'utf8')), sc.preview.preview.hash_before);
    const doc = (await sc.repo.loadCandidates(sc.recordId)).doc;
    assert.equal(doc.revision, sc.revision);
    assert.equal(doc.candidates[0]?.status, 'approved');
  });

  it('a successful publish deletes its receipt', async () => {
    const sc = await scenario('crash-hook-3');
    await publishCandidate(sc.repo, sc.recordId, {
      candidate_id: 'learning-001',
      preview_id: sc.preview.preview.preview_id,
      expected_revision: sc.revision,
    });
    const files = await fs.readdir(receiptsDir(sc.repo.paths));
    assert.deepEqual(files.filter((f) => f.endsWith('.json')), []);
  });
});

describe('reconcileReceipts (design 15 step 8, per-target recovery)', () => {
  /** Leave a receipt behind as if the process died right at the boundary. */
  async function crashAt(sc: Awaited<ReturnType<typeof scenario>>, point: 'before_target' | 'after_target'): Promise<void> {
    setPublishCrashHook((p) => {
      if (p === point) {
        throw new Error('simulated crash');
      }
    });
    await assert.rejects(
      () => publishCandidate(sc.repo, sc.recordId, {
        candidate_id: 'learning-001',
        preview_id: sc.preview.preview.preview_id,
        expected_revision: sc.revision,
      }),
      /simulated crash/,
    );
    setPublishCrashHook(undefined);
  }

  it('target already carries the rule: converges to published without rewriting', async () => {
    const sc = await scenario('reconcile-1');
    await crashAt(sc, 'after_target');
    // after_target abort happens right after the write landed.
    assert.equal(sha256Tag(await fs.readFile(sc.agents, 'utf8')), sc.preview.preview.hash_after);

    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.outcome, 'converged');
    assert.equal((await fs.readFile(sc.agents, 'utf8')).includes('candidate learning-001'), true);
    const doc = (await sc.repo.loadCandidates(sc.recordId)).doc;
    assert.equal(doc.candidates[0]?.status, 'published');
    assert.equal(doc.candidates[0]?.publication.published, true);
    assert.equal(doc.revision, sc.revision + 1);
    assert.deepEqual((await fs.readdir(receiptsDir(sc.repo.paths))).filter((f) => f.endsWith('.json')), []);
  });

  it('write never landed: clears the receipt, state untouched, retry succeeds once', async () => {
    const sc = await scenario('reconcile-2');
    await crashAt(sc, 'before_target');
    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports[0]?.outcome, 'retryable');
    const before = await sc.repo.loadCandidates(sc.recordId);
    assert.equal(before.doc.revision, sc.revision);
    assert.equal(before.doc.candidates[0]?.status, 'approved');
    assert.deepEqual((await fs.readdir(receiptsDir(sc.repo.paths))).filter((f) => f.endsWith('.json')), []);

    const outcome = await publishCandidate(sc.repo, sc.recordId, {
      candidate_id: 'learning-001',
      preview_id: sc.preview.preview.preview_id,
      expected_revision: sc.revision,
    });
    assert.equal(outcome.phase, 'published');
    const text = await fs.readFile(sc.agents, 'utf8');
    assert.equal(text.split('### candidate learning-001').length - 1, 1);
  });

  it('human edited the target after the write: records in-doubt, keeps receipt and file, never rewrites', async () => {
    const sc = await scenario('reconcile-3');
    await crashAt(sc, 'after_target');
    const edited = `${await fs.readFile(sc.agents, 'utf8')}\n> 人工在崩溃窗口里追加的批注\n`;
    await fs.writeFile(sc.agents, edited, 'utf8');
    const unknown = sha256Tag(edited);
    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports[0]?.outcome, 'needs_reconciliation');
    const doc = (await sc.repo.loadCandidates(sc.recordId)).doc;
    assert.equal(doc.candidates[0]?.status, 'publish_failed');
    assert.equal(doc.candidates[0]?.publication.error?.code, 'publication_in_doubt');
    assert.equal(doc.candidates[0]?.publication.attempts.at(-1)?.targets.at(-1)?.hash_after_actual, unknown);
    assert.equal((await fs.readdir(receiptsDir(sc.repo.paths))).filter((f) => f.endsWith('.json')).length, 1);
    assert.equal(await fs.readFile(sc.agents, 'utf8'), edited);
  });

  it('approval revoked after the write: never publishes behind the user', async () => {
    const sc = await scenario('reconcile-4');
    await crashAt(sc, 'after_target');
    await applyDecision(sc.repo, sc.recordId, {
      request_id: 'revoke-1',
      candidate_id: 'learning-001',
      action: 'revoke',
      expected_revision: sc.revision,
    });
    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports[0]?.outcome, 'needs_review');
    const doc = (await sc.repo.loadCandidates(sc.recordId)).doc;
    assert.equal(doc.candidates[0]?.status, 'proposed');
    assert.equal((await fs.readdir(receiptsDir(sc.repo.paths))).filter((f) => f.endsWith('.json')).length, 1);
  });

  it('published candidate with a leftover receipt: residue cleared, zero state churn', async () => {
    const sc = await scenario('reconcile-5');
    setPublishCrashHook((p) => {
      if (p === 'after_state') {
        throw new Error('simulated crash');
      }
    });
    await assert.rejects(
      () => publishCandidate(sc.repo, sc.recordId, {
        candidate_id: 'learning-001',
        preview_id: sc.preview.preview.preview_id,
        expected_revision: sc.revision,
      }),
      /simulated crash/,
    );
    setPublishCrashHook(undefined);
    const doc = (await sc.repo.loadCandidates(sc.recordId)).doc;
    assert.equal(doc.candidates[0]?.status, 'published');
    assert.equal(doc.revision, sc.revision + 1);

    const reports = await reconcileReceipts(sc.repo, sc.recordId);
    assert.equal(reports[0]?.outcome, 'residue_cleared');
    const after = await sc.repo.loadCandidates(sc.recordId);
    assert.equal(after.doc.revision, doc.revision);
    assert.deepEqual((await fs.readdir(receiptsDir(sc.repo.paths))).filter((f) => f.endsWith('.json')), []);
  });

  it('unknown record or absent receipt directory reports nothing', async () => {
    const sc = await scenario('reconcile-6');
    assert.deepEqual(await reconcileReceipts(sc.repo, '0'.repeat(64)), []);
  });
});
