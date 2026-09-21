import type { Event } from '../domain/events.js';
import type { Host } from '../domain/ids.js';
import type { Coverage } from '../domain/snapshot.js';

export interface TranscriptStats {
  total_lines: number;
  bad_lines: number;
  tail_incomplete: boolean;
  mirrors_merged: number;
  compacted_records: number;
  sidechain_records: number;
  ignored_records: Record<string, number>;
}

export interface NormalizedTranscript {
  host: Host;
  source_session_id: string;
  workspace?: string;
  title?: string;
  coverage: Coverage;
  events: Event[];
  stats: TranscriptStats;
  parser_version: string;
}

export const PARSER_VERSION = '0.1.1';

export function emptyStats(): TranscriptStats {
  return {
    total_lines: 0,
    bad_lines: 0,
    tail_incomplete: false,
    mirrors_merged: 0,
    compacted_records: 0,
    sidechain_records: 0,
    ignored_records: {},
  };
}

export function bumpIgnored(stats: TranscriptStats, key: string): void {
  stats.ignored_records[key] = (stats.ignored_records[key] ?? 0) + 1;
}

/**
 * Design 22.1: an incomplete tail line proves the file was mid-write, so the
 * frozen range is not the whole session — never report `full` in that case.
 */
export function coverageFromStats(stats: TranscriptStats): Coverage {
  return stats.bad_lines > 0 || stats.tail_incomplete ? 'partial' : 'full';
}
