import { setTimeout as sleep } from 'node:timers/promises';

import { ScaError } from '../../src/domain/errors.js';
import { adoptApprovedCandidate, recoverPendingAcceptance, setAcceptanceCrashHook } from '../../src/store/acceptance.js';
import { withSessionLock } from '../../src/store/lock.js';
import { RulesRepository } from '../../src/store/rules.js';
import { RecordRepository } from '../../src/store/repository.js';
import { contentVersionHash } from '../../src/review/decide.js';

/**
 * Crash/concurrency victim for tests/integration/rule_acceptance.test.ts. It
 * SIGKILLs itself at a requested durable adoption boundary so the parent sees
 * exactly what a power loss leaves behind — no finally blocks, no lock release.
 *
 * argv: <mode> <record_id> <candidate_id> <request_id> [arg]
 * env:  SCA_DATA_ROOT, SCA_CRASH_POINT
 * mode: adopt | recover | status | hold-analyze
 */

const [mode, recordId, candidateId, requestId, arg] = process.argv.slice(2);
const root = process.env['SCA_DATA_ROOT'];

if (mode === undefined || recordId === undefined || root === undefined || root.length === 0) {
  process.stderr.write('rule_acceptance_child: bad argv\n');
  process.exitCode = 2;
} else {
  const rules = new RulesRepository(root);
  const records = new RecordRepository(root);
  const deps = { rules, records };
  try {
    if (mode === 'adopt') {
      if (candidateId === undefined || requestId === undefined) {
        throw new ScaError('schema_invalid', 'adopt needs a candidate id and a request id');
      }
      const point = process.env['SCA_CRASH_POINT'];
      if (point !== undefined && point.length > 0) {
        setAcceptanceCrashHook((fired) => {
          if (fired === point) {
            process.kill(process.pid, 'SIGKILL');
          }
        });
      }
      const doc = await records.loadCandidates(recordId);
      const candidate = doc.doc.candidates.find((entry) => entry.id === candidateId);
      if (candidate === undefined) {
        throw new ScaError('schema_invalid', `no candidate ${candidateId}`);
      }
      const analyze = await records.loadAnalyze(recordId);
      const registry = await rules.read();
      const pending = registry.state === 'ok' ? registry.doc.pending_acceptance : null;
      const outcome = await adoptApprovedCandidate(deps, {
        request_id: requestId,
        record_id: recordId,
        candidate_id: candidateId,
        expected_revision: pending?.request_id === requestId ? pending.candidate_expected_revision : doc.doc.revision,
        expected_candidate_content_hash: contentVersionHash(candidate),
        scope:
          analyze.doc.workspace === undefined
            ? { kind: 'user' as const }
            : { kind: 'project' as const, canonical_workspace: analyze.doc.workspace },
        confirmed: true,
      });
      process.stdout.write(
        `${JSON.stringify({
          result: outcome.receipt.result,
          replayed: outcome.replayed,
          recovered: outcome.recovered,
          rule_id: outcome.rule.rule_id,
          version: outcome.rule.version,
        })}\n`,
      );
    } else if (mode === 'recover') {
      const report = await recoverPendingAcceptance(deps);
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else if (mode === 'status') {
      process.stdout.write(`${JSON.stringify(await rules.status())}\n`);
    } else if (mode === 'hold-analyze') {
      await withSessionLock(rules.paths, recordId, async () => {
        const current = await records.loadAnalyze(recordId);
        await sleep(Number.parseInt(arg ?? '300', 10));
        await records.updateAnalyze(recordId, current, (doc) => ({
          ...doc,
          extensions: { ...(doc.extensions ?? {}), held_by: requestId ?? 'child' },
        }));
      });
      process.stdout.write('{"held":true}\n');
    } else {
      throw new ScaError('schema_invalid', `unknown mode ${mode}`);
    }
  } catch (err) {
    const error = err instanceof ScaError ? err : undefined;
    process.stdout.write(
      `${JSON.stringify({ error: error?.code ?? 'internal_error', message: (err as Error).message.slice(0, 200) })}\n`,
    );
    process.exitCode = error !== undefined ? 1 : 3;
  }
}
