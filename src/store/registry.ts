import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ACCEPTED_RULES_FILE,
  ACCEPTED_RULES_SCHEMA_ID,
  acceptedRulesDocumentSchema,
  type AcceptedRulesDocument,
} from '../domain/rules.js';
import { ScaError } from '../domain/errors.js';
import { atomicWriteText } from './atomic.js';
import { parseMarkdownDoc, renderDocument, validateSchema } from './frontmatter.js';
import { withRegistryLock } from './lock.js';
import type { ScaPaths } from './paths.js';
import { renderAcceptedRulesProjection } from './render.js';

/**
 * Single-file storage for the root accepted-rules registry (design 31.2,
 * lightweight). Every mutation is one read-modify-write of accepted_rules.md
 * inside the registry lock; the whole file is rewritten atomically, so any
 * crash leaves either the old or the new version, never a mix.
 */

export function acceptedRulesPath(paths: ScaPaths): string {
  return path.join(paths.root, ACCEPTED_RULES_FILE);
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  return fs.readFile(filePath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
}

/**
 * The fence that used to refuse ANY accepted_rules.md (design 31.8 legacy
 * guard) becomes schema-discriminated: absent → fine, a v1 registry written
 * by this tool → coexists, anything else (legacy layout, foreign schema,
 * unparseable) → still refuses all session-record writes.
 */
export async function assertCompatibleRulesRegistry(paths: ScaPaths): Promise<void> {
  const text = await readFileOrUndefined(acceptedRulesPath(paths));
  if (text === undefined) {
    return;
  }
  try {
    parseMarkdownDoc(text, acceptedRulesDocumentSchema, ACCEPTED_RULES_SCHEMA_ID);
  } catch {
    throw new ScaError(
      'unsupported_operation',
      'accepted_rules.md exists but does not parse as a Phase 1 v1 rules registry; it may hold legacy rule/publication transactions. Preserve this data root and use a new --data-root.',
    );
  }
}

/** Synthesized view for a never-created file; written registries start at revision 1. */
function missingRegistry(): AcceptedRulesDocument {
  return {
    schema: ACCEPTED_RULES_SCHEMA_ID,
    revision: 0,
    updated_at: '1970-01-01T00:00:00.000Z',
    rules: [],
    request_log: [],
  };
}

export async function loadRegistry(paths: ScaPaths): Promise<AcceptedRulesDocument> {
  const text = await readFileOrUndefined(acceptedRulesPath(paths));
  if (text === undefined) {
    return missingRegistry();
  }
  return parseMarkdownDoc(text, acceptedRulesDocumentSchema, ACCEPTED_RULES_SCHEMA_ID);
}

export interface RegistryTransactionResult<T> {
  result: T;
  /** The document after (or despite) the transaction — revision included. */
  doc: AcceptedRulesDocument;
}

/**
 * One-lock read-modify-write over accepted_rules.md, mirroring
 * `transactCandidates`: a `write:false` outcome (idempotent receipt replay)
 * never bumps the revision.
 */
export async function transactRegistry<T>(
  paths: ScaPaths,
  fn: (
    doc: AcceptedRulesDocument,
  ) =>
    | { write: false; result: T }
    | { write: true; doc: AcceptedRulesDocument; result: T }
    | Promise<{ write: false; result: T } | { write: true; doc: AcceptedRulesDocument; result: T }>,
): Promise<RegistryTransactionResult<T>> {
  return withRegistryLock(paths, async () => {
    const current = await loadRegistry(paths);
    const outcome = await fn(current);
    if (!outcome.write) {
      return { result: outcome.result, doc: current };
    }
    const next = validateSchema(acceptedRulesDocumentSchema, {
      ...outcome.doc,
      schema: ACCEPTED_RULES_SCHEMA_ID,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    });
    const filePath = acceptedRulesPath(paths);
    await atomicWriteText(
      path.dirname(filePath),
      ACCEPTED_RULES_FILE,
      renderDocument(next, renderAcceptedRulesProjection(next)),
    );
    return { result: outcome.result, doc: next };
  });
}
