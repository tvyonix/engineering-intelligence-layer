import { spawn } from 'node:child_process';
import { gitEnv } from '../diff-inspector/git.js';

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
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: gitEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let capKilled = false;
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > options.maxOutputBytes) {
        capKilled = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > options.maxOutputBytes) {
        capKilled = true;
        child.kill('SIGKILL');
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
