import fs from 'node:fs/promises';
import path from 'node:path';
import { ScaError } from '../domain/errors.js';
import { MIGRATION_SCHEMA_ID, computeRuleId, migrationPlanSchema, rulesMigrateRequestSchema, type MigrationItem, type MigrationPlan, type Rule } from '../domain/rules.js';
import { contentVersionHash, hasCurrentApproval } from '../review/decide.js';
import { withRegistryLock, withSessionLock } from './lock.js';
import { adoptApprovedCandidate, assertAcceptanceSource, initializeForMigration, recoverPendingAcceptance, type AcceptanceDependencies } from './acceptance.js';
import { acceptedRulesPath } from './paths.js';

async function recordIds(deps: AcceptanceDependencies, selected?: string[]): Promise<string[]> {
  if (selected !== undefined) return [...new Set(selected)].sort();
  const entries = await fs.readdir(deps.records.paths.recordsDir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
  return entries.filter(e => e.isDirectory() && /^[0-9a-f]{64}$/.test(e.name)).map(e => e.name).sort();
}

export async function planRuleMigration(deps: AcceptanceDependencies, raw: unknown): Promise<MigrationPlan> {
  const parsed = rulesMigrateRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ScaError('schema_invalid', 'invalid migration request');
  const request = parsed.data;
  if (deps.rules.paths.root !== deps.records.paths.root) throw new ScaError('schema_invalid', 'migration data roots differ');
  const registry = await deps.rules.read();
  if (registry.state === 'corrupt') throw registry.error;
  if (registry.state === 'ok' && (!registry.projectionMatches || registry.doc.pending_acceptance !== null)) throw new ScaError('rule_acceptance_recovery_failed', 'recover/reconcile before planning migration');
  if ((registry.state === 'ok' ? registry.doc.revision : 1) !== request.expected_revision) throw new ScaError('revision_conflict');
  const items: MigrationItem[] = [];
  for (const id of await recordIds(deps, request.record_ids)) {
    await assertAcceptanceSource(deps.records, id);
    // Strictly read-only: never recover or regenerate a source during dry-run.
    const candidates = await deps.records.loadCandidates(id);
    let analyze;
    try { analyze = await deps.records.loadAnalyze(id); } catch { analyze = undefined; }
    for (const candidate of candidates.doc.candidates) {
      const item: MigrationItem = { record_id: id, candidate_id: candidate.id, candidate_content_hash: contentVersionHash(candidate), disposition: 'skip_unapproved', reason: 'no current approval' };
      const existing = registry.state === 'ok' ? registry.doc.rules.find(r => r.rule_id === computeRuleId(id, candidate.id)) : undefined;
      if (candidate.rule_ref !== undefined) {
        if (existing === undefined || candidate.rule_ref.rule_id !== existing.rule_id) throw new ScaError('rules_registry_missing', 'linked rule missing; restore registry backup, not an initial migration');
        item.disposition = 'skip_already_migrated'; item.rule_id = existing.rule_id; item.reason = 'source already linked';
      } else if (analyze === undefined) {
        item.disposition = 'needs_review_source_missing'; item.reason = 'source analysis unavailable';
      } else if (['approved', 'published', 'publish_failed'].includes(candidate.status)) {
        if (candidate.decision?.action !== 'approve') { item.disposition = 'needs_review_missing_time'; item.reason = 'no traceable approval'; }
        else if (!hasCurrentApproval(candidate)) { item.disposition = 'skip_approval_stale'; item.reason = 'approval does not bind current content'; }
        else if (analyze.doc.workspace === undefined || candidate.applicable_scope !== undefined || candidate.target.kind === 'memory' && candidate.target.scope === 'user') {
          item.disposition = 'needs_review_missing_scope'; item.reason = 'legacy scope requires explicit confirmation';
        } else {
          item.disposition = 'import'; item.reason = 'valid project approval'; item.rule_id = computeRuleId(id, candidate.id); item.accepted_at = candidate.decision.at;
          item.proposed_scope = { kind: 'project', canonical_workspace: analyze.doc.workspace, ...(analyze.doc.project_name === undefined ? {} : { project_name: analyze.doc.project_name }) };
          if (candidate.publication.publication_id !== undefined) item.publication_receipt = { publication_id: candidate.publication.publication_id, published: candidate.publication.published };
        }
      }
      items.push(item);
    }
  }
  const { record_ids: _selection, ...planRequest } = request;
  return migrationPlanSchema.parse({ schema: MIGRATION_SCHEMA_ID, generated_at: new Date().toISOString(), ...planRequest, items,
    counts: { import: items.filter(i => i.disposition === 'import').length, skipped: items.filter(i => i.disposition.startsWith('skip_')).length, needs_review: items.filter(i => i.disposition.startsWith('needs_review')).length } });
}

export async function applyRuleMigration(deps: AcceptanceDependencies, raw: unknown) {
  const parsed = rulesMigrateRequestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.mode !== 'apply' || parsed.data.backup_dir === undefined) throw new ScaError('schema_invalid', 'explicit apply and backup_dir are required');
  const request = parsed.data;
  const backupDir = path.resolve(parsed.data.backup_dir);
  // A backup must never be inside the live records or runtime (nor overwrite them).
  const root = path.resolve(deps.rules.paths.root);
  if (backupDir === root || backupDir.startsWith(`${root}${path.sep}`)) throw new ScaError('schema_invalid', 'backup directory must be outside the live data root');
  return withRegistryLock(deps.rules.paths, async () => {
    await recoverPendingAcceptance(deps);
    const plan = await planRuleMigration(deps, request);
    const importable = plan.items.filter(i => i.disposition === 'import');
    const imported: Rule[] = [];
    if (importable.length === 0) return { plan, imported, batches: 0 };
    await fs.mkdir(backupDir, { recursive: true });
    const realBackup = await fs.realpath(backupDir);
    const realRoot = await fs.realpath(root);
    if (realBackup === realRoot || realBackup.startsWith(`${realRoot}${path.sep}`)) throw new ScaError('schema_invalid', 'backup resolves into live data root');
    const registry = await deps.rules.read();
    if (registry.state === 'ok') await backupExact(acceptedRulesPath(deps.rules.paths), path.join(backupDir, 'accepted_rules.md'), realBackup);
    const backed = new Set<string>();
    for (const item of importable) {
      await withSessionLock(deps.records.paths, item.record_id, async () => {
        await deps.records.recoverPending(item.record_id);
        const current = await deps.records.loadCandidates(item.record_id);
        const candidate = current.doc.candidates.find(c => c.id === item.candidate_id);
        if (candidate === undefined || !hasCurrentApproval(candidate) || contentVersionHash(candidate) !== item.candidate_content_hash || candidate.decision?.at !== item.accepted_at || item.proposed_scope === undefined) throw new ScaError('revision_conflict', 'migration source changed since plan');
        if (!backed.has(item.record_id)) {
          for (const source of [deps.records.analyzePath(item.record_id), deps.records.candidatesPath(item.record_id)]) {
            await backupExact(source, path.join(backupDir, 'records', item.record_id, path.basename(source)), realBackup);
          }
          backed.add(item.record_id);
        }
        await initializeForMigration(deps.rules);
        const outcome = await adoptApprovedCandidate(deps, { request_id: `migrate-${item.record_id}-${item.candidate_id}`, record_id: item.record_id, candidate_id: item.candidate_id,
          expected_revision: current.doc.revision, expected_candidate_content_hash: item.candidate_content_hash, scope: item.proposed_scope, confirmed: true });
        imported.push(outcome.rule);
      });
    }
    return { plan, imported, batches: Math.ceil(imported.length / plan.batch_size) };
  });
}

async function backupExact(source: string, destination: string, backupRoot: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const actualParent = await fs.realpath(path.dirname(destination));
  if (actualParent !== backupRoot && !actualParent.startsWith(`${backupRoot}${path.sep}`)) throw new ScaError('schema_invalid', 'backup parent escapes backup directory');
  // Exclusive: never overwrite an earlier backup or silently treat it as current.
  const handle = await fs.open(destination, 'wx', 0o600);
  try { await handle.writeFile(await fs.readFile(source)); await handle.sync(); } finally { await handle.close(); }
}
