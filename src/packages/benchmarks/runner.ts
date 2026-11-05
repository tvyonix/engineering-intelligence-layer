import { mkdir, readFile, realpath, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { defaultPolicy, parsePolicy, toResolvedPolicy, type ResolvedPolicy } from '../contracts/policy.js';

/**
 * Checker injected by the CLI layer (dependency inversion): the benchmarks
 * package must not depend on apps/ — EIL's own import-boundaries rule
 * (dogfooded self-check, ops/self-policy.yaml).
 */
export interface BenchCheckRequest {
  repo: string;
  task: string;
  policy?: string;
  base: string;
  out: string;
}

export interface BenchCheckResult {
  exitCode: 0 | 1 | 2;
  evidenceDir: string | null;
}

export type BenchChecker = (request: BenchCheckRequest) => Promise<BenchCheckResult>;
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
  /** Independent repetitions of the whole run (task 5.6: reproducibility smoke). */
  repeat?: number;
  /** Injected by the CLI layer; without it, per-step checks are skipped with an explicit note. */
  check?: BenchChecker;
  quiet?: boolean;
}

export interface BenchStepOutcome {
  variant: string;
  step: number;
  /** 1-based independent repetition index (task 5.6). */
  repetition: number;
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
    repetitions: number;
    reproducible: boolean;
    outcomes: BenchStepOutcome[];
    artifacts: { results: string; samples: string; limitations: string; logsDirectory: string };
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
    ledger = await openLedger(options.ledger);
  }

  const outcomes: BenchStepOutcome[] = [];
  const manifestDir = (options.manifest.split('/').slice(0, -1).join('/') || '.');
  const startedAt = new Date().toISOString();
  const repeat = Math.max(1, Math.min(options.repeat ?? 1, 25));

  try {
    log(out, quiet, `eil: bench '${manifest.name}': ${manifest.variants.length} variant(s) × ${manifest.steps.length} step(s) × ${repeat} repetition(s), base ${baseCommit.slice(0, 12)}`);
    for (const reason of comparability.reasons) {
      log(out, quiet, `eil: bench comparability: ${reason}`);
    }

    for (let repetition = 1; repetition <= repeat; repetition++) {
    for (const variant of manifest.variants) {
      // Fresh identical workspace per variant; steps accumulate in it.
      const workspace = await createBenchWorkspace(options.repo, baseCommit);
      if (!workspace.ok) {
        log(out, quiet, `eil: error: variant ${variant.id}: ${workspace.reason}`);
        for (const step of manifest.steps) {
          outcomes.push({ variant: variant.id, step: step.id, repetition, status: 'failed', notes: [workspace.reason] });
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
          let checkVerdict: string | undefined;
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
              outcomes.push({ variant: variant.id, step: step.id, repetition, status, notes });
              continue;
            }
            log(out, quiet, `eil: bench rep ${repetition} ${variant.id} step ${step.id}: run ${JSON.stringify(variant.command)}`);
            const run = await runCommand(variant.command.replace('{step}', String(step.id)), workspace.dir, {
              timeoutMs: policy.execution?.timeoutMs ?? 120_000,
              maxOutputBytes: policy.execution?.maxOutputBytes ?? 1024 * 1024,
            });
            commandExitCode = run.exitCode;
            // Task 5.6: publish the full command log (probe output, failures,
            // regression attribution) next to the samples.
            const logDir = join(options.out, 'logs', `rep-${repetition}`, variant.id);
            await mkdir(logDir, { recursive: true });
            await writeFile(
              join(logDir, `step-${step.id}.log`),
              [
                `# command: ${variant.command.replace('{step}', String(step.id))}`,
                `# exitCode: ${run.exitCode === null ? `signal ${run.signal}` : run.exitCode}`,
                `# timedOut: ${run.timedOut}; capKilled: ${run.capKilled}; durationMs: ${run.durationMs}`,
                '',
                '--- stdout ---',
                run.stdout,
                '--- stderr ---',
                run.stderr,
                '',
              ].join('\n'),
              'utf8',
            );
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
          if (hasCheck && options.check !== undefined) {
            const check = await options.check({
              repo: workspace.dir,
              task: taskFile,
              policy: policyFile,
              base: baseCommit,
              out: join(options.out, `rep-${repetition}`, variant.id, `step-${step.id}`),
            });
            if (check.evidenceDir === null) {
              notes.push(`eil check: failed before evidence was written (exit ${check.exitCode})`);
            } else {
              const checkBundleRaw = await readFile(join(check.evidenceDir, 'evidence.json'), 'utf8');
              const checkBundle = JSON.parse(checkBundleRaw) as { verdict: string };
              notes.push(`eil check: verdict ${checkBundle.verdict} (exit ${check.exitCode})`);
              checkVerdict = checkBundle.verdict;
            }
            outcomes.push({
              variant: variant.id,
              step: step.id,
              repetition,
              // The engine status is never upgraded by the check: a pending
              // variant stays pending even when the check passes.
              status,
              commandExitCode,
              checkVerdict,
              checkExitCode: check.exitCode,
              notes,
            });
            continue;
          }
          if (hasCheck && options.check === undefined) {
            notes.push('eil check skipped: no checker injected into the bench runner');
          }

          outcomes.push({ variant: variant.id, step: step.id, repetition, status, commandExitCode, notes });
        }
      } finally {
        await removeBenchWorkspace(workspace.dir);
      }
      if (benchRunId !== null && !quiet) {
        log(out, quiet, `eil: bench rep ${repetition} variant ${variant.id}: bench_run row ${benchRunId}`);
      }
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

  // Task 5.6: reproducibility smoke — for a deterministic engine stand-in,
  // independent repetitions must produce identical outcomes. Any divergence
  // is reported, never averaged away.
  const outcomeKey = (o: BenchStepOutcome): string => `${o.variant}#${o.step}`;
  const byKey = new Map<string, string[]>();
  for (const outcome of outcomes) {
    const signature = JSON.stringify([outcome.status, outcome.commandExitCode ?? null, outcome.checkVerdict ?? null, outcome.checkExitCode ?? null]);
    const list = byKey.get(outcomeKey(outcome)) ?? [];
    list.push(signature);
    byKey.set(outcomeKey(outcome), list);
  }
  const reproducible = [...byKey.values()].every((signatures) => new Set(signatures).size === 1);

  // Publication artifacts (task 5.6): samples, logs and limitations.
  const resultsPath = join(options.out, 'results.json');
  const samplesPath = join(options.out, 'samples', 'bench-samples.jsonl');
  const limitationsPath = join(options.out, 'LIMITATIONS.md');
  const logsDir = join(options.out, 'logs');
  await mkdir(join(options.out, 'samples'), { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const pending = outcomes.filter((o) => o.status === 'pending').length;
  const results = {
    schemaVersion: 1,
    scenario: manifest.name,
    baseCommit,
    seed: manifest.seed ?? null,
    repetitions: repeat,
    comparable: comparability.comparable,
    comparabilityReasons: comparability.reasons,
    reproducible,
    counts: { total: outcomes.length, executed: outcomes.length - failed - pending, failed, pending },
    metricsHonesty,
    limitationsFile: 'LIMITATIONS.md',
    outcomes,
  };
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  const samples = outcomes
    .map((o) => JSON.stringify({ repetition: o.repetition, variant: o.variant, step: o.step, status: o.status, commandExitCode: o.commandExitCode ?? null, checkVerdict: o.checkVerdict ?? null, checkExitCode: o.checkExitCode ?? null, notes: o.notes }))
    .join('\n');
  await writeFile(samplesPath, samples.length > 0 ? `${samples}\n` : '', 'utf8');
  await writeFile(limitationsPath, renderLimitations(manifest, repeat, outcomes), 'utf8');

  out.summary = {
    scenario: manifest.name,
    baseCommit,
    comparable: comparability.comparable,
    comparabilityReasons: comparability.reasons,
    metricsHonesty,
    repetitions: repeat,
    reproducible,
    outcomes,
    artifacts: { results: resultsPath, samples: samplesPath, limitations: limitationsPath, logsDirectory: logsDir },
  };
  log(out, quiet, `eil: bench done: ${outcomes.length} step run(s): ${outcomes.length - failed - pending} executed, ${failed} failed, ${pending} pending (no engine)`);
  log(out, quiet, `eil: bench reproducible across ${repeat} repetition(s): ${reproducible ? 'yes' : 'NO — divergent outcomes, see results.json'}`);
  log(out, quiet, `eil: bench artifacts: ${resultsPath} (samples, LIMITATIONS.md, logs/)`);
  out.exitCode = failed > 0 ? 1 : 0;
  return out;
}

/**
 * Auto-generated honest limitations for a bench run (task 5.6: publish
 * limitations alongside samples). Never claims more than was measured.
 */
function renderLimitations(manifest: BenchmarkManifest, repeat: number, outcomes: BenchStepOutcome[]): string {
  const lines: string[] = [];
  lines.push(`# Limitations — bench '${manifest.name}'`);
  lines.push('');
  lines.push('Read this before citing any number from this run.');
  lines.push('');
  lines.push('## Engine');
  lines.push('');
  const commandVariants = manifest.variants.filter((v) => v.command !== undefined).map((v) => v.id);
  if (commandVariants.length > 0) {
    lines.push(`- Variants with a command (${commandVariants.join(', ')}) execute an OPERATOR-SUPPLIED script, not an integrated coding agent. In the current smoke suite the script is a deterministic fixture stand-in (bench-step.mjs) — it demonstrates the harness, not agent behaviour.`);
  } else {
    lines.push('- No variant executed an engine command: all attempts are recorded as pending; nothing was measured.');
  }
  lines.push('- No Pi SDK / agent integration has run at this stage (Phase 3 is gated on the Tier-1 security review, task 1.7).');
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('- No human acceptance events exist for bench tasks → Cost per Accepted Task and acceptance_rate are UNAVAILABLE, not zero.');
  lines.push('- Attempt costs are unknown (cost_kind unknown) → Cascade Waste and REC have no measured values here.');
  lines.push('- Regression attribution comes only from probe output (FAIL step N lines); no inferred numbers.');
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push(`- Single fixture repository (${manifest.repoFixture}); ${manifest.steps.length} sequential steps; ${manifest.variants.length} variant(s); ${repeat} independent repetition(s).`);
  lines.push('- The fixture is deterministic: repeated runs are EXPECTED to be identical. Reproducibility here verifies the harness, not statistical stability of real engines.');
  lines.push('- Results do not generalize to real repositories, real models or human review effort.');
  lines.push('');
  lines.push(`- Outcomes recorded: ${outcomes.length} (${outcomes.filter((o) => o.status === 'executed').length} executed, ${outcomes.filter((o) => o.status === 'failed').length} failed, ${outcomes.filter((o) => o.status === 'pending').length} pending).`);
  lines.push('');
  return lines.join('\n');
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
