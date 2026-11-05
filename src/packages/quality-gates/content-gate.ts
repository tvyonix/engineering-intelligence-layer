import type { Violation } from '../policy-engine/violations.js';
import { classifyViolations } from '../policy-engine/violations.js';
import type { ParsedDiagnostic } from './diagnostics.js';
import { executionMaxOutputBytes, executionTimeoutMs, isExecutionPermitted } from './execution-policy.js';
import { runCommand, type CommandRunResult } from './command-runner.js';
import type { Gate, GateContext, GateOutcome } from './types.js';

export interface ContentGateOptions {
  id: 'types' | 'lint';
  /** Used when policy.quality.commands does not define this gate's command. */
  defaultCommand: string;
  parseOutput(output: string, scanRoot: string): ParsedDiagnostic[];
}

function formatLog(label: string, run: CommandRunResult): string {
  const header = [
    `# ${label} run`,
    `# exitCode: ${run.exitCode === null ? '<killed>' : run.exitCode}`,
    `# signal: ${run.signal ?? '<none>'}`,
    `# timedOut: ${run.timedOut}`,
    `# capKilled: ${run.capKilled}`,
    `# durationMs: ${run.durationMs}`,
    '',
  ].join('\n');
  return `${header}--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}\n`;
}

function toViolations(diags: ParsedDiagnostic[], classification: Violation['classification']): Violation[] {
  return diags.map((d) => ({ rule: d.rule, path: d.path, detail: d.detail, classification }));
}

interface CommandOutcome {
  ok: true;
  diagnostics: ParsedDiagnostic[];
  log: string;
}

interface CommandFailure {
  ok: false;
  reason: string;
  log: string;
}

/**
 * Shared runner for content gates (types, lint).
 *
 * Exit-code semantics: 0 = clean, 1 = violations found (parseable
 * diagnostics expected), anything else (including 127 tool-missing, 2
 * config-error, timeouts, signals) = execution error. An exit code 1 with
 * zero parseable diagnostics is an error, not a pass: unexplained failure
 * never yields success.
 *
 * Baseline classification: the same command runs against a snapshot of the
 * base commit; diagnostics present there are `inherited`, the rest are
 * `new` (diff-quality spec: "Existing defects"). If the baseline scan is
 * unavailable or fails, the gate reports `error` — attribution cannot be
 * proven, so the check fails closed. Gate outcome: `fail` only on NEW
 * violations; inherited-only findings are `pass` with recorded warnings.
 */
export function contentGate(options: ContentGateOptions): Gate {
  return {
    id: options.id,
    async run(ctx: GateContext): Promise<GateOutcome> {
      const permission = isExecutionPermitted(ctx.policy, ctx.repoRealRoot);
      if (!permission.permitted) {
        return { status: 'error', reason: permission.reason };
      }
      const command = ctx.policy.quality.commands?.[options.id] ?? options.defaultCommand;
      const runOpts = { timeoutMs: executionTimeoutMs(ctx.policy), maxOutputBytes: executionMaxOutputBytes(ctx.policy) };

      const current = await runCommand(command, ctx.repoDir, runOpts);
      const artifacts: { fileName: string; content: string }[] = [
        { fileName: 'output.log', content: formatLog('current', current) },
      ];
      const currentResult = interpretRun(current, options, ctx.repoDir);
      if (!currentResult.ok) {
        return { status: 'error', reason: currentResult.reason, artifacts };
      }

      const baselineResult = await scanBaseline(ctx, options, runOpts);
      if (!baselineResult.ok) {
        return { status: 'error', reason: baselineResult.reason, artifacts };
      }
      artifacts.push({ fileName: 'baseline-output.log', content: baselineResult.log });

      const currentViolations = toViolations(currentResult.diagnostics, 'new');
      const baselineViolations = toViolations(baselineResult.diagnostics, 'new');
      const { newViolations, inherited } = classifyViolations(currentViolations, baselineViolations);

      const status = newViolations.length > 0 ? 'fail' : 'pass';
      const parts: string[] = [`${newViolations.length} new, ${inherited.length} inherited (baseline: base commit ${ctx.baseCommit.slice(0, 12)})`];
      if (newViolations.length > 0) {
        parts.push(
          `new: ${newViolations
            .slice(0, 5)
            .map((v) => `${v.rule}@${v.path}`)
            .join('; ')}${newViolations.length > 5 ? '; …' : ''}`,
        );
      }
      if (inherited.length > 0) {
        parts.push(`inherited findings are recorded in evidence and not attributed to this change`);
      }
      const reason = `${options.id}: ${parts.join(' — ')}`;

      return { status, reason, violations: [...newViolations, ...inherited], artifacts };
    },
  };
}

function interpretRun(
  run: CommandRunResult,
  options: ContentGateOptions,
  scanRoot: string,
): CommandOutcome | CommandFailure {
  if (run.timedOut) {
    return { ok: false, reason: `command timed out after being killed (limit reached)`, log: formatLog('current', run) };
  }
  if (run.capKilled) {
    return { ok: false, reason: `output limit exceeded; the tool was killed to protect the host`, log: formatLog('current', run) };
  }
  if (run.exitCode === null) {
    return { ok: false, reason: `command was killed by signal ${run.signal ?? 'unknown'}`, log: formatLog('current', run) };
  }
  if (run.exitCode === 0) {
    return { ok: true, diagnostics: [], log: formatLog('current', run) };
  }
  if (run.exitCode === 1) {
    const diagnostics = options.parseOutput(`${run.stdout}\n${run.stderr}`, scanRoot);
    if (diagnostics.length === 0) {
      return {
        ok: false,
        reason: 'command reported failure (exit 1) but produced no parseable diagnostics; failing closed',
        log: formatLog('current', run),
      };
    }
    return { ok: true, diagnostics, log: formatLog('current', run) };
  }
  return {
    ok: false,
    reason: `command exited with code ${run.exitCode} (execution/config error, tool missing, or invalid configuration)`,
    log: formatLog('current', run),
  };
}

async function scanBaseline(
  ctx: GateContext,
  options: ContentGateOptions,
  runOpts: { timeoutMs: number; maxOutputBytes: number },
): Promise<{ ok: true; diagnostics: ParsedDiagnostic[]; log: string } | { ok: false; reason: string; log: string }> {
  if (ctx.baselineSnapshot === undefined) {
    return { ok: false, reason: 'baseline scan unavailable: no baseline snapshot provider configured', log: '' };
  }
  const snapshot = await ctx.baselineSnapshot();
  if (!snapshot.ok) {
    return {
      ok: false,
      reason: `baseline scan unavailable: ${snapshot.reason}; cannot distinguish new from inherited violations — failing closed`,
      log: '',
    };
  }
  const command = ctx.policy.quality.commands?.[options.id] ?? options.defaultCommand;
  const run = await runCommand(command, snapshot.dir, runOpts);
  const log = formatLog('baseline', run);
  const interpreted = interpretRun(run, options, snapshot.dir);
  if (!interpreted.ok) {
    return { ok: false, reason: `baseline scan failed: ${interpreted.reason}`, log };
  }
  return { ok: true, diagnostics: interpreted.diagnostics, log };
}
