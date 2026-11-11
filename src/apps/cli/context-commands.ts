import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { checkPathContainedInRoot, canonicalizeRepoRelativePath } from '../../packages/policy-engine/paths.js';
import { collectDiff, gitFailure, resolveCommit, runGit } from '../../packages/diff-inspector/git.js';
import { createProject, ContextLimitExceededError } from '../../packages/context-tools/project.js';
import { getFileSymbols } from '../../packages/context-tools/symbols.js';
import { findSymbolReferences } from '../../packages/context-tools/references.js';
import { computeImpact } from '../../packages/context-tools/impact.js';
import { openLedger, closeLedger, listAppliedMigrations } from '../../packages/ledger/db.js';
import { exportJsonl, recordReview } from '../../packages/ledger/records.js';
import { computeBenchMetrics, renderMetricsMarkdown } from '../../packages/ledger/metrics.js';
import { buildPrReport } from '../../packages/evidence/pr-report.js';
import { runBench } from '../../packages/benchmarks/runner.js';

/**
 * runCheck is INJECTED by main.ts (the CLI layer's entry). Importing it
 * statically here created a main ↔ context-commands cycle that EIL's own
 * import-boundaries gate surfaced once NodeNext resolution was fixed
 * (1.7 review).
 */
export type RunCheckFn = (options: import('./types.js').CheckOptions) => Promise<import('./types.js').CheckRunOutput>;

export interface ContextCommandOutput {
  exitCode: 0 | 1 | 2;
  /** JSON payload for machine consumption (stdout when not quiet). */
  json: string | null;
  messages: string[];
}

export interface RepoResolution {
  ok: true;
  toplevel: string;
  realRoot: string;
}

export interface RepoResolutionFailure {
  ok: false;
  message: string;
}

export async function resolveRepo(repoInput: string): Promise<RepoResolution | RepoResolutionFailure> {
  const repoDir = isAbsolute(repoInput) ? repoInput : resolve(repoInput);
  try {
    const result = await runGit(repoDir, ['rev-parse', '--show-toplevel']);
    if (result.code !== 0) {
      return { ok: false, message: `'${repoDir}' is not a git repository: ${result.stderr.trim()}` };
    }
    const toplevel = result.stdout.trim();
    const realRoot = await realpath(toplevel);
    return { ok: true, toplevel, realRoot };
  } catch (error) {
    const failure = gitFailure(error, 'git rev-parse');
    return { ok: false, message: `cannot run git for '${repoDir}': ${failure.stderr.trim()}` };
  }
}

function fail(messages: string[], message: string): ContextCommandOutput {
  messages.push(`eil: error: ${message}`);
  return { exitCode: 2, json: null, messages };
}

export interface ContextRepoOptions {
  repo: string;
  quiet?: boolean;
}

function output(json: unknown): ContextCommandOutput {
  return { exitCode: 0, json: `${JSON.stringify(json, null, 2)}\n`, messages: [] };
}

/** Task 2.1 CLI: `eil symbols --repo <path> --file <relpath>`. */
export async function runSymbols(options: ContextRepoOptions & { file: string }): Promise<ContextCommandOutput> {
  const messages: string[] = [];
  const repo = await resolveRepo(options.repo);
  if (!repo.ok) return fail(messages, repo.message);
  const canonical = canonicalizeRepoRelativePath(options.file);
  if (canonical.kind === 'invalid') return fail(messages, `--file: ${canonical.reason}`);
  const containment = await checkPathContainedInRoot(repo.realRoot, canonical.path);
  if (!containment.contained) return fail(messages, `--file escapes the repository root (${containment.note ?? 'not contained'})`);
  try {
    const project = createProject(repo.toplevel);
    const symbols = getFileSymbols(project, repo.toplevel, canonical.path);
    return output(symbols);
  } catch (error) {
    if (error instanceof ContextLimitExceededError) return fail(messages, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return fail(messages, message);
  }
}

/** Task 2.2 CLI: `eil references --repo <path> --file <relpath> --name <symbol>`. */
export async function runReferences(options: ContextRepoOptions & { file: string; name: string }): Promise<ContextCommandOutput> {
  const messages: string[] = [];
  const repo = await resolveRepo(options.repo);
  if (!repo.ok) return fail(messages, repo.message);
  const canonical = canonicalizeRepoRelativePath(options.file);
  if (canonical.kind === 'invalid') return fail(messages, `--file: ${canonical.reason}`);
  const containment = await checkPathContainedInRoot(repo.realRoot, canonical.path);
  if (!containment.contained) return fail(messages, `--file escapes the repository root (${containment.note ?? 'not contained'})`);
  try {
    const project = createProject(repo.toplevel);
    const references = findSymbolReferences(project, repo.toplevel, canonical.path, options.name);
    return output(references);
  } catch (error) {
    if (error instanceof ContextLimitExceededError) return fail(messages, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return fail(messages, message);
  }
}

/** Task 2.3 CLI: `eil impact --repo <path> --base <ref>`. */
export async function runImpact(options: ContextRepoOptions & { base: string }): Promise<ContextCommandOutput> {
  const messages: string[] = [];
  const repo = await resolveRepo(options.repo);
  if (!repo.ok) return fail(messages, repo.message);
  const baseCommit = await resolveCommit(repo.toplevel, options.base);
  if (baseCommit === null) return fail(messages, `base commit '${options.base}' does not resolve in repository`);
  const headCommit = await resolveCommit(repo.toplevel, 'HEAD');
  if (headCommit === null) return fail(messages, 'repository has no HEAD commit');
  let diff;
  try {
    diff = await collectDiff(repo.toplevel, baseCommit, headCommit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(messages, message);
  }
  const changedPaths = [...diff.changed.map((c) => c.path), ...diff.untracked];
  try {
    const project = createProject(repo.toplevel);
    const impact = computeImpact(project, repo.toplevel, changedPaths);
    return output(impact);
  } catch (error) {
    if (error instanceof ContextLimitExceededError) return fail(messages, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return fail(messages, message);
  }
}

/** Task 2.4 CLI: `eil ledger --db <path> init` / `eil ledger --db <path> export --out <dir>`. */
export async function runLedger(options: { quiet?: boolean; action: string; db: string; out?: string }): Promise<ContextCommandOutput> {
  const messages: string[] = [];
  if (options.action === 'init') {
    try {
      const ledger = await openLedger(options.db);
      const migrations = listAppliedMigrations(ledger);
      closeLedger(ledger);
      const payload = { db: options.db, migrations };
      return output(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(messages, `cannot initialize ledger: ${message}`);
    }
  }
  if (options.action === 'export') {
    if (options.out === undefined) return fail(messages, '--out is required for ledger export');
    try {
      const ledger = await openLedger(options.db);
      const files = exportJsonl(ledger, options.out);
      closeLedger(ledger);
      return output({ out: options.out, files });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(messages, `cannot export ledger: ${message}`);
    }
  }
  return fail(messages, `unknown ledger action '${options.action}' (use init or export)`);
}

/** Task 5.1 CLI: `eil report --evidence <dir>` — PR-ready markdown from an evidence bundle. */
export async function runReport(options: { evidence: string; out?: string }): Promise<ContextCommandOutput> {
  const messages: string[] = [];
  try {
    const { report } = await buildPrReport(options.evidence);
    if (options.out !== undefined) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(options.out, report, 'utf8');
      messages.push(`eil: report written to ${options.out}`);
    }
    return { exitCode: 0, json: `${report}\n`, messages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(messages, `cannot build report: ${message}`);
  }
}

/** Task 5.2/5.3 CLI: `eil bench --manifest <yaml> --repo <path> --out <dir> [--db <ledger>]`. */
export async function runBenchCommand(options: {
  manifest: string;
  repo: string;
  base?: string;
  policy?: string;
  out: string;
  db?: string;
  repeat?: number;
  quiet?: boolean;
  /** Injected by main.ts (cycle break, see RunCheckFn). */
  runCheckImpl: RunCheckFn;
}): Promise<ContextCommandOutput> {
  const result = await runBench({
    manifest: options.manifest,
    repo: options.repo,
    base: options.base,
    policy: options.policy,
    out: options.out,
    ledger: options.db,
    repeat: options.repeat,
    // Dependency inversion: the CLI layer supplies the real checker.
    check: async (request) => {
      const check = await options.runCheckImpl({ ...request, quiet: true });
      return { exitCode: check.exitCode, evidenceDir: check.evidenceDir };
    },
    quiet: options.quiet,
  });
  return {
    exitCode: result.exitCode,
    json: result.summary !== null ? `${JSON.stringify(result.summary, null, 2)}\n` : null,
    messages: result.messages,
  };
}

/**
 * Task 5.5 CLI: `eil accept --db <path> --task <id> [--reviewer human:alice]
 * [--rejected] [--duration-seconds N] [--changes-requested "..."]`.
 *
 * Records the human acceptance (or rejection) as a review event and updates
 * the task status. Gate status and acceptance stay separate facts: a task
 * with all gates passing is still `needs_review` until this command runs.
 */
export async function runAccept(options: {
  db: string;
  task: string;
  reviewer?: string;
  rejected?: boolean;
  durationSeconds?: number;
  changesRequested?: string;
}): Promise<ContextCommandOutput> {
  const messages: string[] = [];
  let ledger;
  try {
    ledger = await openLedger(options.db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(messages, `cannot open ledger: ${message}`);
  }
  try {
    const task = ledger.db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(options.task) as
      | { id: string; status: string }
      | undefined;
    if (task === undefined) {
      return fail(messages, `task '${options.task}' not found in ledger '${options.db}'`);
    }
    // 1.7 review: acceptance must never follow a blocked/errored check —
    // only a machine-clean needs_review state can be accepted by a human.
    if (options.rejected !== true && task.status !== 'needs_review') {
      return fail(
        messages,
        `task '${options.task}' has status '${task.status}': only 'needs_review' tasks can be accepted (fix the failing gates first); rejection is always allowed`,
      );
    }
    const accepted = options.rejected !== true;
    const reviewer = options.reviewer ?? 'human:unspecified';
    recordReview(ledger, {
      taskId: options.task,
      reviewerType: reviewer,
      accepted,
      durationSeconds: options.durationSeconds ?? null,
      changesRequested: options.changesRequested ?? null,
      observedAt: new Date().toISOString(),
    });
    ledger.db
      .prepare('UPDATE tasks SET status = ? WHERE id = ?')
      .run(accepted ? 'accepted' : 'rejected', options.task);
    const payload = {
      task: options.task,
      previousStatus: task.status,
      status: accepted ? 'accepted' : 'rejected',
      reviewer,
      note: 'acceptance is a human event recorded here; it never follows from gate results alone',
    };
    return output(payload);
  } finally {
    closeLedger(ledger);
  }
}

/** Task 5.4 CLI: `eil metrics --db <path> [--scenario S] [--variant B] [--control A]`. */
export async function runMetrics(options: {
  db: string;
  scenario?: string;
  variant?: string;
  control?: string;
  format?: 'json' | 'markdown';
}): Promise<ContextCommandOutput> {
  const messages: string[] = [];
  let ledger;
  try {
    ledger = await openLedger(options.db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(messages, `cannot open ledger: ${message}`);
  }
  try {
    const metrics = computeBenchMetrics(ledger, {
      scenario: options.scenario,
      variant: options.variant,
      control: options.control,
    });
    if (options.format === 'markdown') {
      return { exitCode: 0, json: renderMetricsMarkdown(metrics), messages };
    }
    return output(metrics);
  } finally {
    closeLedger(ledger);
  }
}

/**
 * Task 3.6 CLI (scripted-engine mode): `eil run --repo <path> --task <yaml>
 * --policy <yaml> --out <dir> [--ledger <db>]`. Runs the attempt pipeline
 * with the operator-supplied engineCommand from policy.execution: each
 * attempt executes the command inside a fresh isolated workspace, then the
 * diff is checked by the full gate set, the ledger records the attempt, and
 * the cascade planner decides the next step. The Pi adapter (task 3.4)
 * replaces the scripted runner after the security review — via the same
 * EngineRunner contract, without touching this command.
 */
export async function runRun(options: {
  repo: string;
  task: string;
  policy: string;
  out: string;
  ledger?: string;
  strongTierConfigured?: boolean;
  quiet?: boolean;
  /** Injected by main.ts (cycle break, see RunCheckFn). */
  runCheckImpl: RunCheckFn;
}): Promise<ContextCommandOutput> {
  const messages: string[] = [];
  const { parse: parseYaml } = await import('yaml');
  const { readFile: rf } = await import('node:fs/promises');
  const { parsePolicy, toResolvedPolicy } = await import('../../packages/contracts/policy.js');
  const { ScriptedEngineRunner } = await import('../../packages/agent-adapters/scripted.js');
  const { runTaskPipeline } = await import('../../packages/runner-pipeline/pipeline.js');

  let policyData: unknown;
  try {
    policyData = parseYaml(await rf(options.policy, 'utf8'));
  } catch (error) {
    return fail(messages, `cannot read policy: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parsePolicy(policyData);
  if (!parsed.ok) return fail(messages, `policy is invalid: ${parsed.issues.join('; ')}`);
  const resolved = toResolvedPolicy(parsed.policy, 'file');

  if (resolved.execution?.engineCommand === undefined) {
    return fail(
      messages,
      'policy has no execution.engineCommand: `eil run` needs an operator-supplied engine command (scripted stand-in until the Pi adapter, task 3.4)',
    );
  }

  const engine = new ScriptedEngineRunner({
    engineId: 'scripted',
    model: 'operator-command',
    command: resolved.execution.engineCommand,
  });
  const summary = await runTaskPipeline({
    repo: options.repo,
    taskFile: options.task,
    policy: resolved,
    engine,
    checker: async (request) => {
      const check = await options.runCheckImpl({ ...request, policy: options.policy, quiet: true });
      return { exitCode: check.exitCode, evidenceDir: check.evidenceDir };
    },
    out: options.out,
    ledger: options.ledger,
    maxCheapRetries: resolved.execution.maxCheapRetries ?? 1,
    strongTierConfigured: options.strongTierConfigured ?? false,
    quiet: options.quiet,
  });

  for (const note of summary.notes) messages.push(`eil: run: ${note}`);
  return {
    exitCode: summary.exitCode,
    json: `${JSON.stringify(summary, null, 2)}\n`,
    messages,
  };
}
