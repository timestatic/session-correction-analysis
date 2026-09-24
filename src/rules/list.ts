import { ScaError } from '../domain/errors.js';
import type { AcceptedRule, RuleScope } from '../domain/rules.js';
import { acceptedRulesPath, loadRegistry } from '../store/registry.js';
import type { RecordRepository } from '../store/repository.js';

/**
 * Read surface for the accepted-rules registry (design 31.7, lightweight):
 * list with project-scope filtering, and one-rule detail that also reports
 * whether the source record is still on file.
 */

export interface RuleSummary {
  rule_id: string;
  title: string;
  status: AcceptedRule['status'];
  version: number;
  target_kind: AcceptedRule['target_kind'];
  scope: RuleScope;
  source: AcceptedRule['source'];
  accepted_at: string;
  updated_at: string;
}

export interface RulesList {
  registry_path: string;
  exists: boolean;
  revision: number;
  count: number;
  rules: RuleSummary[];
}

function summarize(rule: AcceptedRule): RuleSummary {
  return {
    rule_id: rule.rule_id,
    title: rule.title,
    status: rule.status,
    version: rule.version,
    target_kind: rule.target_kind,
    scope: rule.scope,
    source: rule.source,
    accepted_at: rule.accepted_at,
    updated_at: rule.updated_at,
  };
}

export async function listRules(
  repo: RecordRepository,
  filter: { workspace?: string; includeRevoked?: boolean } = {},
): Promise<RulesList> {
  const registry = await loadRegistry(repo.paths);
  let rules = registry.rules;
  if (filter.workspace !== undefined) {
    const workspace = filter.workspace;
    rules = rules.filter(
      (rule) =>
        rule.scope.kind === 'user' ||
        (rule.scope.kind === 'project' && rule.scope.canonical_workspace === workspace),
    );
  }
  if (filter.includeRevoked !== true) {
    rules = rules.filter((rule) => rule.status === 'active');
  }
  return {
    registry_path: acceptedRulesPath(repo.paths),
    exists: registry.revision > 0,
    revision: registry.revision,
    count: rules.length,
    rules: rules.map(summarize),
  };
}

export interface RuleDetail {
  registry_path: string;
  revision: number;
  rule: AcceptedRule;
  record_available: boolean;
}

export async function ruleDetail(repo: RecordRepository, ruleId: string): Promise<RuleDetail> {
  const registry = await loadRegistry(repo.paths);
  const rule = registry.rules.find((r) => r.rule_id === ruleId);
  if (rule === undefined) {
    throw new ScaError('schema_invalid', `rule ${ruleId} is not in the registry`);
  }
  const recordAvailable = await repo
    .loadAnalyze(rule.source.record_id)
    .then(() => true)
    .catch((err: unknown) => {
      if (err instanceof ScaError && err.code === 'session_locator_unavailable') {
        return false;
      }
      throw err;
    });
  return {
    registry_path: acceptedRulesPath(repo.paths),
    revision: registry.revision,
    rule,
    record_available: recordAvailable,
  };
}
