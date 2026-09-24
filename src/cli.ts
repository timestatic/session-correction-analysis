#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { triggerSchema } from './domain/documents.js';
import { ScaError } from './domain/errors.js';
import { hostSchema } from './domain/ids.js';
import { prepareRecord } from './analysis/prepare.js';
import { ingestSubmission } from './analysis/ingest.js';
import { adaptTranscript, assertTranscriptIdentity } from './hosts/index.js';
import { discoverSession } from './hosts/discover.js';
import { applyDecision, type DecisionRequest } from './review/decide.js';
import { adoptCandidate, revokeRule } from './rules/adopt.js';
import { listRules, ruleDetail } from './rules/list.js';
import type { AcceptedRule } from './domain/rules.js';
import { candidateContent } from './review/content.js';
import { candidateDetail } from './review/detail.js';
import { approvalMetrics } from './review/metrics.js';
import { allowedActions } from './domain/states.js';
import { splitFrontmatter } from './store/frontmatter.js';
import { RECORD_ID_PATTERN, assertSafeRecordId, canonicalWorkspace, resolvePaths } from './store/paths.js';
import { assertSingleNotesSection } from './store/notes.js';
import { RecordRepository, type RegisterInput } from './store/repository.js';
import { readBoundedFile, readBoundedText } from './store/bounded.js';
import { PENDING_COMMIT_MAX_BYTES } from './domain/limits.js';

export const CLI_VERSION = '0.1.0';

/** Must stay in sync with package.json `engines.node`. No upper bound: newer majors are supported until proven otherwise. */
export const MIN_NODE_MAJOR = 22;

const COMMANDS = ['doctor', 'discover', 'register', 'validate', 'prepare', 'ingest', 'review', 'adopt', 'rules'] as const;
type Command = (typeof COMMANDS)[number];

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(line: string): void;
  stderr(line: string): void;
  /** Provided only for real process runs so tests never block on an open stdin. */
  readStdin?(): Promise<string>;
}

type OptionValues = NonNullable<ParseArgsConfig['options']>;
interface ParsedArgs {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

/**
 * Exit codes: 0 success, 1 a diagnostic failed (doctor/validate report),
 * 2 the command raised a catalogued ScaError, 3 usage/parsing error.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || !isCommand(command)) {
    io.stderr(USAGE);
    return 3;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseCommand(command, rest);
  } catch (err) {
    io.stderr(`usage error: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
  try {
    switch (command) {
      case 'doctor':
        return await doctorCommand(parsed.values, io);
      case 'discover':
        return await discoverCommand(parsed.values, io);
      case 'register':
        return await registerCommand(parsed.values, io);
      case 'validate':
        return await validateCommand(parsed.values, parsed.positionals, io);
      case 'prepare':
        return await prepareCommand(parsed.values, parsed.positionals, io);
      case 'ingest':
        return await ingestCommand(parsed.values, parsed.positionals, io);
      case 'review':
        return await reviewCommand(parsed.values, parsed.positionals, io);
      case 'adopt':
        return await adoptCommand(parsed.values, parsed.positionals, io);
      case 'rules':
        return await rulesCommand(parsed.values, io);
    }
  } catch (err) {
    return reportError(err, io);
  }
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function parseCommand(command: Command, args: string[]): ParsedArgs {
  const options: OptionValues = { 'data-root': { type: 'string' } };
  if (command === 'discover') {
    Object.assign(options, {
      host: { type: 'string' },
      marker: { type: 'string' },
      workspace: { type: 'string' },
      home: { type: 'string' },
    });
  } else if (command === 'register') {
    Object.assign(options, {
      host: { type: 'string' },
      session: { type: 'string' },
      workspace: { type: 'string' },
      transcript: { type: 'string' },
      trigger: { type: 'string' },
      title: { type: 'string' },
      project: { type: 'string' },
      'analyzer-version': { type: 'string' },
    });
  } else if (command === 'validate') {
    options['all'] = { type: 'boolean' };
  } else if (command === 'prepare') {
    Object.assign(options, {
      owner: { type: 'string' },
      'ttl-ms': { type: 'string' },
      'rule-version': { type: 'string' },
    });
  } else if (command === 'ingest') {
    Object.assign(options, {
      run: { type: 'string' },
      submission: { type: 'string' },
      owner: { type: 'string' },
    });
  } else if (command === 'review') {
    Object.assign(options, {
      candidate: { type: 'string' },
      action: { type: 'string' },
      request: { type: 'string' },
      'expected-revision': { type: 'string' },
      note: { type: 'string' },
      'content-file': { type: 'string' },
      title: { type: 'string' },
      'target-kind': { type: 'string' },
      'harness-path': { type: 'string' },
      scope: { type: 'string' },
      out: { type: 'string' },
    });
  } else if (command === 'adopt') {
    Object.assign(options, {
      candidate: { type: 'string' },
      request: { type: 'string' },
      'expected-revision': { type: 'string' },
      scope: { type: 'string' },
      note: { type: 'string' },
    });
  } else if (command === 'rules') {
    Object.assign(options, {
      rule: { type: 'string' },
      revoke: { type: 'string' },
      request: { type: 'string' },
      'expected-revision': { type: 'string' },
      note: { type: 'string' },
      workspace: { type: 'string' },
      all: { type: 'boolean' },
    });
  }
  const result = parseArgs({
    args,
    options,
    allowPositionals:
      command === 'validate' ||
      command === 'prepare' ||
      command === 'ingest' ||
      command === 'review' ||
      command === 'adopt',
    strict: true,
  });
  return { values: result.values as ParsedArgs['values'], positionals: [...result.positionals] };
}

function getString(values: ParsedArgs['values'], key: string): string | undefined {
  const raw = values[key];
  return typeof raw === 'string' ? raw : undefined;
}

function reportError(err: unknown, io: CliIo): number {
  if (err instanceof ScaError) {
    io.stdout(JSON.stringify({ ok: false, error: err.toPayload() }));
    return 2;
  }
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  io.stdout(
    JSON.stringify({
      ok: false,
      error: { code: 'internal_error', message: detail, retryable: false, next_step: 'Report this failure.' },
    }),
  );
  return 2;
}

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

async function doctorCommand(values: ParsedArgs['values'], io: CliIo): Promise<number> {
  const checks: Check[] = [];
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'node_version',
    status: major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail: `process.versions.node=${process.versions.node}, required >=${MIN_NODE_MAJOR}`,
  });

  const pathEntries = (io.env['PATH'] ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  const reachable = await Promise.all(
    pathEntries.map(async (dir) =>
      fs
        .access(path.join(dir, 'node'))
        .then(() => true)
        .catch(() => false),
    ),
  );
  checks.push({
    name: 'node_on_path',
    status: reachable.includes(true) ? 'ok' : 'warn',
    detail: `execPath=${process.execPath}; a node binary is ${reachable.includes(true) ? 'reachable' : 'missing'} on PATH (non-interactive installs rely on it; NVM upgrades can invalidate pinned paths)`,
  });

  const root = getString(values, 'data-root') ?? io.env['SCA_DATA_ROOT'];
  const paths = resolvePaths(root === undefined || root.length === 0 ? undefined : root);
  checks.push(await dataRootCheck(paths.recordsDir, paths.runtimeDir));
  checks.push(await packageCheck());
  checks.push({
    name: 'host_capabilities',
    status: 'warn',
    detail: 'Phase 1: explicit session analysis, human review and text export. Use a new --data-root; legacy rule/publication records are unsupported. Hook and scheduling are not available.',
  });

  const failed = checks.some((c) => c.status === 'fail');
  io.stdout(JSON.stringify({ ok: !failed, command: 'doctor', version: CLI_VERSION, checks }, null, 2));
  return failed ? 1 : 0;
}

async function dataRootCheck(recordsDir: string, runtimeDir: string): Promise<Check> {
  try {
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.mkdir(runtimeDir, { recursive: true });
    const probe = path.join(runtimeDir, `doctor-probe-${process.pid}.tmp`);
    await fs.writeFile(probe, 'probe', 'utf8');
    await fs.unlink(probe);
    return { name: 'data_root', status: 'ok', detail: `${path.dirname(recordsDir)} is writable` };
  } catch (err) {
    return {
      name: 'data_root',
      status: 'fail',
      detail: `${path.dirname(recordsDir)} is not usable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function packageCheck(): Promise<Check> {
  // dist/src/cli.js -> package.json sits two levels up; source runs keep working via cwd fallback.
  const candidates = [
    path.join(import.meta.dirname, '..', '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      const versionMatches = pkg.version === CLI_VERSION;
      return {
        name: 'package',
        status: pkg.name === 'session-correction-analysis' && versionMatches ? 'ok' : 'warn',
        detail: `name=${pkg.name ?? '?'}, version=${pkg.version ?? '?'}, CLI_VERSION=${CLI_VERSION}; release checksum manifests land with packaging (design 25.4)`,
      };
    } catch {
      // try the next candidate
    }
  }
  return { name: 'package', status: 'warn', detail: 'package.json not found next to the bundle' };
}

async function discoverCommand(values: ParsedArgs['values'], io: CliIo): Promise<number> {
  const hostResult = hostSchema.safeParse(getString(values, 'host'));
  const marker = getString(values, 'marker');
  if (!hostResult.success || marker === undefined) {
    throw new ScaError('schema_invalid', 'discover requires --host codex|claude and --marker sca-probe-<uuidv4>');
  }
  const workspace = getString(values, 'workspace');
  const home = getString(values, 'home') ?? io.env['HOME'];
  const result = await discoverSession({
    host: hostResult.data,
    marker,
    homeDir: path.resolve(home === undefined || home.length === 0 ? os.homedir() : home),
    ...(workspace !== undefined ? { workspace } : {}),
  });
  io.stdout(JSON.stringify({ ok: true, command: 'discover', ...result }));
  return 0;
}

async function registerCommand(values: ParsedArgs['values'], io: CliIo): Promise<number> {
  const hostResult = hostSchema.safeParse(getString(values, 'host'));
  const sessionId = getString(values, 'session');
  const workspace = getString(values, 'workspace');
  const transcript = getString(values, 'transcript');
  if (!hostResult.success || sessionId === undefined || workspace === undefined || transcript === undefined) {
    throw new ScaError('schema_invalid', 'register requires --host codex|claude, --session, --workspace, --transcript');
  }
  const triggerResult = triggerSchema.safeParse(getString(values, 'trigger') ?? 'manual_skill');
  if (!triggerResult.success) {
    throw new ScaError('schema_invalid', 'register --trigger must be session_end|manual_skill|scheduled_drain|explicit_import');
  }
  const host = hostResult.data;
  const trigger = triggerResult.data;
  const transcriptPath = path.resolve(transcript);
  try {
    const stat = await fs.stat(transcriptPath);
    if (!stat.isFile()) {
      throw new ScaError('transcript_unreadable', `--transcript ${transcriptPath} is not a regular file`);
    }
  } catch (err) {
    if (err instanceof ScaError) {
      throw err;
    }
    throw new ScaError('transcript_unreadable', `--transcript ${transcriptPath} is missing or unreadable`);
  }
  // Verify the source identity before creating a record, not just its file format.
  await assertTranscriptIdentity(await adaptTranscript(transcriptPath), { host, sessionId, workspace });

  const root = getString(values, 'data-root') ?? io.env['SCA_DATA_ROOT'];
  const repo = new RecordRepository(root === undefined || root.length === 0 ? undefined : root);
  const canonical = await canonicalWorkspace(workspace);
  const title = getString(values, 'title');
  const project = getString(values, 'project');
  const input: RegisterInput = {
    host,
    canonicalWorkspace: canonical,
    sessionId,
    transcriptPath,
    trigger,
    analyzerVersion: getString(values, 'analyzer-version') ?? CLI_VERSION,
    ...(title !== undefined ? { title } : {}),
    ...(project !== undefined ? { projectName: project } : {}),
  };
  const result = await repo.register(input);
  io.stdout(
    JSON.stringify({
      ok: true,
      command: 'register',
      record_id: result.recordId,
      created: result.created,
      analysis_status: result.analyze.doc.analysis_status,
      record_dir: path.join(repo.paths.recordsDir, result.recordId),
    }),
  );
  return 0;
}

async function prepareCommand(
  values: ParsedArgs['values'],
  positionals: string[],
  io: CliIo,
): Promise<number> {
  const id = positionals[0];
  if (id === undefined) {
    throw new ScaError('schema_invalid', 'prepare needs a <record_id>');
  }
  assertSafeRecordId(id);
  const root = getString(values, 'data-root') ?? io.env['SCA_DATA_ROOT'];
  const repo = new RecordRepository(root === undefined || root.length === 0 ? undefined : root);
  const ttlRaw = getString(values, 'ttl-ms');
  const ttlMs = ttlRaw === undefined ? undefined : Number.parseInt(ttlRaw, 10);
  if (ttlRaw !== undefined && (ttlMs === undefined || Number.isNaN(ttlMs) || ttlMs <= 0)) {
    throw new ScaError('schema_invalid', 'prepare --ttl-ms must be a positive integer');
  }
  const ruleVersion = getString(values, 'rule-version');
  const outcome = await prepareRecord(repo, id, {
    owner: getString(values, 'owner') ?? 'cli',
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(ruleVersion !== undefined ? { ruleVersion } : {}),
  });
  io.stdout(
    JSON.stringify({
      ok: true,
      command: 'prepare',
      record_id: outcome.packet.record_id,
      run_id: outcome.packet.run_id,
      analysis_id: outcome.packet.analysis_id,
      input_hash: outcome.packet.input_hash,
      lease_generation: outcome.fence.generation,
      lease_expires_at: outcome.lease.expires_at,
      coverage: outcome.packet.snapshot.coverage,
      evidence_count: outcome.packet.evidence.length,
      user_message_count: outcome.packet.user_coverage.length,
      blocks: outcome.packet.blocks.length,
      existing_candidate_count: outcome.packet.existing_candidates.length,
      changed_since_last_analysis: outcome.changed_since_last_analysis,
      packet_path: outcome.packetPath,
    }),
  );
  return 0;
}

async function ingestCommand(
  values: ParsedArgs['values'],
  positionals: string[],
  io: CliIo,
): Promise<number> {
  const id = positionals[0];
  if (id === undefined) {
    throw new ScaError('schema_invalid', 'ingest needs a <record_id>');
  }
  assertSafeRecordId(id);
  const runId = getString(values, 'run');
  if (runId === undefined) {
    throw new ScaError('schema_invalid', 'ingest needs --run <run_id> returned by prepare');
  }
  const submissionPath = getString(values, 'submission') ?? '-';
  let raw: string;
  if (submissionPath === '-') {
    if (io.readStdin === undefined) {
      throw new ScaError('schema_invalid', 'no stdin in this context; pass --submission <path>');
    }
    raw = await io.readStdin();
  } else {
    raw = await readBoundedFile(path.resolve(submissionPath), PENDING_COMMIT_MAX_BYTES).catch((error: unknown) => {
      if (error instanceof ScaError) throw error;
      throw new ScaError('schema_invalid', `submission file ${submissionPath} is missing or unreadable`);
    });
  }
  const root = getString(values, 'data-root') ?? io.env['SCA_DATA_ROOT'];
  const repo = new RecordRepository(root === undefined || root.length === 0 ? undefined : root);
  const result = await ingestSubmission(repo, id, runId, raw, getString(values, 'owner') ?? 'cli');
  io.stdout(JSON.stringify({ ok: true, command: 'ingest', ...result }));
  return 0;
}

function getPositiveInt(values: ParsedArgs['values'], key: string): number | undefined {
  const raw = getString(values, key);
  if (raw === undefined) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new ScaError('schema_invalid', `${key} must be a positive integer`);
  }
  return n;
}

async function readContent(values: ParsedArgs['values'], io: CliIo): Promise<string | undefined> {
  const file = getString(values, 'content-file');
  if (file === undefined) {
    return undefined;
  }
  if (file === '-') {
    if (io.readStdin === undefined) {
      throw new ScaError('schema_invalid', 'no stdin in this context; pass --content-file <path>');
    }
    return io.readStdin();
  }
  return fs.readFile(path.resolve(file), 'utf8').catch(() => {
    throw new ScaError('schema_invalid', `content file ${file} is missing or unreadable`);
  });
}

async function reviewCommand(
  values: ParsedArgs['values'],
  positionals: string[],
  io: CliIo,
): Promise<number> {
  const id = positionals[0];
  if (id === undefined) {
    throw new ScaError('schema_invalid', 'review needs a <record_id>');
  }
  assertSafeRecordId(id);
  const root = getString(values, 'data-root') ?? io.env['SCA_DATA_ROOT'];
  const repo = new RecordRepository(root === undefined || root.length === 0 ? undefined : root);
  const action = getString(values, 'action');

  if (action === undefined && getString(values, 'candidate') !== undefined) {
    const detail = await candidateDetail(repo, id, getString(values, 'candidate')!);
    io.stdout(JSON.stringify({ ok: true, command: 'review', record_id: id, ...detail }));
    return 0;
  }

  if (action === undefined) {
    const { analyze, candidates } = await repo.loadRecord(id);
    const doc = candidates.doc;
    io.stdout(
      JSON.stringify({
        ok: true,
        command: 'review',
        record_id: id,
        revision: doc.revision,
        analysis_status: analyze.doc.analysis_status,
        candidates: doc.candidates.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          maturity: c.maturity,
          target_kind: c.target.kind,
          allowed_actions: allowedActions(c),
          needs_review: c.needs_review !== undefined,
          updated_at: c.updated_at,
        })),
        metrics: approvalMetrics(doc.candidates),
      }),
    );
    return 0;
  }

  const candidateId = getString(values, 'candidate');
  if (action === 'copy_content' || action === 'export_content') {
    if (candidateId === undefined) {
      throw new ScaError('schema_invalid', `${action} needs --candidate <id>`);
    }
    const out = getString(values, 'out');
    const outcome = await candidateContent(repo, id, candidateId, action, out !== undefined ? { outPath: out } : {});
    io.stdout(
      JSON.stringify({
        ok: true,
        command: 'review',
        record_id: id,
        action,
        content: outcome.content,
        ...(outcome.exported_to !== undefined ? { exported_to: outcome.exported_to } : {}),
      }),
    );
    return 0;
  }
  const requestId = getString(values, 'request');
  const expectedRevision = getPositiveInt(values, 'expected-revision');
  if (candidateId === undefined || requestId === undefined || expectedRevision === undefined) {
    throw new ScaError('schema_invalid', 'review decide needs --candidate, --request and --expected-revision');
  }
  const content = await readContent(values, io);
  const note = getString(values, 'note');
  const title = getString(values, 'title');
  const scope = getString(values, 'scope');
  const targetKind = getString(values, 'target-kind');
  const harnessPath = getString(values, 'harness-path');
  const request: DecisionRequest = {
    request_id: requestId,
    candidate_id: candidateId,
    action: action as DecisionRequest['action'],
    expected_revision: expectedRevision,
    ...(note !== undefined ? { note } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(targetKind !== undefined
      ? { target: targetKind === 'memory' ? { kind: 'memory' } : { kind: 'harness', ...(harnessPath !== undefined ? { path: harnessPath } : {}) } }
      : {}),
  };
  const outcome = await applyDecision(repo, id, request);
  io.stdout(
    JSON.stringify({
      ok: true,
      command: 'review',
      record_id: id,
      receipt: outcome.receipt,
      duplicate: outcome.duplicate,
      revision: outcome.revision,
      candidate: { id: outcome.candidate.id, status: outcome.candidate.status, title: outcome.candidate.title },
    }),
  );
  return 0;
}

function summarizeRule(rule: AcceptedRule): {
  rule_id: string;
  title: string;
  status: string;
  version: number;
  scope: AcceptedRule['scope'];
} {
  return { rule_id: rule.rule_id, title: rule.title, status: rule.status, version: rule.version, scope: rule.scope };
}

function repositoryFor(values: ParsedArgs['values'], io: CliIo): RecordRepository {
  const root = getString(values, 'data-root') ?? io.env['SCA_DATA_ROOT'];
  return new RecordRepository(root === undefined || root.length === 0 ? undefined : root);
}

async function adoptCommand(
  values: ParsedArgs['values'],
  positionals: string[],
  io: CliIo,
): Promise<number> {
  const id = positionals[0];
  if (id === undefined) {
    throw new ScaError('schema_invalid', 'adopt needs a <record_id>');
  }
  assertSafeRecordId(id);
  const candidate = getString(values, 'candidate');
  const requestId = getString(values, 'request');
  const expectedRevision = getPositiveInt(values, 'expected-revision');
  if (candidate === undefined || requestId === undefined || expectedRevision === undefined) {
    throw new ScaError(
      'schema_invalid',
      'adopt needs --candidate, --request and --expected-revision (the candidates revision shown by sca review)',
    );
  }
  const scope = getString(values, 'scope');
  const note = getString(values, 'note');
  const repo = repositoryFor(values, io);
  const outcome = await adoptCandidate(repo, id, {
    request_id: requestId,
    candidate_id: candidate,
    expected_revision: expectedRevision,
    ...(scope !== undefined ? { scope } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  io.stdout(
    JSON.stringify({
      ok: true,
      command: 'adopt',
      record_id: id,
      receipt: outcome.receipt,
      duplicate: outcome.duplicate,
      registry_revision: outcome.revision,
      rule: summarizeRule(outcome.rule),
    }),
  );
  return 0;
}

async function rulesCommand(values: ParsedArgs['values'], io: CliIo): Promise<number> {
  const repo = repositoryFor(values, io);
  const revokeId = getString(values, 'revoke');
  if (revokeId !== undefined) {
    const requestId = getString(values, 'request');
    const expectedRevision = getPositiveInt(values, 'expected-revision');
    if (requestId === undefined || expectedRevision === undefined) {
      throw new ScaError(
        'schema_invalid',
        'rules --revoke needs --request and --expected-revision (the registry revision shown by sca rules)',
      );
    }
    const note = getString(values, 'note');
    const outcome = await revokeRule(repo, {
      request_id: requestId,
      rule_id: revokeId,
      expected_revision: expectedRevision,
      ...(note !== undefined ? { note } : {}),
    });
    io.stdout(
      JSON.stringify({
        ok: true,
        command: 'rules',
        action: 'revoke',
        receipt: outcome.receipt,
        duplicate: outcome.duplicate,
        registry_revision: outcome.revision,
        rule: summarizeRule(outcome.rule),
      }),
    );
    return 0;
  }
  const ruleId = getString(values, 'rule');
  if (ruleId !== undefined) {
    const detail = await ruleDetail(repo, ruleId);
    io.stdout(JSON.stringify({ ok: true, command: 'rules', ...detail }));
    return 0;
  }
  const workspace = getString(values, 'workspace');
  const view = await listRules(repo, {
    includeRevoked: values['all'] === true,
    ...(workspace !== undefined ? { workspace: await canonicalWorkspace(workspace) } : {}),
  });
  io.stdout(JSON.stringify({ ok: true, command: 'rules', ...view }));
  return 0;
}

interface RecordReport {
  record_id: string;
  ok: boolean;
  analyze: { status: 'ok' | 'invalid'; code?: string; detail?: string; pending_commit?: string };
  candidates: { status: 'ok' | 'invalid'; code?: string; detail?: string };
}

async function validateCommand(
  values: ParsedArgs['values'],
  positionals: string[],
  io: CliIo,
): Promise<number> {
  const root = getString(values, 'data-root') ?? io.env['SCA_DATA_ROOT'];
  const paths = resolvePaths(root === undefined || root.length === 0 ? undefined : root);
  const repo = new RecordRepository(root === undefined || root.length === 0 ? undefined : root);

  let ids: string[];
  if (values['all'] === true) {
    const entries = await fs.readdir(paths.recordsDir).catch(() => [] as string[]);
    ids = entries.filter((entry) => RECORD_ID_PATTERN.test(entry)).sort();
  } else {
    if (positionals.length === 0) {
      throw new ScaError('schema_invalid', 'validate needs a <record_id> or --all');
    }
    ids = [...positionals];
  }

  const reports: RecordReport[] = [];
  for (const id of ids) {
    reports.push(await validateRecord(repo, id));
  }
  const invalid = reports.filter((r) => !r.ok).length;
  io.stdout(JSON.stringify({ ok: invalid === 0, command: 'validate', checked: reports.length, invalid, reports }, null, 2));
  return invalid === 0 ? 0 : 1;
}

async function validateRecord(repo: RecordRepository, recordId: string): Promise<RecordReport> {
  const report: RecordReport = {
    record_id: recordId,
    ok: true,
    analyze: { status: 'ok' },
    candidates: { status: 'ok' },
  };
  try {
    const analyze = await repo.loadAnalyze(recordId);
    if (analyze.doc.pending_commit !== null && analyze.doc.pending_commit !== undefined) {
      // Read-only diagnostic: an open commit is reported, never replayed here.
      report.analyze.pending_commit = analyze.doc.pending_commit.analysis_id;
    }
    assertSingleNotesSection(splitFrontmatter(await fs.readFile(repo.analyzePath(recordId), 'utf8')).body);
  } catch (err) {
    report.ok = false;
    report.analyze = { status: 'invalid', ...describe(err) };
  }
  try {
    await repo.loadCandidates(recordId);
    assertSingleNotesSection(splitFrontmatter(await fs.readFile(repo.candidatesPath(recordId), 'utf8')).body);
  } catch (err) {
    report.ok = false;
    report.candidates = { status: 'invalid', ...describe(err) };
  }
  return report;
}

function describe(err: unknown): { code: string; detail: string } {
  if (err instanceof ScaError) {
    return { code: err.code, detail: err.message };
  }
  return { code: 'internal_error', detail: err instanceof Error ? err.message : String(err) };
}

const USAGE = `sca <command> [options]

Commands (Phase 1):
  doctor    Diagnose node/PATH, data root writability, package and host capability matrix. No model calls.
  discover  Locate the live session transcript via a bounded marker probe. The
            --marker string must appear verbatim in a command the agent already
            ran inside the session being located. Matches command text only.
            Exactly one hit succeeds; zero or multiple hits fail closed.
            sca discover --host codex|claude --marker sca-probe-<uuidv4>
              [--workspace <path>] [--home <dir>]  (home defaults to $HOME)
  register  Create or reuse records/<record_id>/ skeletons for one session.
            --host codex|claude --session <id> --workspace <path> --transcript <path>
            [--trigger session_end|manual_skill|scheduled_drain|explicit_import] [--title <t>]
            [--project <name>] [--analyzer-version <v>]
  validate  Read-only schema/identity/count checks over records.
            sca validate <record_id> | sca validate --all
  prepare   Freeze one session's input range, claim the run lease, write the
            analysis packet to runtime/packets (no model calls here).
            sca prepare <record_id> [--owner <who>] [--ttl-ms <n>] [--rule-version <v>]
  ingest    Validate a submission JSON against the frozen packet and commit it.
            sca ingest <record_id> --run <run_id> [--submission <path|->] [--owner <who>]
  review    List candidates with allowed actions and approval metrics, or apply
            one human decision (idempotent via --request + --expected-revision).
            sca review <record_id> [--candidate <id>]  (candidate details and evidence)
            sca review <record_id> --action approve|reject|revoke|edit_content|supersede
              --candidate <id> --request <id> --expected-revision <n>
              [--note <text>] [--content-file <path|-> --title <t> --scope <s>
               --target-kind harness|memory [--harness-path <p>]]  (edit_content only)
            sca review <record_id> --action copy_content|export_content
              --candidate <id> [--out <path>]                  (approved text only, no sink)
  adopt   Record one currently-approved candidate into the root accepted_rules.md
            registry. Idempotent: --request replays from the ledger and the
            derived rule_id makes re-adopting the same content a no-op.
            sca adopt <record_id> --candidate <id> --request <id>
              --expected-revision <candidates revision> [--scope project|user] [--note <text>]
  rules   Read or amend the accepted-rules registry (registry revision shown on list).
            sca rules [--workspace <path>] [--all]            (list; --all includes revoked)
            sca rules --rule <rule_id>                        (full text + provenance)
            sca rules --revoke <rule_id> --request <id> --expected-revision <registry revision>
              [--note <text>]

Global: --data-root <path> (or SCA_DATA_ROOT; default ~/.session-correction-analysis)
Phase 1: use a new data root. No automatic publishing, history search, HTTP or scheduling.`;

async function readStdinText(): Promise<string> {
  return readBoundedText(process.stdin, PENDING_COMMIT_MAX_BYTES);
}

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    readStdin: readStdinText,
  });
  process.exitCode = code;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
