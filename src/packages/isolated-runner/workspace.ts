import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitEnv, runGit } from '../diff-inspector/git.js';

const execFileP = promisify(execFile);

/**
 * Task 3.1: isolated task workspace — an independent clone of the target
 * repository at the task's base commit, with one-writer locking and
 * idempotent cleanup (engine-adapter spec: "One writer" — a second writer
 * gets a clean refusal or another workspace, never a corrupted one).
 *
 * Security boundary (secure-execution spec): this module manages workspace
 * LIFECYCLE only. It never executes repository content; running commands
 * inside the workspace stays gated by the execution policy and, beyond
 * vetted fixtures, by the sandbox runner (Phase 3.2, task 1.7).
 *
 * The source repository is only ever read: local clones hardlink objects
 * and never write to the source.
 */

export class WorkspaceBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBusyError';
  }
}

export interface WorkspaceLock {
  taskId: string;
  pid: number;
  host: string;
  createdAt: string;
}

/**
 * Locks live OUTSIDE the workspace (in the workspaces root), so they never
 * appear in the repository diff of a check run. One `.lock.json` per
 * workspace directory, named after it.
 */
const LOCK_SUFFIX = '.lock.json';
/** Locks from other hosts older than this are treated as stale (cross-host liveness is unknowable). */
const FOREIGN_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockPathFor(workspacesRoot: string, dir: string): string {
  return join(workspacesRoot, `${dir.split('/').pop() ?? dir}${LOCK_SUFFIX}`);
}

async function readLock(workspacesRoot: string, dir: string): Promise<WorkspaceLock | null> {
  const lockPath = lockPathFor(workspacesRoot, dir);
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(await readFile(lockPath, 'utf8')) as WorkspaceLock;
  } catch {
    return null; // corrupt lock: treat as stale by callers that remove it
  }
}

export interface CreateWorkspaceOptions {
  repoDir: string;
  baseCommit: string;
  taskId: string;
  /** Directory that holds task workspaces; defaults to the OS temp dir. */
  workspacesRoot?: string;
  /** Fail instead of recovering a stale lock (default: recover stale locks). */
  noStaleRecovery?: boolean;
}

export interface TaskWorkspace {
  id: string;
  dir: string;
  baseCommit: string;
}

/**
 * Creates a fresh workspace for ONE task: independent clone at the base
 * commit + one-writer lock. Refuses an existing directory (idempotent
 * creation, no silent overwrite) and a workspace locked by a live writer.
 * Stale locks (dead pid on this host, or old foreign-host lock) are
 * recovered so an interrupted run does not wedge the task forever.
 */
export async function createTaskWorkspace(options: CreateWorkspaceOptions): Promise<TaskWorkspace> {
  const root = options.workspacesRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, `eil-ws-${options.taskId}-`));
  try {
    await execFileP('git', ['clone', '--quiet', '--no-checkout', options.repoDir, dir], {
      env: gitEnv(),
      timeout: 120_000,
      windowsHide: true,
    });
    await execFileP('git', ['-C', dir, 'checkout', '--quiet', '--detach', options.baseCommit], {
      env: gitEnv(),
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`workspace clone failed: ${message}`);
  }

  const lockPath = lockPathFor(root, dir);
  const existing = await readLock(root, dir);
  if (existing !== null) {
    // A lock for a brand-new mkdtemp dir can only be a race; refuse cleanly.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw new WorkspaceBusyError(`workspace race detected for task '${options.taskId}'`);
  }
  const lock: WorkspaceLock = {
    taskId: options.taskId,
    pid: process.pid,
    host: 'local',
    createdAt: new Date().toISOString(),
  };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return { id: options.taskId, dir, baseCommit: options.baseCommit };
}

/** Releases the writer lock; the workspace directory stays on disk. */
export async function releaseLock(workspacesRoot: string, dir: string, taskId: string): Promise<void> {
  const lock = await readLock(workspacesRoot, dir);
  if (lock === null) return;
  if (lock.taskId !== taskId) {
    throw new WorkspaceBusyError(`lock belongs to task '${lock.taskId}', not '${taskId}'`);
  }
  await rm(lockPathFor(workspacesRoot, dir), { force: true });
}

/**
 * Idempotent cleanup (task 3.1: "гарантированную очистку"). A workspace
 * locked by a live writer on this host is protected unless force=true;
 * stale locks are removed together with the workspace.
 */
export async function removeWorkspace(
  dir: string,
  options: { force?: boolean; workspacesRoot?: string } = {},
): Promise<void> {
  if (!existsSync(dir)) {
    if (options.workspacesRoot !== undefined) {
      await rm(lockPathFor(options.workspacesRoot, dir), { force: true }).catch(() => undefined);
    }
    return; // idempotent
  }
  const lock = options.workspacesRoot !== undefined ? await readLock(options.workspacesRoot, dir) : null;
  if (!options.force && lock !== null && lock.host === 'local' && isPidAlive(lock.pid)) {
    throw new WorkspaceBusyError(`workspace '${dir}' is locked by live pid ${lock.pid} (task '${lock.taskId}')`);
  }
  await rm(dir, { recursive: true, force: true });
  if (options.workspacesRoot !== undefined) {
    await rm(lockPathFor(options.workspacesRoot, dir), { force: true }).catch(() => undefined);
  }
}

/**
 * Recovers stale workspaces under a root: removes directories whose lock
 * holder is dead on this host, or whose foreign-host lock is older than
 * FOREIGN_LOCK_MAX_AGE_MS. Returns the removed directories.
 */
export async function recoverStaleWorkspaces(workspacesRoot: string): Promise<string[]> {
  const removed: string[] = [];
  if (!existsSync(workspacesRoot)) return removed;
  const fs = await import('node:fs/promises');
  const dirents = await fs.readdir(workspacesRoot, { withFileTypes: true });
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    // Only EIL-managed workspaces (1.7 review): never touch foreign
    // directories that merely lack a lock file.
    if (!dirent.name.startsWith('eil-ws-') && !dirent.name.startsWith('eil-bench-') && !/eil-ws-.*\.lock\.json/.test(dirent.name)) continue;
    const dir = join(workspacesRoot, dirent.name);
    const lock = await readLock(workspacesRoot, dir);
    const stale =
      lock === null || // no readable lock: orphaned workspace
      (lock.host === 'local' && !isPidAlive(lock.pid)) ||
      (lock.host !== 'local' && Date.now() - Date.parse(lock.createdAt) > FOREIGN_LOCK_MAX_AGE_MS);
    if (stale) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await rm(lockPathFor(workspacesRoot, dir), { force: true }).catch(() => undefined);
      removed.push(dir);
    }
  }
  return removed;
}

/**
 * Task 4.4: preserves the artifacts of a FAILED attempt (changed-file list
 * and patch) into the evidence directory, so review can see what the
 * attempt did before the workspace is discarded. The next attempt always
 * starts from a fresh clone — uncontrolled state never carries over.
 */
export async function captureFailedAttempt(
  workspaceDir: string,
  evidenceDir: string,
  attemptId: string,
  options: { baseCommit?: string } = {},
): Promise<{ changedFilesPath: string; patchPath: string } | { ok: false; reason: string }> {
  // Diff against the task BASE, not the index: an engine may COMMIT its
  // changes, and index-only diffs would silently miss them (1.7 review).
  const diffArgsBase = options.baseCommit !== undefined ? [options.baseCommit, '--'] : [];
  const nameStatus = await runGit(workspaceDir, ['diff', '--name-status', '-z', '--no-color', ...diffArgsBase]);
  if (nameStatus.code !== 0) {
    return { ok: false, reason: `git diff failed: ${nameStatus.stderr.trim()}` };
  }
  const patch = await runGit(workspaceDir, ['diff', '--no-color', ...diffArgsBase]);
  if (patch.code !== 0) {
    return { ok: false, reason: `git diff (patch) failed: ${patch.stderr.trim()}` };
  }
  // Untracked files: listed separately and included in the patch via
  // --no-index (read-only, like the check-mode evidence).
  const untracked = await runGit(workspaceDir, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.code !== 0) {
    return { ok: false, reason: `git ls-files failed: ${untracked.stderr.trim()}` };
  }
  const untrackedPaths = untracked.stdout.split('\0').filter((p) => p.length > 0);
  const parts = [patch.stdout];
  for (const untrackedPath of untrackedPaths) {
    const perFile = await runGit(
      workspaceDir,
      ['diff', '--no-color', '--no-index', '--', '/dev/null', join(workspaceDir, untrackedPath)],
      { allowNonZero: true },
    );
    if (perFile.code === 0 || perFile.code === 1) {
      parts.push(`\n# untracked file: ${untrackedPath}\n${perFile.stdout}`);
    }
  }
  const outDir = join(evidenceDir, 'failed-attempts', attemptId);
  await mkdir(outDir, { recursive: true });
  const changedFilesPath = join(outDir, 'changed-files.txt');
  const patchPath = join(outDir, 'attempt.patch');
  const changedFilesContent = [
    '# Tracked changes',
    nameStatus.stdout.replace(/\0/g, '\n'),
    '# Untracked files',
    ...untrackedPaths,
    '',
  ].join('\n');
  const { redactSecretsInText } = await import('../quality-gates/secrets-scan-gate.js');
  await writeFile(changedFilesPath, changedFilesContent, 'utf8');
  // Captured patches are evidence: secret-shaped content is redacted
  // before storage (1.7 review).
  await writeFile(patchPath, redactSecretsInText(parts.join('')), 'utf8');
  return { changedFilesPath, patchPath };
}
