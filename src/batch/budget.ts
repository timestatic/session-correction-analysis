import { z } from 'zod';

import { summarizeUsage, usageInputSchema } from './usage.js';

const limitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const budgetInputSchema = z.object({
  schema: z.literal('session-correction-analysis/batch-budget-input/v1'),
  usage: usageInputSchema,
  limits: z.object({ noncached_input_tokens: limitSchema.optional(), cache_read_tokens: limitSchema.optional(),
    output_tokens: limitSchema.optional(), active_ms: limitSchema.optional() }).strict().refine(limits => Object.keys(limits).length > 0, 'at least one limit is required'),
  warning_fraction: z.number().positive().max(1),
}).strict();
export interface BudgetReport {
  schema: string; status: 'exceeded' | 'indeterminate' | 'warning' | 'within';
  checks: { metric: string; observed: number; limit: number; fraction: number;
    status: 'exceeded' | 'indeterminate' | 'warning' | 'within' }[];
  missing_agents: string[]; provisional_requests: number;
  recommended_action: string;
}
export function checkBudget(input: unknown): BudgetReport {
  const parsed = budgetInputSchema.parse(input);
  const usage = summarizeUsage(parsed.usage);
  const checks: BudgetReport['checks'] = [];
  for (const metric of ['noncached_input_tokens', 'cache_read_tokens', 'output_tokens', 'active_ms'] as const) {
    const limit = parsed.limits[metric];
    if (limit === undefined) continue;
    const observed = usage.totals[metric];
    const incomplete = usage.missing_agents.length > 0 || usage.provisional_requests > 0 || (metric === 'active_ms' && usage.totals.requests_missing_active_ms > 0);
    const status = observed >= limit ? 'exceeded' : incomplete ? 'indeterminate' : observed >= limit * parsed.warning_fraction ? 'warning' : 'within';
    checks.push({ metric, observed, limit, fraction: observed / limit, status });
  }
  const status = checks.some(check => check.status === 'exceeded') ? 'exceeded' : checks.some(check => check.status === 'indeterminate') ? 'indeterminate' : checks.some(check => check.status === 'warning') ? 'warning' : 'within';
  return { schema: 'session-correction-analysis/batch-budget-report/v1', status, checks,
    missing_agents: usage.missing_agents, provisional_requests: usage.provisional_requests,
    recommended_action: status === 'exceeded' ? 'Do not allocate more work before reviewing the budget; cancel running tasks only through their current fenced receipt.' : status === 'indeterminate' ? 'Collect missing agents and final usage receipts before claiming remaining budget.' : status === 'warning' ? 'Review remaining budget before allocating more work.' : 'Observed complete exported usage is below configured limits; this is not a prediction or automatic authorization.' };
}
