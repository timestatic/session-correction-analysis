import { z } from 'zod';

import { ScaError } from '../domain/errors.js';
import { stableStringify } from '../domain/hash.js';

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const usageInputSchema = z.object({
  schema: z.literal('session-correction-analysis/batch-usage-input/v1'),
  expected_agents: z.array(z.string().min(1)).min(1),
  entries: z.array(z.object({
    agent_id: z.string().min(1), model: z.string().min(1), request_id: z.string().min(1),
    mode: z.enum(['cumulative', 'final']), sequence: countSchema,
    noncached_input_tokens: countSchema, cache_read_tokens: countSchema, output_tokens: countSchema,
    active_ms: countSchema.optional(),
  }).strict()),
}).strict();
type Entry = z.infer<typeof usageInputSchema>['entries'][number];
interface UsageTotals {
  requests: number; noncached_input_tokens: number; cache_read_tokens: number; output_tokens: number;
  active_ms: number; requests_missing_active_ms: number;
}
export interface UsageReport {
  schema: string;
  totals: UsageTotals;
  agents: { agent_id: string; models: string[]; totals: UsageTotals }[];
  missing_agents: string[];
  provisional_requests: number;
  duplicate_entries: number;
  warning: string;
}
function emptyTotals(): UsageTotals {
  return { requests: 0, noncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
    active_ms: 0, requests_missing_active_ms: 0 };
}
function counters(entry: Entry): string {
  return stableStringify([entry.noncached_input_tokens, entry.cache_read_tokens, entry.output_tokens, entry.active_ms]);
}
function add(totals: UsageTotals, entry: Entry): void {
  totals.requests += 1;
  totals.noncached_input_tokens += entry.noncached_input_tokens;
  totals.cache_read_tokens += entry.cache_read_tokens;
  totals.output_tokens += entry.output_tokens;
  if (entry.active_ms === undefined) totals.requests_missing_active_ms += 1;
  else totals.active_ms += entry.active_ms;
  if (Object.values(totals).some(value => !Number.isSafeInteger(value))) throw new ScaError('schema_invalid', 'usage totals exceed safe integer range');
}

/** Input counters must be per-request cumulative values, never deltas or agent-wide totals. */
export function summarizeUsage(input: unknown): UsageReport {
  const parsed = usageInputSchema.parse(input);
  if (new Set(parsed.expected_agents).size !== parsed.expected_agents.length) throw new ScaError('schema_invalid', 'expected agent ids must be unique');
  const groups = new Map<string, Entry[]>();
  for (const entry of parsed.entries) {
    if (!parsed.expected_agents.includes(entry.agent_id)) throw new ScaError('schema_invalid', 'usage includes an undeclared agent');
    const key = stableStringify([entry.agent_id, entry.model, entry.request_id]);
    const entries = groups.get(key) ?? [];
    entries.push(entry); groups.set(key, entries);
  }
  const totals = emptyTotals();
  const agents = new Map<string, { agent_id: string; models: Set<string>; totals: UsageTotals }>();
  let provisional = 0;
  let duplicates = 0;
  for (const entries of groups.values()) {
    const sequences = new Map<string, Entry>();
    for (const entry of entries) {
      const key = stableStringify([entry.mode, entry.sequence]);
      const prior = sequences.get(key);
      if (prior !== undefined) {
        if (counters(prior) !== counters(entry)) throw new ScaError('schema_invalid', 'conflicting usage entries for the same request and sequence');
        duplicates += 1;
      } else sequences.set(key, entry);
    }
    const unique = [...sequences.values()];
    const finals = unique.filter(entry => entry.mode === 'final');
    if (finals.some(entry => counters(entry) !== counters(finals[0]!))) throw new ScaError('schema_invalid', 'conflicting final usage receipts');
    const cumulative = unique.filter(entry => entry.mode === 'cumulative').sort((a, b) => a.sequence - b.sequence);
    for (let index = 1; index < cumulative.length; index += 1) {
      const previous = cumulative[index - 1]; const current = cumulative[index];
      if (previous === undefined || current === undefined) continue;
      if (current.noncached_input_tokens < previous.noncached_input_tokens || current.cache_read_tokens < previous.cache_read_tokens || current.output_tokens < previous.output_tokens || (previous.active_ms !== undefined && current.active_ms !== undefined && current.active_ms < previous.active_ms)) throw new ScaError('schema_invalid', 'cumulative usage counters decreased');
    }
    const latest = cumulative.at(-1);
    const selected = finals[0] ?? latest;
    if (selected === undefined) throw new ScaError('schema_invalid', 'empty usage request');
    if (finals.length === 0) provisional += 1;
    else if (latest !== undefined && (selected.noncached_input_tokens < latest.noncached_input_tokens || selected.cache_read_tokens < latest.cache_read_tokens || selected.output_tokens < latest.output_tokens || (selected.active_ms !== undefined && latest.active_ms !== undefined && selected.active_ms < latest.active_ms))) throw new ScaError('schema_invalid', 'final usage is below observed cumulative counters');
    duplicates += Math.max(0, finals.length - 1);
    add(totals, selected);
    const agent = agents.get(selected.agent_id) ?? { agent_id: selected.agent_id, models: new Set<string>(), totals: emptyTotals() };
    agent.models.add(selected.model); add(agent.totals, selected); agents.set(selected.agent_id, agent);
  }
  return { schema: 'session-correction-analysis/batch-usage-report/v1', totals,
    agents: [...agents.values()].map(agent => ({ ...agent, models: [...agent.models].sort() })).sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
    missing_agents: parsed.expected_agents.filter(id => !agents.has(id)), provisional_requests: provisional,
    duplicate_entries: duplicates,
    warning: 'Explicit per-request cumulative/final counters only. Missing agents and provisional requests prevent complete cost claims. Summed agent active time is not wall-clock elapsed time; tokens are not monetary cost.' };
}
