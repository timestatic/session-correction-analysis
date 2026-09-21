import { ScaError } from '../domain/errors.js';
import { FORMAT_SNIFF_LINES } from '../domain/limits.js';
import { adaptClaude } from './claude.js';
import { adaptCodex } from './codex.js';
import { adaptNormalized } from './normalized.js';
import { readJsonl } from './reader.js';
import type { NormalizedTranscript } from './types.js';
import { canonicalWorkspace } from '../store/paths.js';
import type { Host } from '../domain/ids.js';

export async function assertTranscriptIdentity(
  transcript: Pick<NormalizedTranscript, 'host' | 'source_session_id' | 'workspace'>,
  expected: { host: Host; sessionId: string; workspace?: string },
): Promise<void> {
  if (transcript.host !== expected.host || transcript.source_session_id !== expected.sessionId) {
    throw new ScaError('record_identity_mismatch', 'transcript host/session does not match the requested record');
  }
  if (transcript.workspace !== undefined && expected.workspace !== undefined &&
      await canonicalWorkspace(transcript.workspace) !== await canonicalWorkspace(expected.workspace)) {
    throw new ScaError('record_identity_mismatch', 'transcript workspace does not match the requested record');
  }
}

export type TranscriptFormat = 'codex' | 'claude' | 'normalized';

/** Sniffs only the head of the file; unknown formats fail loudly instead of field guessing. */
export async function detectFormat(filePath: string): Promise<TranscriptFormat> {
  let inspected = 0;
  for await (const line of readJsonl(filePath)) {
    if (line.malformed) {
      continue;
    }
    inspected += 1;
    const record = line.value as Record<string, unknown>;
    if (record['type'] === 'session_meta' || record['type'] === 'response_item' || record['type'] === 'event_msg') {
      return 'codex';
    }
    if (
      (record['type'] === 'user' || record['type'] === 'assistant') &&
      typeof record['sessionId'] === 'string'
    ) {
      return 'claude';
    }
    if (record['type'] === 'meta' && typeof record['source_session_id'] === 'string') {
      return 'normalized';
    }
    if (inspected >= FORMAT_SNIFF_LINES) {
      break;
    }
  }
  throw new ScaError('unsupported_transcript', `no known record shape in ${filePath}`);
}

export async function adaptTranscript(filePath: string): Promise<NormalizedTranscript> {
  const format = await detectFormat(filePath);
  switch (format) {
    case 'codex':
      return adaptCodex(filePath);
    case 'claude':
      return adaptClaude(filePath);
    case 'normalized':
      return adaptNormalized(filePath);
  }
}

export { adaptCodex } from './codex.js';
export { adaptClaude } from './claude.js';
export { adaptNormalized } from './normalized.js';
export { endsWithNewline, readJsonl } from './reader.js';
export * from './types.js';
