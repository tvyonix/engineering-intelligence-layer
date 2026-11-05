import { readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { resolveCommit, gitEnv, runGit } from '../diff-inspector/git.js';
import { openLedger, closeLedger, type Ledger } from '../ledger/db.js';
import { recordAttempt, recordBenchRun } from '../ledger/records.js';
import { isExecutionPermitted } from '../quality-gates/execution-policy.js';
import { runCommand } from '../quality-gates/command-runner.js';
import { runCheck } from '../../apps/cli/main.js';
import { defaultPolicy, parsePolicy, toResolvedPolicy, type ResolvedPolicy } from '../contracts/policy.js';
import { parseBenchmarkManifest, analyzeComparability, type BenchmarkManifest, type ParsedManifest } from './manifest.js';

const execFileP = promisify(execFile);

export interface BenchWorkspace {
  dir: string;
}

/**
 * Creates a benchmark workspace: a local clone of the repository checked out
 * at the base commit. The clone is fully independent (own .git), so EIL check
 * and variant commands run inside it, while the source repository is only
 * ever read (local clones hardlink objects; the source is never written).
 * Identical start state for every variant — the pairing requirement.
 */
export async function createBenchWorkspace(repoDir: string, baseCommit: string): Promise<{ ok: true; dir: string } | { ok: false; reason: string }> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'eil-bench-'));
    await execFileP('git', ['clone', '--quiet', '--no-checkout', repoDir, dir], {
      env: gitEnv(),
      timeout: 120_000,
      windowsHide: true,
    });
    await execFileP('git', ['-C', dir, 'checkout', '--quiet', '--detach', baseCommit], {
      env: gitEnv(),
      timeout: 60_000,
      windowsHide: true,
    });
    return { ok: true, dir };
  } catch (error) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `bench workspace clone failed: ${message}` };
  }
}

export async function removeBenchWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export interface BenchOptions {
  manifest: string;
  repo: string;
  base?: string;
  policy?: string;
  out: string;
  ledger?: string;
  quiet?: boolean;
}

export interface BenchStepOutcome {
  variant: string;
  step: number;
  /** 'executed' | 'pending' (no engine command) | 'failed' (command or check failed) */
  status: 'executed' | 'pending' | 'failed';
  commandExitCode?: number | null;
  checkVerdict?: string;
  checkExitCode?: number;
  notes: string[];
}

export interface BenchRunOutput {
  exitCode: 0 | 1 | 2;
  messages: string[];
  summary: {
    scenario: string;
    baseCommit: string;
    comparable: boolean;
    comparabilityReasons: string[];
    metricsHonesty: string[];
    outcomes: BenchStepOutcome[];
  } | null;
}

function log(out: BenchRunOutput, quiet: boolean, message: string): void {
  out.messages.push(message);
  if (!quiet) console.log(message);
}

async function loadManifest(manifestPath: string): Promise<{ ok: true; manifest: BenchmarkManifest } | { ok: false; issues: string[] }> {
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    return { ok: false, issues: [`cannot read manifest: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    return { ok: false, issues: [`invalid YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed: ParsedManifest = parseBenchmarkManifest(data);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  return { ok: true, manifest: parsed.manifest };
}

/**
 * Task 5.2 + 5.3: paired A/B/C benchmark runner over sequential steps.
 *
 * Guarantees:
 * - every variant starts from the SAME base commit via a fresh `git archive`
 *   snapshot (identical start state, read-only for the repository);
 * - steps run sequentially per variant and accumulate in that variant's
 *   workspace (sequential product evolution, task 5.3);
 * - execution configuration is compared across variants; incomparable
 *   configurations are recorded as such and never declared causal;
 * - variants without an engine command record `pending` attempts — no
 *   fabricated results;
 * - when a step provides task+policy, `eil check` runs on the workspace and
 *   gate outcomes are recorded into the ledger;
 * - acceptance-based metrics are marked unavailable while no human
 *   acceptance exists (metric honesty — 5.4 formalizes the math).
 */
export async function runBench(options: BenchOptions): Promise<BenchRunOutput> {
  const out: BenchRunOutput = { exitCode: 2, messages: [], summary: null };
  const quiet = options.quiet ?? false;

  const loaded = await loadManifest(options.manifest);
  if (!loaded.ok) {
    log(out, quiet, 'eil: error: benchmark manifest is invalid:');
    for (const issue of loaded.issues) log(out, quiet, `  - ${issue}`);
    return out;
  }
  const manifest = loaded.manifest;
  const comparability = analyzeComparability(manifest);

  // Repository + base commit: identical for every variant.
  let toplevel: string;
  try {
    const toplevelResult = await runGit(options.repo, ['rev-parse', '--show-toplevel']);
    if (toplevelResult.code !== 0) {
      log(out, quiet, `eil: error: '${options.repo}' is not a git repository: ${toplevelResult.stderr.trim()}`);
      return out;
    }
    toplevel = toplevelResult.stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(out, quiet, `eil: error: cannot run git: ${message}`);
    return out;
  }
  const baseInput = options.base ?? 'HEAD';
  const baseCommit = await resolveCommit(toplevel, baseInput);
  if (baseCommit === null) {
    log(out, quiet, `eil: error: base commit '${baseInput}' does not resolve`);
    return out;
  }

  let policy: ResolvedPolicy;
  if (options.policy !== undefined) {
    const text = await readFile(options.policy, 'utf8');
    const parsed = parsePolicy(parseYaml(text));
    if (!parsed.ok) {
      log(out, quiet, 'eil: error: policy is invalid:');
      for (const issue of parsed.issues) log(out, quiet, `  - ${issue}`);
      return out;
    }
    policy = toResolvedPolicy(parsed.policy, 'file');
  } else {
    policy = defaultPolicy();
  }

  const repoRealRoot = await realpath(toplevel);
  const executionAllowed = isExecutionPermitted(policy, repoRealRoot).permitted;

  let ledger: Ledger | null = null;
  if (options.ledger !== undefined) {
    ledger = openLedger(options.ledger);
  }

  const outcomes: BenchStepOutcome[] = [];
  const manifestDir = (options.manifest.split('/').slice(0, -1).join('/') || '.');
  const startedAt = new Date().toISOString();

  try {
    log(out, quiet, `eil: bench '${manifest.name}': ${manifest.variants.length} variant(s) × ${manifest.steps.length} step(s), base ${baseCommit.slice(0, 12)}`);
    for (const reason of comparability.reasons) {
      log(out, quiet, `eil: bench comparability: ${reason}`);
    }

    for (const variant of manifest.variants) {
      // Fresh identical workspace per variant; steps accumulate in it.
      const workspace = await createBenchWorkspace(options.repo, baseCommit);
      if (!workspace.ok) {
        log(out, quiet, `eil: error: variant ${variant.id}: ${workspace.reason}`);
        for (const step of manifest.steps) {
          outcomes.push({ variant: variant.id, step: step.id, status: 'failed', notes: [workspace.reason] });
        }
        continue;
      }

      const benchRunId =
        ledger !== null
          ? recordBenchRun(ledger, {
              scenarioId: manifest.name,
              variant: variant.id,
              seed: manifest.seed ?? null,
              baseCommit,
              startedAt,
            })
          : null;

      try {
        for (const step of manifest.steps) {
          const notes: string[] = [];
          const taskFile = join(manifestDir, step.taskFile ?? variant.taskFile ?? '');
          const policyFile = join(manifestDir, step.policyFile ?? variant.policyFile ?? '');
          const hasCheck = (step.taskFile ?? variant.taskFile) !== undefined;

          let status: BenchStepOutcome['status'] = 'pending';
          let commandExitCode: number | null | undefined = undefined;

          if (variant.command !== undefined) {
            if (!executionAllowed) {
              notes.push('execution_not_permitted: repository is not vetted for host command execution (execution.vettedRepos)');
              status = 'failed';
              if (ledger !== null) {
                ensureTask(ledger, manifest.name, variant.id, step.id, baseCommit);
                recordAttempt(ledger, {
                  taskId: taskId(manifest.name, variant.id, step.id),
                  engine: variant.agent,
                  model: variant.model,
                  status: 'failed',
                  startedAt: new Date().toISOString(),
                  costKind: 'unknown',
                  policyVersion: policy.source,
                });
              }
              outcomes.push({ variant: variant.id, step: step.id, status, notes });
              continue;
            }
            log(out, quiet, `eil: bench ${variant.id} step ${step.id}: run ${JSON.stringify(variant.command)}`);
            const run = await runCommand(variant.command.replace('{step}', String(step.id)), workspace.dir, {
              timeoutMs: policy.execution?.timeoutMs ?? 120_000,
              maxOutputBytes: policy.execution?.maxOutputBytes ?? 1024 * 1024,
            });
            commandExitCode = run.exitCode;
            if (run.exitCode !== 0 || run.timedOut || run.capKilled || run.signal !== null) {
              status = 'failed';
              notes.push(`command failed: exit=${run.exitCode === null ? `signal ${run.signal}` : run.exitCode}${run.timedOut ? ' (timeout)' : ''}`);
            } else {
              status = 'executed';
            }
            if (ledger !== null) {
              ensureTask(ledger, manifest.name, variant.id, step.id, baseCommit);
              recordAttempt(ledger, {
                taskId: taskId(manifest.name, variant.id, step.id),
                engine: variant.agent,
                model: variant.model,
                status: status === 'executed' ? 'complete' : 'failed',
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                costKind: 'unknown',
                policyVersion: policy.source,
              });
            }
          } else {
            notes.push('no engine command configured; workspace prepared, attempt recorded as pending (no fabricated results)');
            if (ledger !== null) {
              ensureTask(ledger, manifest.name, variant.id, step.id, baseCommit);
              recordAttempt(ledger, {
                taskId: taskId(manifest.name, variant.id, step.id),
                engine: variant.agent,
                model: variant.model,
                status: 'pending',
                startedAt: new Date().toISOString(),
                costKind: 'unknown',
                policyVersion: policy.source,
              });
            }
          }

          // Post-step check with EIL gates when the manifest provides a contract.
          if (hasCheck) {
            const check = await runCheck({
              repo: workspace.dir,
              task: taskFile,
              policy: policyFile,
              base: baseCommit,
              out: join(options.out, variant.id, `step-${step.id}`),
              quiet: true,
            });
            const checkBundleRaw = await readFile(join(check.evidenceDir as string, 'evidence.json'), 'utf8');
            const checkBundle = JSON.parse(checkBundleRaw) as { verdict: string };
            notes.push(`eil check: verdict ${checkBundle.verdict} (exit ${check.exitCode})`);
            outcomes.push({
              variant: variant.id,
              step: step.id,
              // The engine status is never upgraded by the check: a pending
              // variant stays pending even when the check passes.
              status,
              commandExitCode,
              checkVerdict: checkBundle.verdict,
              checkExitCode: check.exitCode,
              notes,
            });
            continue;
          }

          outcomes.push({ variant: variant.id, step: step.id, status, commandExitCode, notes });
        }
      } finally {
        await removeBenchWorkspace(workspace.dir);
      }
      if (benchRunId !== null && !quiet) {
        log(out, quiet, `eil: bench variant ${variant.id}: bench_run row ${benchRunId}`);
      }
    }
  } finally {
    if (ledger !== null) closeLedger(ledger);
  }

  const metricsHonesty = [
    'human acceptance: none recorded in bench mode → Cost per Accepted Task and acceptance_rate are UNAVAILABLE (not zero-filled)',
    'attempt costs: unknown unless a variant provides measured usage → Cascade Waste components are unknown, never $0',
    'regressions: attribution only from artifact evidence (command/check output); no inferred numbers',
  ];

  out.summary = {
    scenario: manifest.name,
    baseCommit,
    comparable: comparability.comparable,
    comparabilityReasons: comparability.reasons,
    metricsHonesty,
    outcomes,
  };
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const pending = outcomes.filter((o) => o.status === 'pending').length;
  log(out, quiet, `eil: bench done: ${outcomes.length} step run(s): ${outcomes.length - failed - pending} executed, ${failed} failed, ${pending} pending (no engine)`);
  out.exitCode = failed > 0 ? 1 : 0;
  return out;
}

function taskId(scenario: string, variant: string, step: number): string {
  return `${scenario}__${variant}__step-${step}`;
}

function ensureTask(ledger: Ledger, scenario: string, variant: string, step: number, baseCommit: string): void {
  ledger.db
    .prepare(
      `INSERT INTO tasks (id, base_commit, type, risk, status, contract_hash, created_at)
       VALUES (?, ?, 'bench-step', 'unknown', 'pending', 'sha256:none', ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(taskId(scenario, variant, step), baseCommit, new Date().toISOString());
}
