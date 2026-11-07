import { realpath } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { TaskContract } from '../contracts/task-contract.js';
import { parseTaskContract } from '../contracts/task-contract.js';
import { hashTaskContract } from '../contracts/hash.js';
import type { ResolvedPolicy } from '../contracts/policy.js';
import { resolveCommit } from '../diff-inspector/git.js';
import { isExecutionPermitted } from '../quality-gates/execution-policy.js';
import { classifyTaskRisk, type TaskRisk } from '../policy-engine/risk.js';
import { planNextAttempt, type AttemptRecord, type CascadePlan } from '../policy-engine/cascade.js';
import {
  captureFailedAttempt,
  createTaskWorkspace,
  releaseLock,
  removeWorkspace,
} from '../isolated-runner/workspace.js';
import { openLedger, closeLedger, type Ledger } from '../ledger/db.js';
import { recordAttempt, recordCheckRun } from '../ledger/records.js';
import { evidenceBundleSchema } from '../evidence/bundle.js';
import type { AttemptResult, EngineRunner } from '../agent-adapters/types.js';

/**
 * Attempt orchestration — the bones of `eil run` (task 3.6) at the policy
 * level. Wires together, in order: risk classification (4.1) → cascade
 * plan (4.2–4.3) → isolated workspace (3.1) → engine execution (via the
 * injected EngineRunner; Pi adapter lands with 3.4) → EIL check of the
 * resulting diff → ledger records → next plan.
 *
 * Boundaries:
 * - engine execution requires the execution policy to permit the target
 *   repository (vetted fixtures until the sandbox sign-off, 1.7);
 * - the checker is injected by the CLI layer (packages never import apps);
 * - cost stays 'unknown' unless an engine reports real usage;
 * - no CLI command is exposed yet: `eil run` ships with the Pi adapter
 *   (3.6), this module is the tested core.
 */

export interface PipelineCheckRequest {
  repo: string;
  task: string;
  base: string;
  out: string;
}

export interface PipelineCheckResult {
  exitCode: 0 | 1 | 2;
  evidenceDir: string | null;
}

export type PipelineChecker = (request: PipelineCheckRequest) => Promise<PipelineCheckResult>;

export interface PipelineOptions {
  repo: string;
  taskFile: string;
  /** Operator policy (resolved upstream, e.g. by the CLI). */
  policy: ResolvedPolicy;
  engine: EngineRunner;
  checker: PipelineChecker;
  out: string;
  ledger?: string;
  maxCheapRetries?: number;
  strongTierConfigured?: boolean;
  quiet?: boolean;
}

export interface PipelineAttemptSummary {
  attemptNumber: number;
  tier: 'cheap' | 'strong' | null;
  engineStatus: 'complete' | 'failed' | 'aborted';
  checkVerdict?: string;
  checkExitCode?: number;
  failureSignatures: string[];
  workspaceDiscarded: boolean;
}

export interface PipelineSummary {
  taskId: string;
  finalRisk: TaskRisk;
  finalAction: CascadePlan['action'];
  attempts: PipelineAttemptSummary[];
  exitCode: 0 | 1 | 2;
  notes: string[];
}

interface LoadedTask {
  ok: true;
  contract: TaskContract;
  contractHash: string;
}

interface LoadedTaskFailure {
  ok: false;
  issues: string[];
}

async function loadTask(taskFile: string): Promise<LoadedTask | LoadedTaskFailure> {
  let text: string;
  try {
    text = await readFile(taskFile, 'utf8');
  } catch (error) {
    return { ok: false, issues: [`cannot read task contract: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    return { ok: false, issues: [`invalid YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = parseTaskContract(data, hashTaskContract);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  return { ok: true, contract: parsed.contract, contractHash: parsed.contractHash };
}

export async function runTaskPipeline(options: PipelineOptions): Promise<PipelineSummary> {
  const notes: string[] = [];
  const attempts: PipelineAttemptSummary[] = [];
  const startedAt = new Date().toISOString();

  const loaded = await loadTask(options.taskFile);
  if (!loaded.ok) {
    return {
      taskId: '(invalid)',
      finalRisk: 'blocked',
      finalAction: 'reject-blocked',
      attempts,
      exitCode: 2,
      notes: loaded.issues,
    };
  }
  const contract = loaded.contract;
  const contractHash = loaded.contractHash;

  let ledger: Ledger | null = null;
  if (options.ledger !== undefined) {
    ledger = await openLedger(options.ledger);
    ledger.db
      .prepare(
        `INSERT INTO tasks (id, base_commit, type, risk, status, contract_hash, created_at)
         VALUES (?, ?, 'pipeline', 'unknown', 'pending', ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = 'pending', contract_hash = excluded.contract_hash`,
      )
      .run(contract.id, contract.baseCommit, contractHash, startedAt);
  }

  try {
    // Repository resolution + engine execution permission.
    const { runGit } = await import('../diff-inspector/git.js');
    const toplevelResult = await runGit(options.repo, ['rev-parse', '--show-toplevel']);
    if (toplevelResult.code !== 0) {
      return {
        taskId: contract.id,
        finalRisk: 'blocked',
        finalAction: 'reject-blocked',
        attempts,
        exitCode: 2,
        notes: [`'${options.repo}' is not a git repository`],
      };
    }
    const toplevel = toplevelResult.stdout.trim();
    const repoRealRoot = await realpath(toplevel);
    const baseCommit = await resolveCommit(toplevel, contract.baseCommit);
    if (baseCommit === null) {
      return {
        taskId: contract.id,
        finalRisk: 'blocked',
        finalAction: 'reject-blocked',
        attempts,
        exitCode: 2,
        notes: [`base commit '${contract.baseCommit}' does not resolve`],
      };
    }

    const permission = isExecutionPermitted(options.policy, repoRealRoot);
    if (!permission.permitted) {
      notes.push(permission.reason);
      notes.push('the pipeline runs no engine attempts; task stays pending for review');
      return {
        taskId: contract.id,
        finalRisk: (await preflightRisk(contract, ledger)).finalRisk,
        finalAction: 'needs-review',
        attempts,
        exitCode: 2,
        notes,
      };
    }

    // Cascade loop. Risk starts from hints and is monotonically upgraded by
    // gate evidence after each attempt.
    let risk: TaskRisk = classifyTaskRisk({
      changedPaths: [],
      violations: [],
      riskHints: contract.riskHints,
    }).risk;
    const attemptRecords: AttemptRecord[] = [];
    let finalAction: CascadePlan['action'] = 'needs-review';
    const timeoutMs = options.policy.execution?.timeoutMs ?? 120_000;
    const maxOutputBytes = options.policy.execution?.maxOutputBytes ?? 1024 * 1024;

    for (let attemptNumber = 1; attemptNumber <= Math.max(1, contract.policy.maxAttempts) + 1; attemptNumber += 1) {
      const plan = planNextAttempt({
        risk,
        attempts: attemptRecords,
        maxAttempts: contract.policy.maxAttempts,
        maxCheapRetries: options.maxCheapRetries ?? 1,
        strongTierConfigured: options.strongTierConfigured ?? false,
      });
      finalAction = plan.action;
      notes.push(`attempt ${attemptNumber}: plan ${plan.action} — ${plan.reason}`);

      if (plan.action === 'reject-blocked' || plan.action === 'needs-review') break;

      const tier = plan.tier as 'cheap' | 'strong';
      const workspace = await createTaskWorkspace({
        repoDir: toplevel,
        baseCommit,
        taskId: contract.id,
        workspacesRoot: join(options.out, 'workspaces'),
      });
      let workspaceDiscarded = false;
      let engineStatus: AttemptResult['status'] = 'aborted';
      let failureSignatures: string[] = [];
      let checkVerdict: string | undefined;
      let checkExitCode: number | undefined;
      try {
        const result = await options.engine.execute({
          workspaceDir: workspace.dir,
          taskDescription: contract.description,
          attemptNumber,
          timeoutMs,
          maxOutputBytes,
        });
        engineStatus = result.status;
        failureSignatures = [...result.failureSignatures];
        attemptRecords.push({
          id: `attempt-${attemptNumber}`,
          tier,
          status: result.status === 'complete' ? 'complete' : 'failed',
          failureSignatures,
        });
        if (ledger !== null) {
          recordAttempt(ledger, {
            taskId: contract.id,
            engine: result.engine,
            model: result.model,
            status: result.status,
            startedAt: result.startedAt,
            endedAt: result.completedAt,
            costKind: result.usage ? 'billed' : 'unknown',
            policyVersion: options.policy.source,
          });
        }

        // The engine's diff is checked even when the engine failed: partial
        // work still needs evidence for the next plan / human review.
        const check = await options.checker({
          repo: workspace.dir,
          task: options.taskFile,
          base: baseCommit,
          out: join(options.out, 'attempt-' + attemptNumber),
        });
        checkExitCode = check.exitCode;
        if (check.evidenceDir !== null) {
          const raw = await readFile(join(check.evidenceDir, 'evidence.json'), 'utf8');
          const bundle = evidenceBundleSchema.parse(JSON.parse(raw));
          checkVerdict = bundle.verdict;
          // The verification run is a ledger attempt of its own ('eil-check'):
          // metrics sum attempt + verification costs (design.md §11).
          if (ledger !== null) {
            recordCheckRun(ledger, {
              taskId: contract.id,
              baseCommit,
              contractHash,
              status: bundle.verdict,
              risk: bundle.risk,
              startedAt: result.startedAt,
              completedAt: new Date().toISOString(),
              policyVersion: options.policy.source,
              evidenceDir: check.evidenceDir,
              gates: bundle.gateResults.map((g) => ({
                id: g.id,
                status: g.status,
                mandatory: g.mandatory,
                durationMs: g.durationMs,
                evidencePath: g.evidencePath,
              })),
            });
          }
          // Monotonic risk upgrade from gate evidence (4.1 property).
          const assessed = classifyTaskRisk({
            changedPaths: [],
            violations: bundle.policyViolations,
            riskHints: contract.riskHints,
          });
          if (riskRank(assessed.risk) > riskRank(risk)) risk = assessed.risk;
          // Failed mandatory gates become reproducible failure signatures.
          for (const gate of bundle.gateResults) {
            if (gate.mandatory && (gate.status === 'fail' || gate.status === 'error')) {
              failureSignatures.push(`gate:${gate.id}:${gate.status}`);
            }
          }
          if (attemptRecords.length > 0) {
            const last = attemptRecords[attemptRecords.length - 1] as AttemptRecord;
            last.failureSignatures = [...last.failureSignatures, ...failureSignatures.filter((s) => s.startsWith('gate:'))];
          }
        } else {
          failureSignatures.push('gate:check-unavailable:error');
          const last = attemptRecords[attemptRecords.length - 1] as AttemptRecord | undefined;
          if (last !== undefined) last.failureSignatures = [...last.failureSignatures, 'gate:check-unavailable:error'];
        }

        if (result.status !== 'complete' || checkVerdict === 'blocked' || checkVerdict === 'error') {
          // Failed attempt: preserve artifacts, then discard the workspace.
          const capture = await captureFailedAttempt(workspace.dir, options.out, `attempt-${attemptNumber}`);
          if ('ok' in capture && capture.ok === false) {
            notes.push(`attempt ${attemptNumber}: artifact capture failed — ${capture.reason}`);
          }
          workspaceDiscarded = true;
        }
      } finally {
        if (workspaceDiscarded) {
          await removeWorkspace(workspace.dir, { force: true, workspacesRoot: join(options.out, 'workspaces') });
        } else {
          await releaseLock(join(options.out, 'workspaces'), workspace.dir, contract.id).catch(() => undefined);
          await removeWorkspace(workspace.dir, { force: true, workspacesRoot: join(options.out, 'workspaces') });
          workspaceDiscarded = true;
        }
      }

      attempts.push({
        attemptNumber,
        tier,
        engineStatus,
        checkVerdict,
        checkExitCode,
        failureSignatures,
        workspaceDiscarded,
      });

      // Successful check → human review; anything else continues per plan.
      if (engineStatus === 'complete' && checkVerdict === 'needs_review') {
        finalAction = 'needs-review';
        notes.push(`attempt ${attemptNumber}: gates passed → needs_review (human acceptance is a separate event)`);
        break;
      }
    }

    const exitCode: 0 | 1 | 2 =
      attempts.length === 0 ? 2 : attempts.some((a) => a.checkVerdict === 'needs_review') ? 0 : attempts.some((a) => a.engineStatus === 'failed') ? 1 : 2;
    if (ledger !== null) {
      ledger.db.prepare('UPDATE tasks SET status = ?, risk = ? WHERE id = ?').run(
        attempts.some((a) => a.checkVerdict === 'needs_review') ? 'needs_review' : 'pending',
        risk,
        contract.id,
      );
    }
    return { taskId: contract.id, finalRisk: risk, finalAction, attempts, exitCode, notes };
  } finally {
    if (ledger !== null) closeLedger(ledger);
  }
}

function riskRank(risk: TaskRisk): number {
  return { low: 0, medium: 1, high: 2, blocked: 3 }[risk];
}

async function preflightRisk(contract: TaskContract, ledger: Ledger | null): Promise<{ finalRisk: TaskRisk }> {
  const assessment = classifyTaskRisk({ changedPaths: [], violations: [], riskHints: contract.riskHints });
  if (ledger !== null) {
    ledger.db.prepare('UPDATE tasks SET risk = ? WHERE id = ?').run(assessment.risk, contract.id);
  }
  return { finalRisk: assessment.risk };
}
