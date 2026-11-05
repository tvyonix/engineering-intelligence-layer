#!/usr/bin/env node
/**
 * EIL CLI — `eil check` (Phase 0).
 *
 * Check mode verifies an existing diff against a task contract and policy
 * without any agent, LLM or network call. It never merges, never writes to
 * the target repository, and never executes repository content.
 */
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { hashTaskContract } from '../../packages/contracts/hash.js';
import { parseTaskContract } from '../../packages/contracts/task-contract.js';
import { defaultPolicy, parsePolicy, toResolvedPolicy } from '../../packages/contracts/policy.js';
import { collectDiff, extractCommitSnapshot, gitFailure, removeSnapshot, resolveCommit, runGit } from '../../packages/diff-inspector/git.js';
import { buildEvidenceBundle, FsEvidenceWriter, renderSummaryMarkdown, writeEvidenceBundle } from '../../packages/evidence/bundle.js';
import { buildGateRegistry, computeVerdict, runGates, selectGates } from '../../packages/quality-gates/run-gates.js';
import { runImpact, runLedger, runReferences, runSymbols } from './context-commands.js';
import { openLedger, closeLedger } from '../../packages/ledger/db.js';
import { recordCheckRun } from '../../packages/ledger/records.js';
import { renderTaskRecordMarkdown } from '../../packages/evidence/task-record.js';
import { classifyTaskRisk } from '../../packages/policy-engine/risk.js';

export const EIL_VERSION = '0.2.0-alpha.0';

export interface CheckOptions {
  repo: string;
  task: string;
  base?: string;
  policy?: string;
  out?: string;
  ledger?: string;
  quiet?: boolean;
}

export interface CheckRunOutput {
  exitCode: 0 | 1 | 2;
  bundleJson: string | null;
  evidenceDir: string | null;
  messages: string[];
}

function log(out: CheckRunOutput, quiet: boolean, message: string): void {
  out.messages.push(message);
  if (!quiet) console.log(message);
}

function fail(out: CheckRunOutput, quiet: boolean, message: string): CheckRunOutput {
  log(out, quiet, `eil: error: ${message}`);
  out.exitCode = 2;
  return out;
}

async function readYamlFile(path: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `cannot read file: ${message}` };
  }
  try {
    return { ok: true, data: parseYaml(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `invalid YAML: ${message}` };
  }
}

export async function runCheck(options: CheckOptions): Promise<CheckRunOutput> {
  const out: CheckRunOutput = { exitCode: 2, bundleJson: null, evidenceDir: null, messages: [] };
  const quiet = options.quiet ?? false;
  const startedAt = new Date().toISOString();

  // 1. Task contract (validated before any repository access: a blocked task
  //    must never reach the agent or the repo — task-contract spec).
  const taskLoad = await readYamlFile(options.task);
  if (!taskLoad.ok) return fail(out, quiet, `task contract: ${taskLoad.error}`);
  const contractResult = parseTaskContract(taskLoad.data, hashTaskContract);
  if (!contractResult.ok) {
    log(out, quiet, 'eil: error: task contract is invalid:');
    for (const issue of contractResult.issues) log(out, quiet, `  - ${issue}`);
    out.exitCode = 2;
    return out;
  }
  const contract = contractResult.contract;
  const contractHash = contractResult.contractHash;
  log(out, quiet, `eil: task '${contract.id}' accepted; contract ${contractHash}`);
  for (const warning of contractResult.warnings) {
    log(out, quiet, `eil: warning: ${warning}`);
  }

  // 2. Policy.
  let resolvedPolicy;
  if (options.policy !== undefined) {
    const policyLoad = await readYamlFile(options.policy);
    if (!policyLoad.ok) return fail(out, quiet, `policy: ${policyLoad.error}`);
    const policyResult = parsePolicy(policyLoad.data);
    if (!policyResult.ok) {
      log(out, quiet, 'eil: error: policy is invalid:');
      for (const issue of policyResult.issues) log(out, quiet, `  - ${issue}`);
      out.exitCode = 2;
      return out;
    }
    resolvedPolicy = toResolvedPolicy(policyResult.policy, 'file');
  } else {
    resolvedPolicy = defaultPolicy();
  }
  log(out, quiet, `eil: policy from ${resolvedPolicy.source}; required gates: ${resolvedPolicy.quality.required.join(', ')}`);

  // 3. Repository.
  const repoDir = isAbsolute(options.repo) ? options.repo : resolve(options.repo);
  let toplevel: string;
  try {
    const toplevelResult = await runGit(repoDir, ['rev-parse', '--show-toplevel']);
    if (toplevelResult.code !== 0) {
      return fail(out, quiet, `'${repoDir}' is not a git repository: ${toplevelResult.stderr.trim()}`);
    }
    toplevel = toplevelResult.stdout.trim();
  } catch (error) {
    const failure = gitFailure(error, 'git rev-parse');
    return fail(out, quiet, `cannot run git for '${repoDir}': ${failure.stderr.trim()}`);
  }
  const repoRealRoot = await realpath(toplevel);

  const baseCommitInput = options.base ?? contract.baseCommit;
  const baseCommitSource: 'task' | 'cli-override' = options.base !== undefined ? 'cli-override' : 'task';
  const baseCommit = await resolveCommit(repoDir, baseCommitInput);
  if (baseCommit === null) {
    return fail(out, quiet, `base commit '${baseCommitInput}' does not resolve in repository '${toplevel}'`);
  }
  const headCommit = await resolveCommit(repoDir, 'HEAD');
  if (headCommit === null) {
    return fail(out, quiet, `repository '${toplevel}' has no HEAD commit`);
  }
  log(out, quiet, `eil: repo ${repoRealRoot}; base ${baseCommit.slice(0, 12)} (input '${baseCommitInput}'); head ${headCommit.slice(0, 12)}`);

  // 4. Diff under review.
  let diff;
  try {
    diff = await collectDiff(toplevel, baseCommit, headCommit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(out, quiet, message);
  }
  log(
    out,
    quiet,
    `eil: diff: ${diff.changed.length} changed tracked path(s), ${diff.untracked.length} untracked file(s), worktree ${diff.worktreeDirty ? 'dirty' : 'clean'}`,
  );
  if (diff.baselineNote !== undefined) {
    log(out, quiet, `eil: baseline: ${diff.baselineNote}`);
  }

  // 5. Gates and evidence.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceDir = options.out ?? join(process.cwd(), 'eil-evidence', `${contract.id}--${timestamp}`);
  const evidence = new FsEvidenceWriter(evidenceDir);

  const registry = buildGateRegistry();
  // Lazy, memoized baseline snapshot for content gates (types/lint/import
  // boundaries). Created on first use; removed after the run.
  const snapshotState: { promise: Promise<{ ok: true; dir: string } | { ok: false; reason: string }> | null } = {
    promise: null,
  };
  const baselineSnapshot = () => {
    snapshotState.promise ??= extractCommitSnapshot(toplevel, baseCommit);
    return snapshotState.promise;
  };
  const ctx = {
    repoDir: toplevel,
    repoRealRoot,
    headCommit,
    baseCommit,
    baseCommitInput,
    baseCommitSource,
    contract,
    contractHash,
    policy: resolvedPolicy,
    diff,
    evidence,
    baselineSnapshot,
  };
  const gates = selectGates(registry, ctx);
  const { results: gateResults, violations, baselineContext } = await runGates(gates, ctx);
  const { verdict, exitCode } = computeVerdict(gateResults);

  // Deterministic risk classification (Phase 4.1): pure rules, monotonic,
  // no model involvement. Hints elevate; nothing here can lower a risk.
  const changedPaths = [
    ...diff.changed.flatMap((c) => [c.path, c.origPath]),
    ...diff.untracked,
  ].filter((p): p is string => p !== undefined);
  const riskAssessment = classifyTaskRisk({ changedPaths, violations, riskHints: contract.riskHints });
  // The promise is assigned inside the closure; widen before reading.
  const createdSnapshot = snapshotState.promise as Promise<{ ok: true; dir: string } | { ok: false; reason: string }> | null;
  if (createdSnapshot !== null) {
    const snapshot = await createdSnapshot;
    if (snapshot.ok) await removeSnapshot(snapshot.dir);
  }

  const diffLogName = 'diff.patch';
  const changedFilesLog = [
    '# Tracked changes (git diff --name-status, base..worktree)',
    ...diff.changed.map((c) => `${c.status}\t${c.origPath !== undefined ? `${c.origPath} -> ${c.path}` : c.path}`),
    '',
    '# Untracked files (git ls-files --others)',
    ...diff.untracked,
    diff.patchTruncated ? '# NOTE: the saved patch was truncated at 16 MiB; use git directly for the full patch.' : '',
  ].join('\n');
  const bundle = buildEvidenceBundle({
    generatedAt: new Date().toISOString(),
    eilVersion: EIL_VERSION,
    taskId: contract.id,
    contractHash,
    baseCommitInput,
    baseCommit,
    baseCommitSource,
    headCommit,
    diff: { worktreeDirty: diff.worktreeDirty, untracked: diff.untracked },
    gateResults,
    violations,
    baselineContext,
    verdict,
    exitCode,
    risk: riskAssessment.risk,
    riskReasons: riskAssessment.reasons,
    diffPath: join('logs', diffLogName),
    fullLogsDirectory: join(evidenceDir, 'logs'),
  });
  await writeEvidenceBundle(
    evidenceDir,
    bundle,
    renderSummaryMarkdown(bundle),
    [
      { fileName: diffLogName, content: `${diff.patch}${diff.patchTruncated ? '\n# [truncated]\n' : ''}` },
      { fileName: 'changed-files.txt', content: `${changedFilesLog}\n` },
    ],
  );
  // Task Record (task 2.6): the per-task record of what was checked, with
  // acceptance criteria, human-acceptance status and cost veracity.
  await writeFile(join(evidenceDir, 'task-record.md'), renderTaskRecordMarkdown(contract, bundle), 'utf8');

  out.exitCode = exitCode;
  out.evidenceDir = evidenceDir;
  out.bundleJson = `${JSON.stringify(bundle, null, 2)}\n`;

  log(out, quiet, '');
  log(out, quiet, 'EIL check summary');
  log(out, quiet, '-----------------');
  for (const gate of bundle.gateResults) {
    log(out, quiet, `  ${gate.id.padEnd(20)} ${gate.status.padEnd(14)} ${gate.mandatory ? 'mandatory' : 'optional  '} ${gate.reason ?? ''}`);
  }
  log(out, quiet, '');
  log(out, quiet, `verdict: ${bundle.verdict} (exit ${bundle.exitCode}); risk: ${bundle.risk ?? 'unknown'}`);
  for (const reason of bundle.riskReasons ?? []) {
    log(out, quiet, `  risk: ${reason}`);
  }
  if (bundle.verdict === 'needs_review') {
    log(out, quiet, 'all mandatory gates passed; human review is required — EIL never merges');
  } else if (bundle.verdict === 'blocked') {
    log(out, quiet, 'a mandatory gate failed; the change cannot be accepted regardless of model opinion');
  } else {
    log(out, quiet, 'the check is incomplete (mandatory gate error/missing); incomplete verification is not success');
  }
  log(out, quiet, `evidence: ${evidenceDir} (summary: summary.md, bundle: evidence.json, task record: task-record.md)`);

  // Ledger (tasks 2.4/2.5): observability. A ledger failure is reported but
  // does not change the check verdict — it is never a quality gate.
  if (options.ledger !== undefined) {
    try {
      const ledger = openLedger(options.ledger);
      const recorded = recordCheckRun(ledger, {
        taskId: contract.id,
        baseCommit,
        contractHash,
        status: bundle.verdict,
        risk: bundle.risk,
        startedAt,
        completedAt: new Date().toISOString(),
        policyVersion: resolvedPolicy.source === 'file' ? 'file' : 'default',
        evidenceDir,
        gates: bundle.gateResults.map((g) => ({
          id: g.id,
          status: g.status,
          mandatory: g.mandatory,
          durationMs: g.durationMs,
          evidencePath: g.evidencePath,
        })),
      });
      closeLedger(ledger);
      log(out, quiet, `ledger: recorded task '${recorded.taskId}' attempt ${recorded.attemptId} (${recorded.gateIds.length} gate rows) → ${options.ledger}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(out, quiet, `eil: warning: ledger write failed (${message}); the check verdict is unaffected`);
    }
  }
  out.exitCode = exitCode;
  return out;
}

const USAGE = `eil ${EIL_VERSION} — Engineering Intelligence Layer (check-only build)

Usage:
  eil check --repo <path> --task <task.yaml> [--base <ref>] [--policy <policy.yaml>] [--out <dir>] [--ledger <db>] [--json]
  eil symbols --repo <path> --file <relpath>
  eil references --repo <path> --file <relpath> --name <symbol>
  eil impact --repo <path> --base <ref>
  eil ledger --db <path> init | eil ledger --db <path> export --out <dir>
  eil --help | --version

Commands:
  check        Verify an existing diff against a task contract and policy.
               Runs no agent, no LLM, no network calls. Read-only for the
               repository; writes an evidence bundle under --out.
  symbols      List top-level declarations of a file: kind, export status,
               overload signatures, re-exports (read-only, ts-morph).
  references   Exact coordinates of a symbol's declaration and references.
  impact       Potentially affected files/tests of a diff via reverse
               static-import analysis; explicitly incomplete for dynamic
               imports (completeness: static-import-analysis).
  ledger       Initialize the SQLite ledger or export its tables to JSONL.

Options:
  --repo       Path to the target git repository (required).
  --task       Path to the task contract YAML (required for check).
  --base       Base commit/ref; defaults to the contract's baseCommit (check)
               or is required (impact).
  --policy     Operator policy YAML; defaults to built-in safe policy.
  --out        Evidence bundle directory (check) or export dir (ledger export).
  --ledger     SQLite ledger file; check records the run when provided.
  --file       Repo-relative file path (symbols, references).
  --name       Symbol name (references).
  --db         Ledger database file (ledger command).
  --json       Print the JSON payload to stdout.
  --help       Show this help.
  --version    Print version.

Exit codes:
  0  success (check: all mandatory gates passed → needs_review, not accepted)
  1  blocked: a mandatory gate failed (check)
  2  error: invalid input, git failure, mandatory gate error, or context
     limit exceeded (EIL fails closed)`;

type ParsedArgs = { _: string[] } & { [key: string]: string | boolean | string[] };

function parseArgs(argv: string[]): ParsedArgs {
  const valueFlags = new Set(['--repo', '--task', '--base', '--policy', '--out', '--ledger', '--file', '--name', '--db']);
  const parsed: ParsedArgs = { _: [] as string[] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      parsed[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (arg === '--json') parsed['json'] = true;
    else if (arg === '--help' || arg === '-h') parsed['help'] = true;
    else if (arg === '--version') parsed['version'] = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option '${arg}'`);
    else parsed._.push(arg);
  }
  return parsed;
}

export async function main(argv: string[]): Promise<0 | 1 | 2> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`eil: error: ${message}`);
    console.error(USAGE);
    return 2;
  }
  if (args['help'] === true) {
    console.log(USAGE);
    return 0;
  }
  if (args['version'] === true) {
    console.log(EIL_VERSION);
    return 0;
  }
  const command = args._[0];
  if (command === 'symbols' || command === 'references' || command === 'impact' || command === 'ledger') {
    return contextCommand(command, args);
  }
  if (command !== 'check') {
    console.error(command === undefined ? 'eil: error: missing command' : `eil: error: unknown command '${command}'`);
    console.error(USAGE);
    return 2;
  }
  const repo = args['repo'];
  const task = args['task'];
  if (typeof repo !== 'string' || typeof task !== 'string') {
    console.error('eil: error: both --repo and --task are required for `eil check`');
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await runCheck({
      repo,
      task,
      base: typeof args['base'] === 'string' ? args['base'] : undefined,
      policy: typeof args['policy'] === 'string' ? args['policy'] : undefined,
      out: typeof args['out'] === 'string' ? args['out'] : undefined,
      ledger: typeof args['ledger'] === 'string' ? args['ledger'] : undefined,
      quiet: false,
    });
    if (args['json'] === true && result.bundleJson !== null) {
      console.log(result.bundleJson);
    }
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`eil: fatal: ${message}`);
    return 2;
  }
}

async function contextCommand(command: string, args: ParsedArgs): Promise<0 | 1 | 2> {
  const repo = args['repo'];
  if (command !== 'ledger' && typeof repo !== 'string') {
    console.error(`eil: error: --repo is required for '${command}'`);
    return 2;
  }
  const quiet = args['json'] === true; // JSON mode: suppress human messages
  try {
    let result;
    if (command === 'symbols') {
      const file = args['file'];
      if (typeof file !== 'string') {
        console.error('eil: error: --file is required for `eil symbols`');
        return 2;
      }
      result = await runSymbols({ repo: repo as string, file });
    } else if (command === 'references') {
      const file = args['file'];
      const name = args['name'];
      if (typeof file !== 'string' || typeof name !== 'string') {
        console.error('eil: error: --file and --name are required for `eil references`');
        return 2;
      }
      result = await runReferences({ repo: repo as string, file, name });
    } else if (command === 'impact') {
      const base = args['base'];
      if (typeof base !== 'string') {
        console.error('eil: error: --base is required for `eil impact`');
        return 2;
      }
      result = await runImpact({ repo: repo as string, base });
    } else {
      const action = args._[1];
      const db = args['db'];
      if (typeof action !== 'string' || typeof db !== 'string') {
        console.error('eil: error: an action (init|export) and --db are required for `eil ledger`');
        return 2;
      }
      result = await runLedger({
        action,
        db,
        out: typeof args['out'] === 'string' ? args['out'] : undefined,
      });
    }
    if (!quiet) for (const message of result.messages) console.error(message);
    if (result.json !== null) console.log(result.json);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`eil: fatal: ${message}`);
    return 2;
  }
}

/* istanbul ignore next */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
