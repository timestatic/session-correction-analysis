import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { candidateSchema, type Candidate } from '../../../src/domain/candidates.js';
import { ScaError } from '../../../src/domain/errors.js';
import { sha256Tag } from '../../../src/domain/hash.js';
import { applyDecision, type DecisionRequest } from '../../../src/review/decide.js';
import { approvalMetrics } from '../../../src/review/metrics.js';
import { MANAGED_END, MANAGED_START, applyRule, lineDiff, ruleBlock } from '../../../src/publish/harness.js';
import { createPreview, previewExpired } from '../../../src/publish/preview.js';
import { publishCandidate } from '../../../src/publish/publish.js';
import { memoryContent, renderMemoryContent } from '../../../src/publish/memory.js';
import { addTarget, loadTargetConfig, removeTarget, resolveTarget } from '../../../src/publish/targets.js';
import { runCli, type CliIo } from '../../../src/cli.js';
import { RecordRepository } from '../../../src/store/repository.js';

const REPO = path.join(import.meta.dirname, '../../../..');
const CODEX_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'codex', 'basic.jsonl');
const NOW = '2026-01-01T00:00:00.000Z';

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

function mkCandidate(id: string, overrides: Record<string, unknown> = {}): Candidate {
  return candidateSchema.parse({
    id,
    fingerprint: sha256Tag(`fp-${id}`),
    category: 'process',
    title: `candidate ${id}`,
    confidence: 'high',
    status: 'proposed',
    maturity: 'single_session',
    target: { kind: 'harness' },
    evidence: [`ev-${'a'.repeat(16)}`],
    source_episodes: [`ev-${'b'.repeat(16)}`],
    proposed_content: `content of ${id} v1`,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

async function seeded(...candidates: Candidate[]): Promise<{ repo: RecordRepository; recordId: string }> {
  const root = await tempDir('sca-pub-');
  const ws = await tempDir('sca-pub-ws-');
  const repo = new RecordRepository(root);
  const { recordId } = await repo.register({
    host: 'codex',
    canonicalWorkspace: ws,
    sessionId: 'publish-session-1',
    transcriptPath: CODEX_FIXTURE,
    trigger: 'manual_skill',
    analyzerVersion: '0.1.0',
  });
  const current = await repo.loadCandidates(recordId);
  await repo.updateCandidates(recordId, current, (doc) => ({ ...doc, candidates }));
  return { repo, recordId };
}

async function revision(repo: RecordRepository, recordId: string): Promise<number> {
  return (await repo.loadCandidates(recordId)).doc.revision;
}

async function approve(repo: RecordRepository, recordId: string, candidateId: string): Promise<number> {
  const out = await applyDecision(repo, recordId, {
    request_id: `approve-${candidateId}`,
    candidate_id: candidateId,
    action: 'approve',
    expected_revision: await revision(repo, recordId),
  } satisfies DecisionRequest);
  return out.revision;
}

// ---------------------------------------------------------------------------

describe('managed region and diff (design 14.1)', () => {
  it('creates the region on a fresh file and inserts into an existing one', () => {
    const block = ruleBlock({ title: '先跑测试', proposed_content: '修改任何模块前必须先跑其单元测试。' });
    const fresh = applyRule('# Project\n\n正文。\n', block);
    assert.ok(fresh.after.includes(MANAGED_START));
    assert.ok(fresh.after.includes(MANAGED_END));
    assert.ok(fresh.after.indexOf(block) < fresh.after.indexOf(MANAGED_END));
    assert.ok(fresh.after.startsWith('# Project\n'));

    const again = applyRule(fresh.after, block);
    assert.equal(again.duplicate, true);
    assert.equal(again.after, fresh.after);

    const second = applyRule(fresh.after, ruleBlock({ title: '第二条', proposed_content: '另一条规则' }));
    assert.equal(second.duplicate, false);
    assert.ok(second.after.includes('第二条'));
    assert.ok(second.after.startsWith('# Project\n'));
    assert.equal(second.after.split(MANAGED_START).length - 1, 1);
  });

  it('refuses malformed marker regions instead of guessing', () => {
    const broken = `${MANAGED_START}\n${MANAGED_START}\nx\n${MANAGED_END}\n`;
    assert.throws(() => applyRule(broken, 'rule'), (err: unknown) => err instanceof ScaError && err.code === 'unsupported_operation');
  });

  it('lineDiff yields one exact hunk and empty for no change', () => {
    const before = 'a\nb\nc\n';
    const afterText = 'a\nb\nNEW\nNEW2\nc\n';
    const diff = lineDiff(before, afterText);
    assert.ok(diff.startsWith('@@ '));
    assert.ok(diff.includes('+NEW'));
    assert.ok(!diff.includes('-NEW'));
    assert.equal(lineDiff(before, before), '');
  });
});

describe('publish whitelist config (design 26.2)', () => {
  it('starts empty, adds, resolves by id/path/display, removes', async () => {
    const { repo } = await seeded();
    const paths = repo.paths;
    const targetRoot = await fs.realpath(await tempDir('sca-target-'));
    const agents = path.join(targetRoot, 'AGENTS.md');
    await fs.writeFile(agents, '# Project AGENTS\n', 'utf8');

    await assert.rejects(
      () => resolveTarget(paths, { path: agents }),
      (err: unknown) => err instanceof ScaError && err.code === 'target_not_allowed' && /no publish targets/.test(err.message),
    );

    const entry = await addTarget(paths, { filePath: agents });
    assert.equal(entry.target_id, 'target-AGENTS'.toLowerCase());
    const config = await loadTargetConfig(paths);
    assert.equal(config.targets.length, 1);

    // Idempotent re-add returns the same entry, not a second one.
    const same = await addTarget(paths, { filePath: agents });
    assert.deepEqual(same, entry);
    assert.equal((await loadTargetConfig(paths)).targets.length, 1);

    assert.equal((await resolveTarget(paths, { targetId: entry.target_id })).realpath, entry.realpath);
    assert.equal((await resolveTarget(paths, { path: agents })).target_id, entry.target_id);
    assert.equal((await resolveTarget(paths, { path: 'AGENTS.md' })).target_id, entry.target_id);
    await assert.rejects(
      () => resolveTarget(paths, { path: path.join(targetRoot, 'OTHER.md') }),
      (err: unknown) => err instanceof ScaError && err.code === 'target_not_allowed' && /outside the publish whitelist/.test(err.message),
    );

    const removed = await removeTarget(paths, entry.target_id);
    assert.equal(removed.target_id, entry.target_id);
    assert.equal((await loadTargetConfig(paths)).targets.length, 0);
  });
});

describe('preview → publish → readback', () => {
  async function scenario(): Promise<{
    repo: RecordRepository;
    recordId: string;
    agents: string;
    revision: number;
  }> {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    const targetRoot = await fs.realpath(await tempDir('sca-target-'));
    const agents = path.join(targetRoot, 'AGENTS.md');
    await fs.writeFile(agents, '# Project AGENTS\n', 'utf8');
    await addTarget(repo.paths, { filePath: agents });
    const revision = await approve(repo, recordId, 'learning-001');
    return { repo, recordId, agents, revision };
  }

  it('publishes an approved candidate with a verified readback receipt', async () => {
    const { repo, recordId, agents, revision } = await scenario();
    const { preview } = await createPreview(repo, recordId, { candidateId: 'learning-001' });
    assert.ok(preview.diff.includes('+### candidate learning-001'));
    assert.equal(preview.publish_mode, 'deterministic');

    const outcome = await publishCandidate(repo, recordId, {
      candidate_id: 'learning-001',
      preview_id: preview.preview_id,
      expected_revision: revision,
    });
    assert.equal(outcome.phase, 'published');
    const file = await fs.readFile(agents, 'utf8');
    assert.ok(file.startsWith('# Project AGENTS\n'));
    assert.ok(file.includes(MANAGED_START));
    assert.ok(file.includes('content of learning-001 v1'));
    assert.equal(sha256Tag(file), preview.hash_after);

    const doc = (await repo.loadCandidates(recordId)).doc;
    const candidate = doc.candidates.find((c) => c.id === 'learning-001');
    assert.equal(candidate?.status, 'published');
    assert.equal(candidate?.publication.published, true);
    const attempt = candidate?.publication.attempts.at(-1);
    assert.equal(attempt?.phase, 'done');
    assert.equal(attempt?.targets[0]?.status, 'verified');
    assert.equal(attempt?.targets[0]?.hash_after_actual, attempt?.targets[0]?.hash_after_expected);
    assert.equal(approvalMetrics(doc.candidates).published, 1);

    // Repeat commit replays the existing receipt and never re-inserts the rule.
    const replay = await publishCandidate(repo, recordId, {
      candidate_id: 'learning-001',
      preview_id: preview.preview_id,
      expected_revision: doc.revision,
    });
    assert.equal(replay.already_published, true);
    const after = await fs.readFile(agents, 'utf8');
    assert.equal(after.split('### candidate learning-001').length - 1, 1);
    assert.equal(after, file);
  });

  it('refuses unapproved candidates and non-whitelisted targets fail closed', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001'));
    await assert.rejects(
      () => createPreview(repo, recordId, { candidateId: 'learning-001' }),
      (err: unknown) => err instanceof ScaError && err.code === 'approval_missing',
    );
    const approved = await approve(repo, recordId, 'learning-001');
    assert.ok(approved > 0);
    // Still no whitelist entries at all → target_not_allowed (fresh repo without add).
    await assert.rejects(
      () => createPreview(repo, recordId, { candidateId: 'learning-001' }),
      (err: unknown) => err instanceof ScaError && err.code === 'target_not_allowed',
    );
  });

  it('external target edits after preview block publication (target_changed)', async () => {
    const { repo, recordId, agents, revision } = await scenario();
    const { preview } = await createPreview(repo, recordId, { candidateId: 'learning-001' });
    await fs.writeFile(agents, '# Project AGENTS\n\n人工在预览后追加的内容。\n', 'utf8');
    const before = await fs.readFile(agents, 'utf8');
    await assert.rejects(
      () =>
        publishCandidate(repo, recordId, {
          candidate_id: 'learning-001',
          preview_id: preview.preview_id,
          expected_revision: revision,
        }),
      (err: unknown) => err instanceof ScaError && err.code === 'target_changed',
    );
    assert.equal(await fs.readFile(agents, 'utf8'), before);
    const doc = (await repo.loadCandidates(recordId)).doc;
    assert.equal(doc.candidates[0]?.status, 'approved');
    assert.equal(doc.revision, revision);
  });

  it('content edits after preview invalidate it via the approval check', async () => {
    const { repo, recordId, agents, revision } = await scenario();
    const { preview } = await createPreview(repo, recordId, { candidateId: 'learning-001' });
    const edited = await applyDecision(repo, recordId, {
      request_id: 'edit-post-preview',
      candidate_id: 'learning-001',
      action: 'edit_content',
      expected_revision: revision,
      content: '修订后的规则正文',
    });
    assert.equal(edited.candidate.status, 'proposed');
    await assert.rejects(
      () =>
        publishCandidate(repo, recordId, {
          candidate_id: 'learning-001',
          preview_id: preview.preview_id,
          expected_revision: edited.revision,
        }),
      (err: unknown) => err instanceof ScaError && err.code === 'approval_missing',
    );
    assert.equal(await fs.readFile(agents, 'utf8'), '# Project AGENTS\n');
  });

  it('expired previews and stale revisions are rejected without writes', async () => {
    const { repo, recordId, agents, revision } = await scenario();
    const base = new Date('2026-02-01T00:00:00.000Z');
    const { preview } = await createPreview(repo, recordId, { candidateId: 'learning-001', now: base, ttlMs: 1000 });
    assert.equal(previewExpired(preview, new Date(base.getTime() + 2000)), true);
    await assert.rejects(
      () =>
        publishCandidate(
          repo,
          recordId,
          { candidate_id: 'learning-001', preview_id: preview.preview_id, expected_revision: revision },
          { now: new Date(base.getTime() + 2000) },
        ),
      (err: unknown) => err instanceof ScaError && err.code === 'preview_expired',
    );

    const fresh = await createPreview(repo, recordId, { candidateId: 'learning-001' });
    await assert.rejects(
      () =>
        publishCandidate(repo, recordId, {
          candidate_id: 'learning-001',
          preview_id: fresh.preview.preview_id,
          expected_revision: revision + 5,
        }),
      (err: unknown) => err instanceof ScaError && err.code === 'revision_conflict',
    );
    assert.equal(await fs.readFile(agents, 'utf8'), '# Project AGENTS\n');
  });

  it('duplicate rule text publishes as unchanged without touching state', async () => {
    const twin = mkCandidate('learning-002', {
      title: 'candidate learning-001',
      proposed_content: 'content of learning-001 v1',
    });
    const { repo, recordId, agents } = await scenario();
    const loaded = await repo.loadCandidates(recordId);
    await repo.updateCandidates(recordId, loaded, (doc) => ({
      ...doc,
      candidates: [...doc.candidates, twin],
    }));
    await publishCandidate(repo, recordId, {
      candidate_id: 'learning-001',
      ...{ preview_id: (await createPreview(repo, recordId, { candidateId: 'learning-001' })).preview.preview_id },
      expected_revision: await revision(repo, recordId),
    });
    const rev2 = await approve(repo, recordId, 'learning-002');
    const preview2 = (await createPreview(repo, recordId, { candidateId: 'learning-002' })).preview;
    const outcome = await publishCandidate(repo, recordId, {
      candidate_id: 'learning-002',
      preview_id: preview2.preview_id,
      expected_revision: rev2,
    });
    assert.equal(outcome.phase, 'unchanged');
    const doc = (await repo.loadCandidates(recordId)).doc;
    assert.equal(doc.candidates.find((c) => c.id === 'learning-002')?.status, 'approved');
    const file = await fs.readFile(agents, 'utf8');
    assert.equal(file.split('### candidate learning-001').length - 1, 1);
  });
});

describe('memory content surface (design 26.4, no sink)', () => {
  async function memoryScenario(): Promise<{ repo: RecordRepository; recordId: string; outDir: string }> {
    const { repo, recordId } = await seeded(
      mkCandidate('learning-001', {
        target: { kind: 'memory', scope: 'project' },
        applicable_scope: '本仓库所有 TS 模块',
        trigger_condition: '修改领域层之前',
        exceptions: '只读脚本可跳过',
      }),
    );
    await approve(repo, recordId, 'learning-001');
    return { repo, recordId, outDir: await tempDir('sca-mem-out-') };
  }

  it('renders portable markdown with the six required parts and no private paths', async () => {
    const { repo, recordId, outDir } = await memoryScenario();
    const copy = await memoryContent(repo, recordId, 'learning-001', 'copy_content');
    for (const section of ['# candidate learning-001', '## 规则正文', '## 适用范围', '## 触发条件', '## 例外', '## 来源摘要']) {
      assert.ok(copy.content.includes(section), `missing ${section}`);
    }
    assert.ok(!copy.content.includes(outDir));
    assert.ok(!copy.content.includes(repo.paths.root));
    assert.ok(!/\/Users\/|\/home\/|\/private\/|\/var\//.test(copy.content));
  });

  it('exports to a chosen path, refuses silent overwrite, and never touches approval state', async () => {
    const { repo, recordId, outDir } = await memoryScenario();
    const out = path.join(outDir, 'rules', 'rule.md');
    const before = await repo.loadCandidates(recordId);
    const first = await memoryContent(repo, recordId, 'learning-001', 'export_content', { outPath: out });
    assert.equal(first.exported_to, out);
    assert.equal(await fs.readFile(out, 'utf8'), first.content);
    await assert.rejects(
      () => memoryContent(repo, recordId, 'learning-001', 'export_content', { outPath: out }),
      (err: unknown) => err instanceof ScaError && /already exists/.test(err.message),
    );
    const after = await repo.loadCandidates(recordId);
    assert.equal(after.doc.revision, before.doc.revision);
    assert.equal(after.fileHash, before.fileHash);
  });

  it('memory candidates never enter the publish protocol', async () => {
    const { repo, recordId } = await seeded(mkCandidate('learning-001', { target: { kind: 'memory' } }));
    await approve(repo, recordId, 'learning-001');
    await assert.rejects(
      () => createPreview(repo, recordId, { candidateId: 'learning-001' }),
      (err: unknown) => err instanceof ScaError && err.code === 'unsupported_operation' && /memory/i.test(err.message),
    );
  });
});

describe('publish CLI', () => {
  function collectIo(root: string): { io: CliIo; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      io: {
        env: { SCA_DATA_ROOT: root },
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      },
    };
  }

  it('add-target → preview → commit end to end and doctor sees the whitelist', async () => {
    const { repo, recordId, agents, revision } = await scenarioForCli();
    const targets = collectIo(repo.paths.root);
    assert.equal(await runCli(['publish', 'targets'], targets.io), 0);
    assert.match(String(targets.lines[0]), /"targets": \[\]/);

    const add = collectIo(repo.paths.root);
    assert.equal(await runCli(['publish', 'add-target', '--path', agents], add.io), 0);

    const prev = collectIo(repo.paths.root);
    assert.equal(
      await runCli(['publish', 'preview', recordId, '--candidate', 'learning-001'], prev.io),
      0,
    );
    const view = JSON.parse(String(prev.lines[0])) as { preview: { preview_id: string } };

    const commit = collectIo(repo.paths.root);
    assert.equal(
      await runCli(
        ['publish', 'commit', recordId, '--candidate', 'learning-001', '--preview', view.preview.preview_id, '--expected-revision', String(revision)],
        commit.io,
      ),
      0,
    );
    const done = JSON.parse(String(commit.lines[0])) as { ok: boolean; phase: string; candidate: { status: string } };
    assert.equal(done.ok, true);
    assert.equal(done.phase, 'published');
    assert.equal(done.candidate.status, 'published');
    assert.ok((await fs.readFile(agents, 'utf8')).includes(MANAGED_START));

    const doctor = collectIo(repo.paths.root);
    assert.equal(await runCli(['doctor'], doctor.io), 0);
    const report = JSON.parse(String(doctor.lines[0])) as { checks: { name: string; status: string; detail: string }[] };
    const targetCheck = report.checks.find((c) => c.name === 'target_configuration');
    assert.equal(targetCheck?.status, 'ok');
    assert.match(String(targetCheck?.detail), /whitelisted publish target/);

    const badSub = collectIo(repo.paths.root);
    assert.equal(await runCli(['publish', 'nope'], badSub.io), 2);
  });

  it('review copy_content/export_content route through the CLI as read-only content ops', async () => {
    const root = await tempDir('sca-mem-cli-');
    const ws = await tempDir('sca-mem-cli-ws-');
    const repo = new RecordRepository(root);
    const { recordId } = await repo.register({
      host: 'codex',
      canonicalWorkspace: ws,
      sessionId: 'mem-cli-1',
      transcriptPath: CODEX_FIXTURE,
      trigger: 'manual_skill',
      analyzerVersion: '0.1.0',
    });
    const loaded = await repo.loadCandidates(recordId);
    await repo.updateCandidates(recordId, loaded, (doc) => ({
      ...doc,
      candidates: [mkCandidate('learning-001', { target: { kind: 'memory' }, applicable_scope: '全局' })],
    }));
    await applyDecision(repo, recordId, {
      request_id: 'm-approve',
      candidate_id: 'learning-001',
      action: 'approve',
      expected_revision: await revision(repo, recordId),
    } satisfies DecisionRequest);

    const io = collectIo(root);
    const code = await runCli(['review', recordId, '--action', 'copy_content', '--candidate', 'learning-001'], io.io);
    assert.equal(code, 0);
    const out = JSON.parse(String(io.lines[0])) as { content: string };
    assert.equal(out.content, renderMemoryContent((await repo.loadCandidates(recordId)).doc.candidates[0] as Candidate));

    const exportPath = path.join(root, 'exported', 'rule.md');
    const io2 = collectIo(root);
    assert.equal(
      await runCli(
        ['review', recordId, '--action', 'export_content', '--candidate', 'learning-001', '--out', exportPath],
        io2.io,
      ),
      0,
    );
    assert.ok((await fs.readFile(exportPath, 'utf8')).includes('# candidate learning-001'));

    const io3 = collectIo(root);
    assert.equal(await runCli(['review', recordId, '--action', 'copy_content'], io3.io), 2);
  });
});

async function scenarioForCli(): Promise<{ repo: RecordRepository; recordId: string; agents: string; revision: number }> {
  const { repo, recordId } = await seeded(mkCandidate('learning-001'));
  const targetRoot = await tempDir('sca-target-cli-');
  const agents = path.join(targetRoot, 'AGENTS.md');
  await fs.writeFile(agents, '# Project AGENTS\n', 'utf8');
  const revision = await approve(repo, recordId, 'learning-001');
  return { repo, recordId, agents, revision };
}
