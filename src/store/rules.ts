import fs from 'node:fs/promises';
import path from 'node:path';
import { ACCEPTED_RULES_SCHEMA_ID, acceptedRulesDocumentSchema, initialRulesDocument, type AcceptedRulesDocument } from '../domain/rules.js';
import { ScaError } from '../domain/errors.js';
import { sha256Tag, type Sha256Hash } from '../domain/hash.js';
import { ACCEPTED_RULES_READ_MAX_BYTES } from '../domain/limits.js';
import { readBoundedFile, assertTextBudget } from './bounded.js';
import { atomicWriteText } from './atomic.js';
import { parseMarkdownDoc, renderDocument, splitFrontmatter, validateSchema } from './frontmatter.js';
import { assertSingleNotesSection, composeBody, splitBody } from './notes.js';
import { renderRulesProjection } from './render.js';
import { acceptedRulesPath, registryLockTarget, resolvePaths, type ScaPaths } from './paths.js';
import { assertLockHeld, withRegistryLock } from './lock.js';

export type RulesRead = { state: 'absent' } | { state: 'corrupt'; error: ScaError } |
  { state: 'ok'; doc: AcceptedRulesDocument; fileHash: Sha256Hash; userNotes: string; projectionMatches: boolean };
export type LoadedRules = Extract<RulesRead, { state: 'ok' }>;

export function serializeRules(doc: AcceptedRulesDocument, userNotes: string): string {
  const validated = validateSchema(acceptedRulesDocumentSchema, doc);
  const raw = renderDocument(validated, composeBody(renderRulesProjection(validated), userNotes));
  assertTextBudget(raw, ACCEPTED_RULES_READ_MAX_BYTES);
  return raw;
}

/** Raw reads are diagnostic only; consumers must use readCommitted, never pending rules. */
export class RulesRepository {
  readonly paths: ScaPaths;
  constructor(root?: string) { this.paths = resolvePaths(root); }

  async read(options: { maxBytes?: number } = {}): Promise<RulesRead> {
    try {
      const file = acceptedRulesPath(this.paths);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ScaError('schema_invalid', 'registry must be a regular file, not a symlink');
      const raw = await readBoundedFile(file, options.maxBytes ?? ACCEPTED_RULES_READ_MAX_BYTES);
      const doc = parseMarkdownDoc(raw, acceptedRulesDocumentSchema, ACCEPTED_RULES_SCHEMA_ID);
      const body = splitFrontmatter(raw).body;
      assertSingleNotesSection(body);
      const parts = splitBody(body);
      return { state: 'ok', doc, fileHash: sha256Tag(raw), userNotes: parts.userNotes,
        projectionMatches: parts.projection === renderRulesProjection(doc).trimEnd() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
      return { state: 'corrupt', error: error instanceof ScaError ? error : new ScaError('schema_invalid', 'registry is unreadable') };
    }
  }

  async status(options: { maxBytes?: number } = {}) {
    const loaded = await this.read(options);
    if (loaded.state !== 'ok') return { state: loaded.state, rule_count: null, pending_rule_id: null, recoverable: false,
      ...(loaded.state === 'corrupt' ? { error: loaded.error.toPayload() } : {}) };
    if (!loaded.projectionMatches) return { state: 'corrupt', rule_count: null, pending_rule_id: loaded.doc.pending_acceptance?.rule_id ?? null, recoverable: false,
      error: new ScaError('registry_changed', 'registry projection differs from frontmatter').toPayload() };
    return { state: 'ok', rule_count: loaded.doc.pending_acceptance === null ? loaded.doc.rules.length : null,
      pending_rule_id: loaded.doc.pending_acceptance?.rule_id ?? null, recoverable: false,
      ...(loaded.doc.pending_acceptance !== null ? { error: new ScaError('rule_acceptance_recovery_failed', 'pending acceptance requires explicit recovery before committed reads').toPayload() } : {}) };
  }

  async readCommitted(): Promise<LoadedRules> {
    return withRegistryLock(this.paths, async () => {
      const loaded = await this.loadUnlocked();
      if (loaded === null) throw new ScaError('rules_registry_missing');
      if (loaded.doc.pending_acceptance !== null) throw new ScaError('rule_acceptance_recovery_failed', 'pending acceptance; recover before reading committed rules');
      return loaded;
    });
  }

  async loadUnlocked(): Promise<LoadedRules | null> {
    assertLockHeld('registry', 'load registry', registryLockTarget(this.paths));
    const loaded = await this.read();
    if (loaded.state === 'absent') return null;
    if (loaded.state === 'corrupt') throw loaded.error;
    if (!loaded.projectionMatches) throw new ScaError('registry_changed', 'registry projection was edited; reconcile before writing');
    return loaded;
  }

  /** Explicit empty initialization is allowed only when no prior approvals/links exist. */
  async initialize(): Promise<{ created: boolean; doc: AcceptedRulesDocument }> {
    return withRegistryLock(this.paths, async () => {
      const loaded = await this.loadUnlocked();
      if (loaded !== null) {
        if (loaded.doc.pending_acceptance !== null) throw new ScaError('rule_acceptance_recovery_failed');
        return { created: false, doc: loaded.doc };
      }
      // Never reconstruct a missing authoritative registry from existing approvals.
      const { RecordRepository } = await import('./repository.js');
      const records = new RecordRepository(this.paths.root);
      const entries = await fs.readdir(this.paths.recordsDir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
      for (const id of entries) {
        if (!/^[0-9a-f]{64}$/.test(id)) continue;
        const candidateFile = await records.loadCandidates(id);
        if (candidateFile.doc.candidates.some(c => c.rule_ref !== undefined || c.decision !== null || c.decision_history.length > 0 || c.publication.published)) {
          throw new ScaError('migration_required');
        }
      }
      const doc = initialRulesDocument(new Date().toISOString());
      await this.writeUnlocked(doc, null);
      return { created: true, doc };
    });
  }

  async writeUnlocked(doc: AcceptedRulesDocument, expected?: LoadedRules | null): Promise<LoadedRules> {
    assertLockHeld('registry', 'write registry', registryLockTarget(this.paths));
    const current = await this.loadUnlocked();
    if (expected !== undefined && (current?.fileHash ?? null) !== (expected?.fileHash ?? null)) throw new ScaError('registry_changed');
    const raw = serializeRules(doc, current?.userNotes ?? '');
    await fs.mkdir(this.paths.root, { recursive: true });
    // The lock coordinates our writers; this final check catches external edits during preparation.
    const latest = await this.read();
    if (latest.state === 'corrupt') throw latest.error;
    if ((latest.state === 'ok' ? latest.fileHash : null) !== (current?.fileHash ?? null)) throw new ScaError('registry_changed');
    await atomicWriteText(this.paths.root, path.basename(acceptedRulesPath(this.paths)), raw);
    const result = await this.loadUnlocked();
    if (result === null) throw new ScaError('rules_registry_missing');
    return result;
  }

  async transact<T>(fn: (doc: AcceptedRulesDocument) => { write: false; result: T } | { write: true; doc: AcceptedRulesDocument; result: T } | Promise<{ write: false; result: T } | { write: true; doc: AcceptedRulesDocument; result: T }>) {
    return withRegistryLock(this.paths, async () => {
      const current = await this.readCommitted();
      const outcome = await fn(structuredClone(current.doc));
      const file = outcome.write ? await this.writeUnlocked({ ...outcome.doc, revision: current.doc.revision + 1, updated_at: new Date().toISOString() }, current) : current;
      return { result: outcome.result, file };
    });
  }
}
