import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ScaError } from '../domain/errors.js';

export const DEFAULT_DATA_ROOT = path.join(os.homedir(), '.session-correction-analysis');

/** record_id is a bare sha256 hex; anything else is a traversal/typo risk. */
export const RECORD_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface ScaPaths {
  readonly root: string;
  readonly recordsDir: string;
  readonly runtimeDir: string;
  readonly locksDir: string;
  /** Plugin-global configuration (publish whitelist, design 26.2); never per-session. */
  readonly configDir: string;
}

export function resolvePaths(rootDir: string = DEFAULT_DATA_ROOT): ScaPaths {
  const root = path.resolve(rootDir);
  return {
    root,
    recordsDir: path.join(root, 'records'),
    runtimeDir: path.join(root, 'runtime'),
    locksDir: path.join(root, 'runtime', 'locks'),
    configDir: path.join(root, 'config'),
  };
}

export function assertSafeRecordId(recordId: string): void {
  if (!RECORD_ID_PATTERN.test(recordId)) {
    throw new ScaError('schema_invalid', 'record_id must be 64 lowercase hex characters');
  }
}

export function recordDir(paths: ScaPaths, recordId: string): string {
  assertSafeRecordId(recordId);
  return path.join(paths.recordsDir, recordId);
}

/** Locks live under runtime/locks, separate from business Markdown (design 24.2). */
export function sessionLockTarget(paths: ScaPaths, recordId: string): string {
  assertSafeRecordId(recordId);
  return path.join(paths.locksDir, `session-${recordId}`);
}

// --- root accepted-rules registry (design 31.2/31.5) ------------------------

/** The registry file name; one authoritative file per data root. */
export const ACCEPTED_RULES_FILE_NAME = 'accepted_rules.md';

/** Lock directory name for registry-wide mutations (adoption, update, migrate). */
export const REGISTRY_LOCK_NAME = 'rules-registry';

/**
 * Global lock acquisition order (design 31.5). A writer may take a lock further
 * right while holding one to its left, never the reverse: code holding the
 * session lock must not reach back for the registry lock.
 */
export const LOCK_ORDER = ['registry', 'session', 'target'] as const;
export type LockLevel = (typeof LOCK_ORDER)[number];

export function registryLockTarget(paths: ScaPaths): string {
  return path.join(paths.locksDir, REGISTRY_LOCK_NAME);
}

/** Sort key when a writer must take several locks of the same level (design 31.5). */
export function lockSortKey(level: LockLevel, key: string): string {
  return `${LOCK_ORDER.indexOf(level)}:${key}`;
}

/**
 * accepted_rules.md is business data, not a cache: it lives in the data root
 * beside records/ and is never placed under runtime/.
 */
export function acceptedRulesPath(paths: ScaPaths): string {
  return path.join(paths.root, ACCEPTED_RULES_FILE_NAME);
}

/**
 * Best-effort canonical workspace used in record identity. Symlinked trees on
 * case-insensitive filesystems are documented limits, not silently normalized.
 */
export async function canonicalWorkspace(workspacePath: string): Promise<string> {
  const resolved = path.resolve(workspacePath);
  const real = await fs.realpath(resolved).catch(() => resolved);
  return stripTrailingSep(real);
}

export function stripTrailingSep(value: string): string {
  if (value.length > 1 && (value.endsWith('/') || value.endsWith(path.sep))) {
    return value.replace(/[/\\]+$/g, '');
  }
  return value;
}
