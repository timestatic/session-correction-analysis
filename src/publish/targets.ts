import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { ScaError } from '../domain/errors.js';
import { atomicWriteText } from '../store/atomic.js';
import { validateSchema } from '../store/frontmatter.js';
import type { ScaPaths } from '../store/paths.js';

/**
 * Plugin-global publish whitelist (design 26.2: target configuration lives in
 * one plugin-global config, never in per-session business files). Callers
 * select targets by target_id — not by arbitrary path — and every resolution
 * miss fails closed with target_not_allowed; publishing stays disabled until
 * the user adds entries here.
 */

export const TARGETS_SCHEMA_ID = 'session-correction-analysis/targets/v1';

export const targetEntrySchema = z
  .object({
    target_id: z.string().regex(/^target-[a-z0-9][a-z0-9-]{0,63}$/),
    display_path: z.string().min(1).max(200),
    /** Fully resolved absolute path; whitelist matching is exact. */
    realpath: z.string().regex(/^\//),
    section: z.string().min(1).max(200).optional(),
  })
  .strict();
export type TargetEntry = z.infer<typeof targetEntrySchema>;

export const targetConfigSchema = z
  .object({
    schema: z.literal(TARGETS_SCHEMA_ID),
    targets: z.array(targetEntrySchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    const spots = new Set<string>();
    for (const entry of config.targets) {
      if (ids.has(entry.target_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate target_id ${entry.target_id}` });
      }
      ids.add(entry.target_id);
      const spot = `${entry.realpath}#${entry.section ?? ''}`;
      if (spots.has(spot)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate target ${spot}` });
      }
      spots.add(spot);
    }
  });
export type TargetConfig = z.infer<typeof targetConfigSchema>;

export function targetsConfigPath(paths: ScaPaths): string {
  return path.join(paths.configDir, 'targets.json');
}

export async function loadTargetConfig(paths: ScaPaths): Promise<TargetConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(targetsConfigPath(paths), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema: TARGETS_SCHEMA_ID, targets: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScaError('schema_invalid', 'targets config is not valid JSON; fix or remove it before publishing');
  }
  return validateSchema(targetConfigSchema, parsed as Record<string, unknown>);
}

async function saveTargetConfig(paths: ScaPaths, config: TargetConfig): Promise<void> {
  await fs.mkdir(paths.configDir, { recursive: true });
  await atomicWriteText(paths.configDir, 'targets.json', `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Resolve the whitelist key for a path whose file may not exist yet: anchor on
 * the nearest existing ancestor so symlinked directories are still followed.
 */
async function anchorRealpath(absPath: string): Promise<string> {
  const missing: string[] = [];
  let cursor = absPath;
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return path.join(real, ...missing.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      missing.push(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new ScaError('target_not_allowed', `cannot resolve ${absPath} against any existing directory`);
      }
      cursor = parent;
    }
  }
}

export async function resolveWhitelistPath(filePath: string): Promise<string> {
  const abs = path.resolve(filePath);
  try {
    return await fs.realpath(abs);
  } catch {
    return anchorRealpath(abs);
  }
}

function slugTargetId(filePath: string): string {
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `target-${slug.length === 0 ? 'file' : slug.slice(0, 64)}`;
}

export interface AddTargetInput {
  readonly filePath: string;
  readonly targetId?: string;
  readonly display?: string;
  readonly section?: string;
}

export async function addTarget(paths: ScaPaths, input: AddTargetInput): Promise<TargetEntry> {
  const real = await resolveWhitelistPath(input.filePath);
  const stat = await fs
    .stat(real)
    .catch(() => undefined);
  if (stat !== undefined && !stat.isFile()) {
    throw new ScaError('schema_invalid', `${real} is not a regular file`);
  }
  const config = await loadTargetConfig(paths);
  const entry: TargetEntry = {
    target_id: input.targetId ?? slugTargetId(real),
    display_path: input.display ?? path.basename(real),
    realpath: real,
    ...(input.section !== undefined ? { section: input.section } : {}),
  };
  targetEntrySchema.parse(entry);
  const sameSpot = config.targets.find((t) => t.realpath === entry.realpath && t.section === entry.section);
  if (sameSpot !== undefined) {
    // Idempotent: re-adding the exact spot returns the existing entry.
    return sameSpot;
  }
  if (config.targets.some((t) => t.target_id === entry.target_id)) {
    throw new ScaError('schema_invalid', `target_id ${entry.target_id} already exists; pass --target-id`);
  }
  await saveTargetConfig(paths, { ...config, targets: [...config.targets, entry] });
  return entry;
}

export async function removeTarget(paths: ScaPaths, targetId: string): Promise<TargetEntry> {
  const config = await loadTargetConfig(paths);
  const removed = config.targets.find((t) => t.target_id === targetId);
  if (removed === undefined) {
    throw new ScaError('schema_invalid', `no whitelist entry with target_id ${targetId}`);
  }
  await saveTargetConfig(paths, { ...config, targets: config.targets.filter((t) => t !== removed) });
  return removed;
}

/** Selector misses fail closed; there is no fuzzy or prefix path matching. */
export async function resolveTarget(
  paths: ScaPaths,
  selector: { targetId?: string; path?: string },
): Promise<TargetEntry> {
  const config = await loadTargetConfig(paths);
  if (config.targets.length === 0) {
    throw new ScaError(
      'target_not_allowed',
      'no publish targets are whitelisted; publish stays disabled until the user adds one with `sca publish add-target`',
    );
  }
  if (selector.targetId !== undefined) {
    const entry = config.targets.find((t) => t.target_id === selector.targetId);
    if (entry === undefined) {
      throw new ScaError('target_not_allowed', `target_id ${selector.targetId} is not whitelisted`);
    }
    return entry;
  }
  if (selector.path !== undefined) {
    const wanted = path.resolve(selector.path);
    const real = await tryReal(wanted);
    const entry = config.targets.find(
      (t) => t.realpath === wanted || t.realpath === real || t.display_path === selector.path,
    );
    if (entry === undefined) {
      throw new ScaError('target_not_allowed', `path ${selector.path} is outside the publish whitelist`);
    }
    return entry;
  }
  if (config.targets.length === 1) {
    return config.targets[0] as TargetEntry;
  }
  throw new ScaError(
    'target_not_allowed',
    config.targets.length === 0
      ? 'no publish targets are whitelisted; publishing stays disabled until the user adds one'
      : 'several targets are whitelisted; pass an explicit --target <target_id>',
  );
}

async function tryReal(filePath: string): Promise<string> {
  return fs.realpath(filePath).catch(() => filePath);
}
