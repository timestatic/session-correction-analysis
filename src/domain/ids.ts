import { z } from 'zod';

import { sha256Hex, stableHash } from './hash.js';

export const HOST_VALUES = ['codex', 'claude'] as const;
export const hostSchema = z.enum(HOST_VALUES);
export type Host = z.infer<typeof hostSchema>;

export const isoDateTimeSchema: z.ZodString = z.string().datetime({ offset: true });
export type IsoDateTime = string;

/**
 * record_id = sha256( JSON array [host, canonical_workspace, source_session_id] ).
 * The JSON-array encoding is required so boundary characters in any component
 * cannot shift the identity across the three fields.
 */
export function computeRecordId(
  host: Host,
  canonicalWorkspace: string,
  sourceSessionId: string,
): string {
  if (canonicalWorkspace.trim() === '' || sourceSessionId.trim() === '') {
    throw new Error('record identity components must not be empty');
  }
  return sha256Hex(JSON.stringify([host, canonicalWorkspace, sourceSessionId]));
}

export const episodeIdSchema: z.ZodString = z.string().regex(/^ep-[0-9a-f]{16}$/);
export type EpisodeId = string;

/** episode_id is derived from record id, main user event id and a stable issue anchor. */
export function computeEpisodeId(
  recordId: string,
  mainUserEventId: string,
  issueAnchor: string,
): EpisodeId {
  return `ep-${sha256Hex(JSON.stringify([recordId, mainUserEventId, issueAnchor])).slice(0, 16)}`;
}

export const candidateIdSchema: z.ZodString = z.string().regex(/^learning-\d{3,}$/);
export type CandidateId = string;

/** Candidate ids are assigned at first ingest and persist; content edits never renumber them. */
export function nextCandidateId(existing: readonly CandidateId[]): CandidateId {
  let max = 0;
  for (const id of existing) {
    const n = Number.parseInt(id.slice('learning-'.length), 10);
    if (!Number.isNaN(n) && n > max) {
      max = n;
    }
  }
  return `learning-${String(max + 1).padStart(3, '0')}`;
}

export function computeCandidateFingerprint(candidate: unknown): string {
  return stableHash(candidate);
}
