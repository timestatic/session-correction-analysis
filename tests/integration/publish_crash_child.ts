import { runCli } from '../../src/cli.js';
import { publishCandidate, setPublishCrashHook, type PublishCrashPoint } from '../../src/publish/publish.js';
import { RecordRepository } from '../../src/store/repository.js';

/**
 * Crash victim for tests/integration/publish_crash.test.ts. Runs the real
 * publish flow and SIGKILLs itself at the requested durable boundary, so the
 * parent observes exactly what a power loss leaves behind (no finally blocks,
 * no lock release, no cleanup).
 *
 * argv: <mode> <record_id> <candidate_id> <preview_id> <expected_revision>
 * env:  SCA_DATA_ROOT
 * mode: before_target | after_target | after_state | publish-cli
 */

const [mode, recordId, candidateId, previewId, revisionRaw] = process.argv.slice(2);
if (mode === undefined || recordId === undefined || candidateId === undefined || previewId === undefined) {
  process.stderr.write('publish_crash_child: bad argv\n');
  process.exitCode = 3;
} else {
  const request = {
    candidate_id: candidateId,
    preview_id: previewId,
    expected_revision: Number.parseInt(revisionRaw ?? '0', 10),
  };
  const root = process.env['SCA_DATA_ROOT'];
  if (mode === 'publish-cli') {
    process.exitCode = await runCli(
      ['publish', 'commit', recordId, '--candidate', candidateId, '--preview', previewId, '--expected-revision', String(request.expected_revision)],
      { env: process.env, stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) },
    );
  } else {
    const point = mode as PublishCrashPoint;
    setPublishCrashHook((fired) => {
      if (fired === point) {
        process.kill(process.pid, 'SIGKILL');
      }
    });
    const repo = new RecordRepository(root === undefined || root.length === 0 ? undefined : root);
    const outcome = await publishCandidate(repo, recordId, request);
    process.stdout.write(`${JSON.stringify({ phase: outcome.phase, revision: outcome.revision })}\n`);
    process.exitCode = 0;
  }
}
