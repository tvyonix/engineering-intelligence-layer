import { spawn } from 'node:child_process';
import { buildSandboxedEnv } from './command-env.js';

export interface CommandRunResult {
  /** null when the process was killed by a signal. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Killed because output exceeded the cap (protects host memory). */
  capKilled: boolean;
  stdout: string;
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface RunCommandOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Runs an operator-supplied gate command via `bash -c` inside cwd.
 *
 * Trust boundaries:
 * - the command string comes from operator policy, never from repository
 *   content (see execution-policy.ts for the permission gate);
 * - stdout/stderr are capped: exceeding the cap kills the child and is
 *   reported as an error condition, never silently truncated to success;
 * - timeouts kill the child (SIGKILL after grace attempts) and are reported
 *   as `timedOut`, which gates map to `error`, never `pass`.
 */
export function runCommand(command: string, cwd: string, options: RunCommandOptions): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // detached + process group: a timeout must kill the WHOLE tree.
    // Killing only bash left children alive holding the stdio pipes —
    // an 8s `sleep` outlived a 500ms timeout by 7.5s (1.7 review).
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: buildSandboxedEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const killGroup = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // group already gone — fall through to direct kill
        }
      }
      child.kill('SIGKILL');
    };

    let timedOut = false;
    let capKilled = false;
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > options.maxOutputBytes) {
        capKilled = true;
        killGroup();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > options.maxOutputBytes) {
        capKilled = true;
        killGroup();
        return;
      }
      stderrChunks.push(chunk);
    });

    const finish = (exitCode: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        capKilled,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (error) => {
      // Spawn failure (e.g. bash missing): report via stderr with exit code 127.
      stderrChunks.push(Buffer.from(`spawn failed: ${error.message}\n`, 'utf8'));
      finish(127, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
