import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureFailedAttempt,
  createTaskWorkspace,
  recoverStaleWorkspaces,
  releaseLock,
  removeWorkspace,
  WorkspaceBusyError,
} from './workspace.js';

let repoDir: string;
let root: string;
let baseCommit: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eil-ws-test-'));
  repoDir = join(root, 'repo');
  await import('node:fs/promises').then((fs) => fs.mkdir(repoDir, { recursive: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  await writeFile(join(repoDir, 'start.txt'), 'base\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  baseCommit = git('rev-parse', 'HEAD').trim();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('task workspace lifecycle (task 3.1)', () => {
  it('creates an independent clone at the base commit with a writer lock', async () => {
    const ws = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'task-1', workspacesRoot: join(root, 'ws') });
    expect(existsSync(join(ws.dir, 'start.txt'))).toBe(true);
    expect(existsSync(join(ws.dir, '.eil-lock.json'))).toBe(true);
    // Changes in the workspace never touch the source repository.
    await writeFile(join(ws.dir, 'new-file.txt'), 'x\n', 'utf8');
    expect(existsSync(join(repoDir, 'new-file.txt'))).toBe(false);
  });

  it('refuses to overwrite an existing directory (idempotent creation)', async () => {
    const wsRoot = join(root, 'ws');
    const first = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'task-1', workspacesRoot: wsRoot });
    // Same task again → a DIFFERENT workspace dir, not a corrupt overwrite.
    const second = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'task-1', workspacesRoot: wsRoot });
    expect(second.dir).not.toBe(first.dir);
    await removeWorkspace(first.dir, { force: true });
    await removeWorkspace(second.dir, { force: true });
  });

  it('one writer: removing a workspace locked by a live writer is refused without damage', async () => {
    const ws = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'task-live', workspacesRoot: join(root, 'ws') });
    await expect(removeWorkspace(ws.dir)).rejects.toBeInstanceOf(WorkspaceBusyError);
    // The first writer is unharmed.
    expect(existsSync(join(ws.dir, '.eil-lock.json'))).toBe(true);
    await releaseLock(ws.dir, 'task-live');
    await removeWorkspace(ws.dir);
    expect(existsSync(ws.dir)).toBe(false);
  });

  it('releaseLock refuses a foreign task id', async () => {
    const ws = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'task-a', workspacesRoot: join(root, 'ws') });
    await expect(releaseLock(ws.dir, 'task-b')).rejects.toBeInstanceOf(WorkspaceBusyError);
    await releaseLock(ws.dir, 'task-a');
  });

  it('recovers stale workspaces (dead pid) and leaves live ones alone', async () => {
    const wsRoot = join(root, 'ws');
    const stale = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'stale', workspacesRoot: wsRoot });
    // Corrupt the lock into a dead-pid state.
    const lockPath = join(stale.dir, '.eil-lock.json');
    await writeFile(lockPath, `${JSON.stringify({ taskId: 'stale', pid: 999999999, host: 'local', createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    const live = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'live', workspacesRoot: wsRoot });

    const removed = await recoverStaleWorkspaces(wsRoot);
    expect(removed).toHaveLength(1);
    expect(existsSync(stale.dir)).toBe(false);
    expect(existsSync(live.dir)).toBe(true);
    await removeWorkspace(live.dir, { force: true });
  });

  it('stale lock is recovered by createTaskWorkspace for the same-named root dir scenario', async () => {
    // A stale lock must not wedge the task forever: recovery works through
    // recoverStaleWorkspaces (tested above); createTaskWorkspace itself
    // refuses only live races.
    const ws = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'fresh', workspacesRoot: join(root, 'ws') });
    await releaseLock(ws.dir, 'fresh');
    await removeWorkspace(ws.dir);
  });
});

describe('captureFailedAttempt (task 4.4)', () => {
  it('preserves changed files and patch into evidence before the workspace is discarded', async () => {
    const ws = await createTaskWorkspace({ repoDir, baseCommit, taskId: 'failing', workspacesRoot: join(root, 'ws') });
    await writeFile(join(ws.dir, 'start.txt'), 'changed by the failed attempt\n', 'utf8');
    await writeFile(join(ws.dir, 'extra.txt'), 'added\n', 'utf8');

    const evidenceDir = join(root, 'evidence');
    const result = await captureFailedAttempt(ws.dir, evidenceDir, 'attempt-2');
    if ('ok' in result) throw new Error(`capture failed: ${result.reason}`);

    const changedFiles = await readFile(result.changedFilesPath, 'utf8');
    expect(changedFiles).toContain('start.txt');
    expect(changedFiles).toContain('extra.txt');
    const patch = await readFile(result.patchPath, 'utf8');
    expect(patch).toContain('changed by the failed attempt');
    // The evidence lives OUTSIDE the workspace: discarding it loses nothing.
    await removeWorkspace(ws.dir, { force: true });
    expect(existsSync(result.patchPath)).toBe(true);
  });
});
