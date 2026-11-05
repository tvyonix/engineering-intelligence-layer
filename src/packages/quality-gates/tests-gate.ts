import { executionMaxOutputBytes, executionTimeoutMs, isExecutionPermitted } from './execution-policy.js';
import { runCommand } from './command-runner.js';
import type { Gate, GateContext, GateOutcome } from './types.js';

export const TESTS_GATE_ID = 'tests';

function formatLog(run: Awaited<ReturnType<typeof runCommand>>): string {
  return [
    '# current run',
    `# exitCode: ${run.exitCode === null ? '<killed>' : run.exitCode}`,
    `# signal: ${run.signal ?? '<none>'}`,
    `# timedOut: ${run.timedOut}`,
    `# capKilled: ${run.capKilled}`,
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
 * Gate `tests`: runs the operator-configured test command. Unlike content
 * gates (types, lint) this is a tree-state gate: any failure fails the gate
 * because a red test suite invalidates the change regardless of whether the
 * failure pre-existed at baseline. Baseline attribution is deliberately not
 * applied here.
 *
 * Failure exit code 1 with npm's "Missing script" is reported as an error
 * (configuration problem), not a test failure.
 */
export function testsGate(): Gate {
  return {
    id: TESTS_GATE_ID,
    async run(ctx: GateContext): Promise<GateOutcome> {
      const permission = isExecutionPermitted(ctx.policy, ctx.repoRealRoot);
      if (!permission.permitted) {
        return { status: 'error', reason: permission.reason };
      }
      const command = ctx.policy.quality.commands?.[TESTS_GATE_ID] ?? 'npm test';
      const run = await runCommand(command, ctx.repoDir, {
        timeoutMs: executionTimeoutMs(ctx.policy),
        maxOutputBytes: executionMaxOutputBytes(ctx.policy),
      });
      const log = formatLog(run);
      const artifacts = [{ fileName: 'output.log', content: log }];

      if (run.timedOut) {
        return { status: 'error', reason: `test command timed out and was killed; failing closed`, artifacts };
      }
      if (run.capKilled) {
        return { status: 'error', reason: `test command exceeded the output limit and was killed`, artifacts };
      }
      if (run.exitCode === null) {
        return { status: 'error', reason: `test command was killed by signal ${run.signal ?? 'unknown'}`, artifacts };
      }
      if (run.exitCode === 0) {
        return { status: 'pass', reason: 'test command passed (exit 0)', artifacts };
      }
      if (run.exitCode === 1) {
        if (/Missing script/i.test(`${run.stdout}\n${run.stderr}`)) {
          return {
            status: 'error',
            reason: 'no test script is configured (npm: Missing script "test"); cannot verify tests — failing closed',
            artifacts,
          };
        }
        return {
          status: 'fail',
          reason: 'test command failed (exit 1); full output in evidence log',
          artifacts,
        };
      }
      return {
        status: 'error',
        reason: `test command exited with code ${run.exitCode} (execution/config error)`,
        artifacts,
      };
    },
  };
}
