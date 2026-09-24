import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { ScaError } from '../domain/errors.js';
import type { Host } from '../domain/ids.js';
import { canonicalWorkspace, stripTrailingSep } from '../store/paths.js';
import { adaptTranscript } from './index.js';
import { readJsonl } from './reader.js';

/**
 * Marker = one-time lowercase UUIDv4 with a fixed prefix. The value must appear
 * verbatim in a command the host agent ran inside its own session, so a unique
 * hit is self-evidence, not a guess.
 */
export const PROBE_MARKER_PATTERN =
  /^sca-probe-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const probeMarkerSchema = z
  .string()
  .regex(PROBE_MARKER_PATTERN, 'marker must be sca-probe-<lowercase uuidv4>');

export interface DiscoverInput {
  readonly host: Host;
  readonly marker: string;
  readonly homeDir: string;
  readonly workspace?: string;
  readonly now?: Date;
}

export interface DiscoverResult {
  readonly session_id: string;
  readonly transcript_path: string;
  readonly host: Host;
  readonly workspace: string | undefined;
  readonly scanned_dirs: readonly string[];
}

const SCAN_ATTEMPTS = 4;
const SCAN_RETRY_MS = 300;
/**
 * Resumed sessions keep appending inside their original date directory, so the
 * live file is found by write recency, never by calendar folder.
 */
const CODEX_LIVE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function discoverSession(input: DiscoverInput): Promise<DiscoverResult> {
  const markerCheck = probeMarkerSchema.safeParse(input.marker);
  if (!markerCheck.success) {
    throw new ScaError('schema_invalid', 'discover --marker must be sca-probe-<lowercase uuidv4>');
  }
  const { roots, files } = await collectCandidates(input);
  const hits = await scanForMarker(files, input.host, input.marker);
  if (hits.length === 0) {
    throw new ScaError(
      'session_locator_unavailable',
      `no transcript under ${roots.join(', ')} carries the probe marker in command text`,
    );
  }
  if (hits.length > 1) {
    throw new ScaError('location_conflict', `${String(hits.length)} transcripts carry the same probe marker`);
  }
  const hitPath = hits[0]!;
  const transcript = await adaptTranscript(hitPath);
  if (input.workspace !== undefined && transcript.workspace !== undefined) {
    const expected = await canonicalWorkspace(input.workspace);
    const actual = await canonicalWorkspace(transcript.workspace);
    if (expected !== actual) {
      throw new ScaError('record_identity_mismatch', 'discovered transcript cwd differs from --workspace');
    }
  }
  return {
    session_id: transcript.source_session_id,
    transcript_path: hitPath,
    host: input.host,
    workspace: transcript.workspace,
    scanned_dirs: roots,
  };
}

interface Candidates {
  readonly roots: string[];
  readonly files: string[];
}

async function collectCandidates(input: DiscoverInput): Promise<Candidates> {
  if (input.host === 'codex') {
    const root = path.join(input.homeDir, '.codex', 'sessions');
    const cutoff = (input.now ?? new Date()).getTime() - CODEX_LIVE_LOOKBACK_MS;
    return { roots: [root], files: await collectRecentlyModifiedJsonl(root, cutoff) };
  }
  if (input.workspace === undefined) {
    throw new ScaError('schema_invalid', 'discover --host claude needs --workspace to derive the project directory');
  }
  const dir = path.join(input.homeDir, '.claude', 'projects', claudeProjectDir(input.workspace));
  return { roots: [dir], files: await listJsonl(dir) };
}

async function collectRecentlyModifiedJsonl(root: string, cutoffMs: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const stat = await fs.stat(full).catch(() => undefined);
      if (stat !== undefined && stat.mtimeMs >= cutoffMs) {
        found.push(full);
      }
    }
  };
  await walk(root);
  return found.sort();
}

function claudeProjectDir(workspace: string): string {
  return stripTrailingSep(path.resolve(workspace)).replace(/[^a-zA-Z0-9]/g, '-');
}

async function listJsonl(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((entry) => entry.endsWith('.jsonl'))
    .sort()
    .map((entry) => path.join(dir, entry));
}

async function scanForMarker(files: readonly string[], host: Host, marker: string): Promise<string[]> {
  if (files.length === 0) {
    return [];
  }
  // The host appends the tool-call line around the time it spawns us; a bounded
  // re-scan of the same file list covers that flush race without widening scope.
  for (let attempt = 0; attempt < SCAN_ATTEMPTS; attempt += 1) {
    const hits: string[] = [];
    for (const file of files) {
      if (await commandTextMentions(file, host, marker)) {
        hits.push(file);
      }
    }
    if (hits.length > 0) {
      return hits;
    }
    if (attempt < SCAN_ATTEMPTS - 1) {
      await delay(SCAN_RETRY_MS);
    }
  }
  return [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface ProbeLine {
  type?: string;
  payload?: { type?: string; arguments?: unknown; input?: unknown };
  message?: { content?: unknown };
}

/** Only the command text of tool calls counts; echoes in outputs would not prove causality. */
async function commandTextMentions(filePath: string, host: Host, marker: string): Promise<boolean> {
  for await (const line of readJsonl(filePath)) {
    if (line.malformed || !line.raw.includes(marker)) {
      continue;
    }
    const record = line.value as ProbeLine;
    if (host === 'codex') {
      if (record.type !== 'response_item') {
        continue;
      }
      const payload = record.payload;
      if (payload === undefined) {
        continue;
      }
      const kind = payload.type;
      if (kind !== 'function_call' && kind !== 'custom_tool_call') {
        continue;
      }
      const rawInput = kind === 'function_call' && payload.arguments !== undefined ? payload.arguments : payload.input;
      if (stringifyInput(rawInput).includes(marker)) {
        return true;
      }
      continue;
    }
    if (record.type !== 'assistant') {
      continue;
    }
    const content = record.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const entry of content as { type?: string; input?: unknown }[]) {
      if (entry.type === 'tool_use' && stringifyInput(entry.input).includes(marker)) {
        return true;
      }
    }
  }
  return false;
}

function stringifyInput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value ?? '');
}
