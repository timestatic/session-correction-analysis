import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ACCEPTED_RULES_SCHEMA_ID } from '../../../src/domain/rules.js';
import { ScaError } from '../../../src/domain/errors.js';
import { renderDocument } from '../../../src/store/frontmatter.js';
import { loadRegistry, transactRegistry } from '../../../src/store/registry.js';
import { RecordRepository } from '../../../src/store/repository.js';
import { resolvePaths } from '../../../src/store/paths.js';

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

function minimalRegistry(overrides: Record<string, unknown> = {}): string {
  return renderDocument(
    {
      schema: ACCEPTED_RULES_SCHEMA_ID,
      revision: 1,
      updated_at: '2026-01-01T00:00:00.000Z',
      rules: [],
      request_log: [],
      ...overrides,
    },
    '# 已采纳规则\n',
  );
}

async function freshRepo(): Promise<{ repo: RecordRepository; root: string; ws: string }> {
  const root = await tempDir('sca-registry-');
  const ws = await tempDir('sca-registry-ws-');
  return { repo: new RecordRepository(root), root, ws };
}

async function register(repo: RecordRepository, ws: string, sessionId: string): Promise<string> {
  const { recordId } = await repo.register({
    host: 'codex',
    canonicalWorkspace: ws,
    sessionId,
    transcriptPath: CODEX_FIXTURE,
    trigger: 'manual_skill',
    analyzerVersion: '0.1.0',
  });
  return recordId;
}

describe('accepted_rules.md coexistence with the legacy fence', () => {
  it('a valid v1 registry lets session records be registered and read', async () => {
    const { repo, root, ws } = await freshRepo();
    await fs.writeFile(path.join(root, 'accepted_rules.md'), minimalRegistry(), 'utf8');
    const recordId = await register(repo, ws, 'coexist-1');
    const { candidates } = await repo.loadRecord(recordId);
    assert.equal(candidates.doc.revision, 1);
  });

  it('an unparseable or foreign-schema accepted_rules.md still refuses every write', async () => {
    const cases: [string, string][] = [
      ['opaque legacy pending transaction', 'unparseable'],
      [minimalRegistry({ schema: 'session-correction-analysis/accepted-rules/v2' }), 'unknown version'],
    ];
    for (const [content, label] of cases) {
      const { repo, root, ws } = await freshRepo();
      await fs.writeFile(path.join(root, 'accepted_rules.md'), content, 'utf8');
      await assert.rejects(
        () => register(repo, ws, `fenced-${label}`),
        (err: unknown) => err instanceof ScaError && err.code === 'unsupported_operation',
        label,
      );
    }
  });

  it('legacy publication receipts stay fenced even beside a valid registry', async () => {
    const { repo, root, ws } = await freshRepo();
    const pubDir = path.join(resolvePaths(root).runtimeDir, 'publications');
    await fs.mkdir(pubDir, { recursive: true });
    await fs.writeFile(path.join(pubDir, 'legacy.json'), '{}', 'utf8');
    await fs.writeFile(path.join(root, 'accepted_rules.md'), minimalRegistry(), 'utf8');
    await assert.rejects(
      () => register(repo, ws, 'fenced-publications'),
      (err: unknown) => err instanceof ScaError && err.code === 'unsupported_operation',
    );
  });
});

describe('registry transactions', () => {
  it('a missing file reads as an empty view and the first write lands at revision 1', async () => {
    const { repo } = await freshRepo();
    const empty = await loadRegistry(repo.paths);
    assert.equal(empty.revision, 0);
    assert.equal(empty.rules.length, 0);
    const written = await transactRegistry(repo.paths, (doc) => ({
      write: true,
      doc: { ...doc, rules: doc.rules, request_log: [] },
      result: 'x',
    }));
    assert.equal(written.doc.revision, 1);
    const reloaded = await loadRegistry(repo.paths);
    assert.deepEqual(reloaded, JSON.parse(JSON.stringify(written.doc)));
  });

  it('write:false replays never bump the revision and the body projection is regenerated', async () => {
    const { repo } = await freshRepo();
    await transactRegistry(repo.paths, (doc) => ({ write: true, doc, result: null }));
    const text = await fs.readFile(path.join(repo.paths.root, 'accepted_rules.md'), 'utf8');
    assert.match(text, /# 已采纳规则/);
    const after = await transactRegistry(repo.paths, (doc) => ({ write: false, result: doc.revision }));
    assert.equal(after.result, 1);
    assert.equal((await loadRegistry(repo.paths)).revision, 1);
  });
});
