import { runCommand } from '../quality-gates/command-runner.js';
import { FAILURE_SIGNATURES, type AttemptResult, type EngineExecuteInput, type EngineRunner } from './types.js';

export interface ScriptedEngineOptions {
  engineId: string;
  model: string;
  /** Operator-supplied command executed in the workspace (execution policy applies upstream). */
  command: string;
}

function formatLog(input: EngineExecuteInput, run: Awaited<ReturnType<typeof runCommand>>): string {
  return [
    `# engine run (attempt ${input.attemptNumber})`,
    `# exitCode: ${run.exitCode === null ? `<signal ${run.signal}>` : run.exitCode}`,
    `# timedOut: ${run.timedOut}; capKilled: ${run.capKilled}`,
    `# durationMs: ${run.durationMs}`,
    '',
    '--- stdout ---',
    run.stdout,
    '--- stderr ---',
    run.stderr,
    '',
  ].join('\n');
}

/**
 * Deterministic engine stand-in: runs an operator-supplied command inside
 * the isolated workspace and maps the outcome onto the EngineRunner
 * contract. Used by tests, the benchmark harness and the pipeline while the
 * Pi adapter (task 3.4) is pending. No agent loop, no model calls.
 *
 * Failure signatures are mapped deterministically so the cascade planner
 * can route: timeout → 'command:timeout', exit 127 →
 * 'engine:provider-unavailable', other non-zero → 'engine:exit-N',
 * output-cap exceedance → 'command:output-cap'.
 */
export class ScriptedEngineRunner implements EngineRunner {
  readonly id: string;
  readonly model: string;
  private readonly command: string;

  constructor(options: ScriptedEngineOptions) {
    this.id = options.engineId;
    this.model = options.model;
    this.command = options.command;
  }

  capabilities() {
    return { models: [this.model], supportsTokenUsage: false, supportsTools: false };
  }

  async execute(input: EngineExecuteInput): Promise<AttemptResult> {
    const startedAt = new Date().toISOString();
    const command = this.command.replace('{attempt}', String(input.attemptNumber));
    const run = await runCommand(command, input.workspaceDir, {
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
    });
    const completedAt = new Date().toISOString();
    const logContent = formatLog(input, run);

    const failureSignatures: string[] = [];
    let status: AttemptResult['status'];
    if (run.timedOut) {
      status = 'failed';
      failureSignatures.push(FAILURE_SIGNATURES.commandTimeout);
    } else if (run.capKilled) {
      status = 'failed';
      failureSignatures.push(FAILURE_SIGNATURES.outputCap);
    } else if (run.exitCode === null) {
      status = 'aborted';
      failureSignatures.push(`engine:signal-${run.signal ?? 'unknown'}`);
    } else if (run.exitCode === 0) {
      status = 'complete';
    } else if (run.exitCode === 127) {
      status = 'failed';
      failureSignatures.push(FAILURE_SIGNATURES.providerUnavailable);
    } else {
      status = 'failed';
      failureSignatures.push(FAILURE_SIGNATURES.exit(run.exitCode));
    }

    return {
      engine: this.id,
      model: this.model,
      startedAt,
      completedAt,
      status,
      artifacts: { logContent },
      failureSignatures,
    };
  }
}
