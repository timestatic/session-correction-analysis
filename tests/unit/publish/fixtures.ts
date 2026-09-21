import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { candidateSchema, type Candidate } from '../../../src/domain/candidates.js';
import { sha256Tag } from '../../../src/domain/hash.js';
import { applyDecision, type DecisionRequest } from '../../../src/review/decide.js';
import { createPreview, type PreviewOutcome } from '../../../src/publish/preview.js';
import { addTarget } from '../../../src/publish/targets.js';
import { RecordRepository } from '../../../src/store/repository.js';

export const CODEX_FIXTURE = path.join(import.meta.dirname, '..', '..', 'fixtures', 'codex', 'basic.jsonl');
export const NOW = '2026-01-01T00:00:00.000Z';

export const tempDirs: string[] = [];

export async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function mkCandidate(id: string, overrides: Record<string, unknown> = {}): Candidate {
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

export async function seedRepository(
  root: string,
  ws: string,
  sessionId: string,
  candidates: Candidate[],
): Promise<{ repo: RecordRepository; recordId: string }> {
  const repo = new RecordRepository(root);
  const { recordId } = await repo.register({
    host: 'codex',
    canonicalWorkspace: ws,
    sessionId,
    transcriptPath: CODEX_FIXTURE,
    trigger: 'manual_skill',
    analyzerVersion: '0.1.0',
  });
  const current = await repo.loadCandidates(recordId);
  await repo.updateCandidates(recordId, current, (doc) => ({ ...doc, candidates }));
  return { repo, recordId };
}

export async function revision(repo: RecordRepository, recordId: string): Promise<number> {
  return (await repo.loadCandidates(recordId)).doc.revision;
}

export async function approve(repo: RecordRepository, recordId: string, candidateId: string): Promise<number> {
  const out = await applyDecision(repo, recordId, {
    request_id: `approve-${candidateId}`,
    candidate_id: candidateId,
    action: 'approve',
    expected_revision: await revision(repo, recordId),
  } satisfies DecisionRequest);
  return out.revision;
}

export interface Scenario {
  repo: RecordRepository;
  recordId: string;
  agents: string;
  revision: number;
  preview: PreviewOutcome;
  targetRoot: string;
  root: string;
}

/** Approved learning-001 + whitelisted AGENTS.md + a fresh preview. */
export async function scenario(sessionId = 'publish-session-x'): Promise<Scenario> {
  const root = await tempDir('sca-scenario-');
  const ws = await tempDir('sca-scenario-ws-');
  const { repo, recordId } = await seedRepository(root, ws, sessionId, [mkCandidate('learning-001')]);
  const targetRoot = await fs.realpath(await tempDir('sca-scenario-target-'));
  const agents = path.join(targetRoot, 'AGENTS.md');
  await fs.writeFile(agents, '# Project AGENTS\n', 'utf8');
  await addTarget(repo.paths, { filePath: agents });
  const revision = await approve(repo, recordId, 'learning-001');
  const preview = await createPreview(repo, recordId, { candidateId: 'learning-001' });
  return { repo, recordId, agents, revision, preview, targetRoot, root };
}
