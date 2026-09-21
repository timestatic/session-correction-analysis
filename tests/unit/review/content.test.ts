import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { makeCandidate } from '../domain/helpers.js';
import { RecordRepository } from '../../../src/store/repository.js';
import { applyDecision } from '../../../src/review/decide.js';
import { candidateContent } from '../../../src/review/content.js';
import { candidateDetail } from '../../../src/review/detail.js';

for (const kind of ['memory', 'harness'] as const) {
  it(`${kind}: portable text, current approval, exclusive concurrent export and no state mutation`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sca-content-'));
    try {
      const repo = new RecordRepository(root);
      const { recordId } = await repo.register({ host: 'codex', canonicalWorkspace: root, sessionId: 'content',
        transcriptPath: path.join(root, 'explicit.jsonl'), trigger: 'manual_skill', analyzerVersion: 'test' });
      await repo.updateCandidates(recordId, await repo.loadCandidates(recordId), doc => ({ ...doc, candidates: [makeCandidate({
        target: { kind }, applicable_scope: '本项目', trigger_condition: '修改之前', exceptions: '只读检查', not_applicable: '新需求',
      })] }));
      const detail = await candidateDetail(repo, recordId, 'learning-001');
      assert.equal(detail.provenance.status, 'unavailable');
      assert.ok(detail.provenance.missing_ids.length > 0);
      await assert.rejects(candidateDetail(repo, recordId, 'missing'), /does not exist/);
      await assert.rejects(candidateContent(repo, recordId, 'learning-001', 'copy_content'), /approve/);
      const decide = async (action: 'approve' | 'revoke' | 'edit_content', content?: string) => applyDecision(repo, recordId, {
        candidate_id: 'learning-001', action, request_id: `${action}-${String((await repo.loadCandidates(recordId)).doc.revision)}`,
        expected_revision: (await repo.loadCandidates(recordId)).doc.revision, ...(content === undefined ? {} : { content }),
      });
      await decide('approve');
      const before = await repo.loadCandidates(recordId);
      const copy = await candidateContent(repo, recordId, 'learning-001', 'copy_content');
      for (const title of ['规则正文', '适用范围', '触发条件', '例外', '不适用场景', '来源摘要']) assert.ok(copy.content.includes(`## ${title}`));
      assert.ok(!copy.content.includes(root));
      assert.ok(!copy.content.includes('correction-001'));
      const outPath = path.join(root, 'output', 'rule.md');
      const results = await Promise.allSettled([1, 2].map(() => candidateContent(repo, recordId, 'learning-001', 'export_content', { outPath })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected').length, 1);
      assert.equal(await fs.readFile(outPath, 'utf8'), copy.content);
      assert.deepEqual(await fs.readdir(path.dirname(outPath)), ['rule.md']);
      assert.deepEqual(await repo.loadCandidates(recordId), before);
      await decide('edit_content', '更新后的规则');
      await assert.rejects(candidateContent(repo, recordId, 'learning-001', 'copy_content'), /approve/);
      await decide('approve');
      await repo.updateCandidates(recordId, await repo.loadCandidates(recordId), doc => ({ ...doc,
        candidates: doc.candidates.map(candidate => ({ ...candidate, proposed_content: '手工改动但保留旧批准' })),
      }));
      await assert.rejects(candidateContent(repo, recordId, 'learning-001', 'copy_content'), /approve/);
      await decide('revoke');
      await assert.rejects(candidateContent(repo, recordId, 'learning-001', 'copy_content'), /approve/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
