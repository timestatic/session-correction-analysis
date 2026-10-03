import { stableHash, stableStringify } from '../domain/hash.js';
import { validateManifest } from './integrity.js';
import type { BatchManifest, SourceSnapshot } from './schema.js';

interface EvidencePosition {
  source: SourceSnapshot;
  source_index: number;
  event_index: number;
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

export class BatchReadContext {
  readonly manifest: BatchManifest;
  readonly manifest_hash: string;
  readonly #positions = new Map<string, EvidencePosition>();
  readonly #targets = new Map<string, BatchManifest['targets']>();
  readonly #costs = new Map<string, number>();

  private constructor(manifest: BatchManifest) {
    freeze(manifest);
    this.manifest = manifest;
    this.manifest_hash = stableHash(manifest);
    for (const [sourceIndex, source] of manifest.sources.entries()) {
      for (const [eventIndex, event] of source.events.entries()) {
        this.#positions.set(event.evidence_id, Object.freeze({ source, source_index: sourceIndex, event_index: eventIndex }));
      }
    }
    for (const target of manifest.targets) {
      const group = this.#targets.get(target.evidence_id) ?? [];
      group.push(target);
      this.#targets.set(target.evidence_id, group);
    }
    for (const group of this.#targets.values()) Object.freeze(group);
    Object.freeze(this);
  }

  static create(input: unknown): BatchReadContext {
    return new BatchReadContext(validateManifest(input));
  }

  position(evidenceId: string): EvidencePosition | undefined {
    return this.#positions.get(evidenceId);
  }

  targets(evidenceId: string): readonly BatchManifest['targets'][number][] {
    return this.#targets.get(evidenceId) ?? [];
  }

  evidenceCost(evidenceId: string): number {
    const cached = this.#costs.get(evidenceId);
    if (cached !== undefined) return cached;
    const position = this.position(evidenceId);
    if (position === undefined) return 0;
    const cost = Buffer.byteLength(stableStringify({ event: position.source.events[position.event_index]?.event,
      actor: position.source.input.role, role_basis: position.source.input.role_basis }));
    this.#costs.set(evidenceId, cost);
    return cost;
  }
}
