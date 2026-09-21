import { realpath } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';

import { ScaError } from '../domain/errors.js';

export interface RegisteredSession {
  record_id: string;
  transcript_path: string;
}

/** Built from the plugin's own records (and, in the future, host-visible indexes). Never a full-history scan. */
export interface SessionIndex {
  lookup(sourceSessionId: string): Promise<RegisteredSession | null>;
}

export interface LocatorInput {
  transcriptPath?: string;
  sessionId?: string;
}

export interface ResolvedSource {
  transcriptPath: string;
  registered?: RegisteredSession;
}

function assertReadable(filePath: string): void {
  try {
    accessSync(filePath, constants.R_OK);
  } catch {
    throw new ScaError('transcript_unreadable', filePath);
  }
}

/**
 * Explicit locators win and conflicting explicit locators fail closed
 * (design 6.3 / 22.1). Missing registrations are never recovered by scanning history.
 */
export async function resolveSource(input: LocatorInput, index: SessionIndex): Promise<ResolvedSource> {
  if (input.transcriptPath === undefined && input.sessionId === undefined) {
    throw new ScaError('session_locator_unavailable', 'pass --session <id> or --transcript <path>');
  }

  if (input.sessionId !== undefined) {
    const registered = await index.lookup(input.sessionId);
    if (registered === null) {
      throw new ScaError(
        'session_locator_unavailable',
        `session ${input.sessionId} is not registered; provide --transcript <path>`,
      );
    }
    if (input.transcriptPath !== undefined) {
      const expected = await realpath(registered.transcript_path).catch(() => registered.transcript_path);
      const given = await realpath(input.transcriptPath).catch(() => input.transcriptPath);
      if (expected !== given) {
        throw new ScaError(
          'location_conflict',
          'explicit --transcript does not match the registered transcript for this session',
        );
      }
    }
    assertReadable(registered.transcript_path);
    return { transcriptPath: registered.transcript_path, registered };
  }

  const path = input.transcriptPath;
  if (path === undefined) {
    throw new ScaError('session_locator_unavailable');
  }
  assertReadable(path);
  return { transcriptPath: path };
}
