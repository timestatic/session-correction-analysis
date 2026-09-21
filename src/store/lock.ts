import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

import { ScaError } from '../domain/errors.js';
import { LOCK_RETRY_COUNT, LOCK_RETRY_MAX_MS, LOCK_RETRY_MIN_MS, LOCK_STALE_MS, LOCK_UPDATE_MS } from '../domain/limits.js';
import type { LockLevel } from './paths.js';
import type { ScaPaths } from './paths.js';
import { LOCK_ORDER, registryLockTarget, sessionLockTarget } from './paths.js';
import { lock } from 'proper-lockfile';

export interface LockHandle {
  compromised(): boolean;
  assertOwned(this: void): void;
  release(): Promise<void>;
}

const activeGuards = new AsyncLocalStorage<readonly (() => void)[]>();

/** Every atomic writer in the current transaction checks all enclosing locks. */
export function assertActiveLocksOwned(): void {
  for (const guard of activeGuards.getStore() ?? []) guard();
}

interface LockScope {
  readonly level: LockLevel;
  readonly target: string;
}

const heldLocks = new AsyncLocalStorage<readonly LockScope[]>();

function held(): readonly LockScope[] {
  return heldLocks.getStore() ?? [];
}

/**
 * The registry lock is the only writer of accepted_rules.md. A primitive that
 * mutates it without holding the lock would be silently serialized against
 * nothing, so the requirement is asserted rather than documented away.
 */
export function assertLockHeld(level: LockLevel, detail = 'this operation', target?: string): void {
  if (!held().some((scope) => scope.level === level && (target === undefined || scope.target === target))) {
    throw new ScaError(
      'internal_error',
      `${detail} requires the ${level} lock to be held; it was called outside its critical section`,
    );
  }
}

async function acquireTargetLock(target: string): Promise<LockHandle> {
  await fs.mkdir(target, { recursive: true });
  const lockPath = `${target}.lock`;
  const identity: { stat?: nativeFs.Stats } = {};
  let lost = false;
  const ownsDirectory = (): boolean => {
    try {
      const current = nativeFs.statSync(lockPath);
      return identity.stat !== undefined && current.ino === identity.stat.ino && current.dev === identity.stat.dev;
    } catch { return false; }
  };
  const release = await lock(target, {
    realpath: false, stale: LOCK_STALE_MS, update: LOCK_UPDATE_MS,
    retries: { retries: LOCK_RETRY_COUNT, minTimeout: LOCK_RETRY_MIN_MS, maxTimeout: LOCK_RETRY_MAX_MS },
    onCompromised: () => { lost = true; },
    // Release must cancel the library heartbeat without unlinking a successor's lock.
    fs: { ...nativeFs, rmdir: ((file: nativeFs.PathLike, callback: nativeFs.NoParamCallback) => {
      if (identity.stat !== undefined && String(file) === lockPath && !ownsDirectory()) { callback(null); return; }
      nativeFs.rmdir(file, callback);
    }) as typeof nativeFs.rmdir },
  });
  identity.stat = nativeFs.statSync(lockPath);
  const assertOwned = (): void => {
    if (lost || !ownsDirectory() || nativeFs.statSync(lockPath).mtimeMs < Date.now() - LOCK_STALE_MS) {
      lost = true;
      throw new ScaError('lock_compromised');
    }
  };
  return { compromised: () => lost, assertOwned, release };
}

/**
 * Cross-process session lock (design 24.2). Losing the lock never aborts the
 * process: the writer must check `compromised()` before committing.
 */
export async function acquireSessionLock(paths: ScaPaths, recordId: string): Promise<LockHandle> {
  await fs.mkdir(paths.locksDir, { recursive: true });
  const target = sessionLockTarget(paths, recordId);
  return acquireTargetLock(target);
}

/**
 * One acquisition path for every level, so the global order (design 31.5) is
 * enforced by the lock itself instead of by convention: `registry → session →
 * target`, never the reverse. Taking a lock that is already held in this async
 * context reuses it, so a service can compose the same store calls it also owns.
 */
async function withLock<T>(level: LockLevel, target: string, fn: () => T | Promise<T>): Promise<T> {
  const enclosing = held();
  if (enclosing.some((scope) => scope.target === target)) {
    assertActiveLocksOwned();
    return fn();
  }
  const index = LOCK_ORDER.indexOf(level);
  const heldDeepest = enclosing.reduce((max, scope) => Math.max(max, LOCK_ORDER.indexOf(scope.level)), -1);
  if (index < heldDeepest || enclosing.some(scope => scope.level === level && scope.target > target)) {
    throw new ScaError(
      'internal_error',
      `lock order violated: ${level} may not be acquired while holding ${enclosing.map((scope) => scope.level).join('+')} (frozen order ${LOCK_ORDER.join(' → ')})`,
    );
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const handle = await acquireTargetLock(target);
  const scope: LockScope = { level, target };
  try {
    const out = await activeGuards.run([...(activeGuards.getStore() ?? []), handle.assertOwned], () =>
      heldLocks.run([...enclosing, scope], fn),
    );
    handle.assertOwned();
    return out;
  } finally {
    await handle.release().catch(() => undefined);
  }
}

/** Registry-wide mutations (adoption, update, revoke, migrate) take this lock first. */
export function withRegistryLock<T>(paths: ScaPaths, fn: () => T | Promise<T>): Promise<T> {
  return withLock('registry', registryLockTarget(paths), fn);
}

export function withSessionLock<T>(
  paths: ScaPaths,
  recordId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withLock('session', sessionLockTarget(paths, recordId), fn);
}

/** Lock names are flat, filesystem-safe tokens under runtime/locks. */
const LOCK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Generic advisory lock beside the session locks (design 24.2/1404: publish
 * holds the session lock AND a per-target lock). Same stale-takeover and
 * compromised-but-non-aborting semantics as session locks.
 */
export function withAdvisoryLock<T>(
  paths: ScaPaths,
  name: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!LOCK_NAME_PATTERN.test(name)) {
    throw new ScaError('schema_invalid', `lock name ${name} is not a safe token`);
  }
  return withLock('target', path.join(paths.locksDir, name), fn);
}
