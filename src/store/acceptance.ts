import fs from 'node:fs/promises';
import path from 'node:path';
import { ScaError } from '../domain/errors.js';
import { stableHash } from '../domain/hash.js';
import { PENDING_COMMIT_MAX_BYTES, RULES_REQUEST_LOG_MAX } from '../domain/limits.js';
import { initialRulesDocument, ruleAdoptRequestSchema, ruleSchema, computeRuleId, ruleContentHash, type PendingAcceptance, type Rule } from '../domain/rules.js';
import type { CandidatesDocument } from '../domain/documents.js';
import type { RequestReceipt } from '../domain/request.js';
import { contentVersionHash, hasCurrentApproval } from '../review/decide.js';
import type { RecordRepository } from './repository.js';
import type { RulesRepository, LoadedRules } from './rules.js';
import { serializeRules } from './rules.js';
import { withRegistryLock, withSessionLock } from './lock.js';
import { splitFrontmatter, validateSchema } from './frontmatter.js';
import { splitBody } from './notes.js';
import { renderCandidatesProjection } from './render.js';
import { assertTextBudget } from './bounded.js';

export interface AcceptanceDependencies { rules: RulesRepository; records: RecordRepository }
export type AdoptionCrashPoint = 'before_pending' | 'after_pending' | 'after_candidate' | 'after_commit';
let crashHook: ((point: AdoptionCrashPoint) => void) | undefined;
/** Test-only fault injection; never exposed as a CLI/environment command. */
export function setAcceptanceCrashHook(hook: typeof crashHook): void { crashHook = hook; }

function baseline(doc: CandidatesDocument) {
  const { revision: _revision, updated_at: _time, ...rest } = doc;
  return stableHash(rest);
}
async function notesHash(records: RecordRepository, id: string) {
  const parts = splitBody(splitFrontmatter(await fs.readFile(records.candidatesPath(id), 'utf8')).body);
  const loaded = await records.loadCandidates(id);
  if (parts.projection !== renderCandidatesProjection(loaded.doc).trimEnd()) throw new ScaError('rule_acceptance_recovery_failed', 'candidate projection was edited');
  return stableHash(parts.userNotes);
}

/** Source links must not turn an explicitly scoped migration into outside reads/writes. */
export async function assertAcceptanceSource(records: RecordRepository, id: string): Promise<void> {
  const root = await fs.realpath(records.paths.root);
  const directory = path.dirname(records.candidatesPath(id));
  if (await fs.realpath(directory) !== path.join(root, 'records', id)) throw new ScaError('schema_invalid', 'source directory escapes the data root');
  for (const file of [records.candidatesPath(id), records.analyzePath(id)]) {
    const stat = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat !== null && (!stat.isFile() || stat.isSymbolicLink())) throw new ScaError('schema_invalid', 'source must be a regular non-symlink Markdown file');
  }
}
function assertDependencies(deps: AcceptanceDependencies): void {
  if (deps.records.paths.root !== deps.rules.paths.root) throw new ScaError('schema_invalid', 'records and rules must share a data root');
}

export interface AdoptionOutcome { rule: Rule; receipt: RequestReceipt; candidateRevision: number; replayed: boolean; recovered: boolean }

/** Internal import primitive. The live approve entry point is connected separately; no implicit legacy migration. */
export async function adoptApprovedCandidate(deps: AcceptanceDependencies, raw: unknown): Promise<AdoptionOutcome> {
  assertDependencies(deps);
  const parsed = ruleAdoptRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ScaError('schema_invalid', 'invalid confirmed adoption request');
  const request = parsed.data;
  const payloadHash = stableHash(request);
  return withRegistryLock(deps.rules.paths, async () => {
    const recovered = (await recoverPendingAcceptance(deps)).state === 'recovered';
    return withSessionLock(deps.records.paths, request.record_id, async () => {
      await assertAcceptanceSource(deps.records, request.record_id);
      await deps.records.recoverPending(request.record_id);
      const loaded = await deps.rules.loadUnlocked();
      if (loaded === null) throw new ScaError('migration_required', 'initialize a new registry before approvals or explicitly migrate historical approvals');
      const receipt = loaded.doc.request_log.find(r => r.request_id === request.request_id);
      const id = computeRuleId(request.record_id, request.candidate_id);
      const existing = loaded.doc.rules.find(r => r.rule_id === id);
      if (receipt !== undefined) {
        if (receipt.payload_hash !== payloadHash) throw new ScaError('request_conflict');
        if (existing === undefined) throw new ScaError('rule_acceptance_recovery_failed', 'receipt has no matching rule');
        return { rule: existing, receipt: { ...receipt, result: 'duplicate' }, candidateRevision: (await deps.records.loadCandidates(request.record_id)).doc.revision, replayed: true, recovered };
      }
      if (loaded.doc.rules.some(r => r.history.some(h => h.request_id === request.request_id))) throw new ScaError('request_conflict', 'request receipt expired; do not replay');
      const current = await deps.records.loadCandidates(request.record_id);
      const candidate = current.doc.candidates.find(c => c.id === request.candidate_id);
      if (candidate === undefined) throw new ScaError('schema_invalid', 'unknown candidate');
      if (!hasCurrentApproval(candidate) || candidate.decision === null) throw new ScaError('approval_missing');
      if (candidate.rule_ref !== undefined || existing !== undefined) {
        if (existing === undefined || candidate.rule_ref?.rule_id !== id || existing.source.candidate_content_hash !== contentVersionHash(candidate) || ruleContentHash({ content: candidate.proposed_content, scope: request.scope }) !== existing.content_hash) {
          throw new ScaError('rule_version_mismatch', 'adopted rules must be edited through the rule lifecycle, not historical candidates');
        }
        throw new ScaError('request_conflict', 'candidate already adopted; use its existing rule_ref');
      }
      if (current.doc.revision !== request.expected_revision) throw new ScaError('revision_conflict');
      if (contentVersionHash(candidate) !== request.expected_candidate_content_hash) throw new ScaError('revision_conflict', 'candidate content changed');
      const analyze = await deps.records.loadAnalyze(request.record_id);
      if (request.scope.kind === 'project' && request.scope.canonical_workspace !== analyze.doc.workspace) throw new ScaError('rule_scope_unknown');
      const hash = ruleContentHash({ content: candidate.proposed_content, scope: request.scope });
      const now = new Date().toISOString();
      const rule = validateSchema(ruleSchema, {
        rule_id: id, title: candidate.title, content: candidate.proposed_content, scope: request.scope, status: 'active', version: 1, content_hash: hash,
        accepted_at: candidate.decision.at, version_effective_at: candidate.decision.at,
        source: { record_id: request.record_id, candidate_id: candidate.id, candidate_path: `records/${request.record_id}/learning_candidates.md`, candidate_content_hash: contentVersionHash(candidate), accepted_request_id: request.request_id },
        delivery: null, history: [{ at: candidate.decision.at, action: 'accepted', version: 1, content_hash: hash, request_id: request.request_id, ...(request.note === undefined ? {} : { note: request.note }) }], updated_at: now,
      });
      const pending: PendingAcceptance = {
        request_id: request.request_id, payload_hash: payloadHash, rule_id: id, record_id: request.record_id, candidate_id: candidate.id,
        candidate_expected_revision: current.doc.revision, candidate_expected_hash: current.fileHash, candidate_baseline_hash: baseline(current.doc), candidate_notes_hash: await notesHash(deps.records, request.record_id),
        rules_expected_revision: loaded.doc.revision, rules_expected_hash: stableHash(loaded.doc), rules_notes_hash: stableHash(loaded.userNotes),
        delta: { kind: 'add', rule }, created_at: now,
      };
      assertTextBudget(JSON.stringify(pending), PENDING_COMMIT_MAX_BYTES);
      // Validate both durable shapes before exposing any half-state.
      serializeRules({ ...loaded.doc, rules: [...loaded.doc.rules, rule], revision: loaded.doc.revision + 1, updated_at: now,
        request_log: [...loaded.doc.request_log, { request_id: request.request_id, payload_hash: payloadHash, result: 'applied' as const, at: now }].slice(-RULES_REQUEST_LOG_MAX) }, loaded.userNotes);
      crashHook?.('before_pending');
      await deps.rules.writeUnlocked({ ...loaded.doc, pending_acceptance: pending }, loaded);
      crashHook?.('after_pending');
      await recoverPendingAcceptance(deps);
      const committed = await deps.rules.readCommitted();
      const result = committed.doc.request_log.find(r => r.request_id === request.request_id)!;
      return { rule, receipt: result, candidateRevision: (await deps.records.loadCandidates(request.record_id)).doc.revision, replayed: false, recovered };
    });
  });
}

export async function recoverPendingAcceptance(deps: AcceptanceDependencies): Promise<{ state: 'clean' } | { state: 'recovered'; registry_only: boolean }> {
  assertDependencies(deps);
  return withRegistryLock(deps.rules.paths, async () => {
    const loaded = await deps.rules.loadUnlocked();
    if (loaded === null || loaded.doc.pending_acceptance === null) return { state: 'clean' };
    const pending = loaded.doc.pending_acceptance;
    assertTextBudget(JSON.stringify(pending), PENDING_COMMIT_MAX_BYTES);
    if (stableHash({ ...loaded.doc, pending_acceptance: null }) !== pending.rules_expected_hash || stableHash(loaded.userNotes) !== pending.rules_notes_hash) throw new ScaError('registry_changed');
    return withSessionLock(deps.records.paths, pending.record_id, async () => recoverUnderLocks(deps, loaded, pending));
  });
}

async function recoverUnderLocks(deps: AcceptanceDependencies, loaded: LoadedRules, pending: PendingAcceptance): Promise<{ state: 'recovered'; registry_only: boolean }> {
  await assertAcceptanceSource(deps.records, pending.record_id);
  if (pending.delta.kind !== 'add' || pending.rule_id !== computeRuleId(pending.record_id, pending.candidate_id) || loaded.doc.revision !== pending.rules_expected_revision) throw new ScaError('rule_acceptance_recovery_failed', 'invalid acceptance delta');
  const current = await deps.records.loadCandidates(pending.record_id);
  const candidate = current.doc.candidates.find(c => c.id === pending.candidate_id);
  if (candidate === undefined || !hasCurrentApproval(candidate) || contentVersionHash(candidate) !== pending.delta.rule.source.candidate_content_hash) throw new ScaError('rule_acceptance_recovery_failed', 'candidate approval changed during pending acceptance');
  const ref = { rule_id: pending.rule_id, accepted_version: 1, candidate_content_hash: pending.delta.rule.source.candidate_content_hash, request_id: pending.request_id, at: pending.created_at };
  const alreadyLinked = candidate.rule_ref !== undefined;
  const withoutLink = { ...current.doc, candidates: current.doc.candidates.map(c => {
    if (c.id !== pending.candidate_id) return c;
    const { rule_ref: _ref, ...rest } = c; return rest;
  }) };
  if (await notesHash(deps.records, pending.record_id) !== pending.candidate_notes_hash || baseline(withoutLink) !== pending.candidate_baseline_hash ||
      (alreadyLinked ? current.doc.revision !== pending.candidate_expected_revision + 1 || stableHash(candidate.rule_ref) !== stableHash(ref)
        : current.doc.revision !== pending.candidate_expected_revision || current.fileHash !== pending.candidate_expected_hash)) {
    throw new ScaError('rule_acceptance_recovery_failed', 'candidate file no longer matches the pinned before/after state');
  }
  if (!alreadyLinked) {
    await deps.records.updateCandidates(pending.record_id, current, doc => ({ ...doc, candidates: doc.candidates.map(c => c.id === pending.candidate_id ? { ...c, rule_ref: ref } : c) }));
    crashHook?.('after_candidate');
    // Re-read the exact linked state before committing the registry as well as on restart.
    const result = await recoverUnderLocks(deps, loaded, pending);
    return { ...result, registry_only: false };
  }
  const receipt: RequestReceipt = { request_id: pending.request_id, payload_hash: pending.payload_hash, result: 'applied', at: pending.created_at };
  await deps.rules.writeUnlocked({ ...loaded.doc, revision: loaded.doc.revision + 1, updated_at: pending.created_at,
    rules: [...loaded.doc.rules, pending.delta.rule], request_log: [...loaded.doc.request_log, receipt].slice(-RULES_REQUEST_LOG_MAX), pending_acceptance: null }, loaded);
  crashHook?.('after_commit');
  return { state: 'recovered' as const, registry_only: alreadyLinked };
}

/** Explicit migration only: caller already backed up and inspected legacy records. */
export async function initializeForMigration(rules: RulesRepository): Promise<void> {
  await withRegistryLock(rules.paths, async () => {
    if (await rules.loadUnlocked() === null) await rules.writeUnlocked(initialRulesDocument(new Date().toISOString()), null);
  });
}
