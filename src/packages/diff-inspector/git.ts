import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Environment for git subprocesses. Ambient GIT_* variables are stripped so a
 * hostile or misconfigured shell (GIT_DIR, GIT_WORK_TREE, ...) cannot redirect
 * git at another repository or index; system gitconfig is ignored.
 */
/**
 * Repo-config hardening (1.7 review): values from the TARGET repository's
 * .git/config must not execute on the host. These -c overrides defeat
 * core.fsmonitor (spawns a helper process), diff.external (spawns an
 * arbitrary command AND nullifies the patch) and core.attributesFile
 * (repo-controlled gitattributes that can mark diffs binary).
 */
export const GIT_HARDENING_FLAGS: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.pager=cat',
] as const;

/** Builtin-diff enforcement flags for every `git diff` invocation. */
export const DIFF_NO_EXTERNAL: readonly string[] = ['--no-ext-diff', '--no-textconv'] as const;

export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  delete env['GIT_OBJECT_DIRECTORY'];
  delete env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
  delete env['GIT_COMMON_DIR'];
  delete env['GIT_CONFIG'];
  delete env['GIT_CONFIG_PARAMETERS'];
  delete env['GIT_NAMESPACE'];
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  return env;
}

export interface RunGitOptions {
  timeoutMs?: number;
  /** Ignore non-zero exit (some git commands use exit codes semantically, e.g. `diff --quiet`). */
  allowNonZero?: boolean;
}

/** Runs git read-only commands against the target repository. Never uses a shell. */
export async function runGit(repoDir: string, args: readonly string[], options: RunGitOptions = {}): Promise<GitCommandResult> {
  // git diff must never run repo-configured external diff/textconv
  // helpers (1.7 review: diff.external executed on the host AND nulled
  // the captured patch).
  const finalArgs = args[0] === 'diff' ? ['diff', ...DIFF_NO_EXTERNAL, ...args.slice(1)] : args;
  try {
    const { stdout, stderr } = await execFileP(
      'git',
      ['-C', repoDir, '-c', 'core.quotepath=false', ...GIT_HARDENING_FLAGS, ...finalArgs],
      {
        timeout: options.timeoutMs ?? 30000,
        maxBuffer: 64 * 1024 * 1024,
        env: gitEnv(),
        windowsHide: true,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (options.allowNonZero && isExecError(error)) {
      return {
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? error.message,
      };
    }
    throw error;
  }
}

interface ExecError extends Error {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error && ('code' in error || 'killed' in error);
}

/** Turns a non-zero/non-timeout git failure into a uniform error result. */
export function gitFailure(error: unknown, what: string): GitCommandResult {
  if (isExecError(error)) {
    const code = typeof error.code === 'number' ? error.code : error.killed ? 124 : 1;
    return { code, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 1, stdout: '', stderr: `${what}: ${message}` };
}

export async function resolveCommit(repoDir: string, ref: string): Promise<string | null> {
  try {
    const result = await runGit(repoDir, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    if (result.code !== 0) return null;
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export interface ChangedPath {
  /** Destination path (repo-root-relative, POSIX). */
  path: string;
  /** Source path for renames/copies. */
  origPath?: string;
  /** git status letter(s): M, A, D, T, R100, C75, U, ... */
  status: string;
  source: 'diff' | 'untracked';
}

/**
 * Parses `git diff --name-status -z` output. Token layout (verified against
 * git 2.39): status token, then path; for renames/copies the token order is
 * `R100\0<orig>\0<dest>\0` — status, source path, destination path.
 */
export function parseNameStatusZ(output: string): ChangedPath[] {
  const tokens = output.split('\0');
  // Drop trailing empty token after the final NUL.
  while (tokens.length > 0 && (tokens[tokens.length - 1] as string | undefined) === '') tokens.pop();
  const changed: ChangedPath[] = [];
  let index = 0;
  while (index < tokens.length) {
    const head = tokens[index] as string | undefined;
    index += 1;
    if (head === undefined || head.length === 0) continue;
    const match = /^([A-Z]{1,2})(\d+)?$/.exec(head);
    if (match === null) {
      // Unrecognized token: fail closed by representing it as a suspect path entry.
      changed.push({ path: head, status: 'X', source: 'diff' });
      continue;
    }
    const status = match[1] as string;
    const firstPath = tokens[index] as string | undefined;
    index += 1;
    if (firstPath === undefined) {
      changed.push({ path: head, status: 'X', source: 'diff' });
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      // Empirical token order: status, origPath, destPath.
      const orig = firstPath;
      const dest = tokens[index] as string | undefined;
      index += 1;
      changed.push({
        path: dest ?? orig,
        origPath: dest !== undefined ? orig : undefined,
        status,
        source: 'diff',
      });
      continue;
    }
    changed.push({ path: firstPath, status, source: 'diff' });
  }
  return changed;
}

export interface HiddenChangeFinding {
  kind: 'skip-worktree' | 'assume-unchanged' | 'untracked-hidden-by-exclude' | 'nested-git-repository';
  path: string;
  detail: string;
}

export interface DiffSummary {
  changed: ChangedPath[];
  untracked: string[];
  worktreeDirty: boolean;
  /** What the base commit itself changed (base~1..base); null when base has no parent. */
  baselineChanged: ChangedPath[] | null;
  baselineNote?: string;
  patch: string | null;
  patchTruncated: boolean;
  /**
   * Changes an engine could HIDE from a plain git diff (1.7 review):
   * skip-worktree/assume-unchanged bits, untracked files excluded via
   * .gitignore/.git/info/exclude, and nested git repositories whose
   * content the parent repository does not report.
   */
  hiddenChanges: HiddenChangeFinding[];
}

const MAX_PATCH_BYTES = 16 * 1024 * 1024;

export interface SnapshotResult {
  ok: true;
  /** Absolute path of the extracted snapshot directory. */
  dir: string;
}

export interface SnapshotFailure {
  ok: false;
  reason: string;
}

/**
 * Extracts a commit's tree into a fresh temp directory via `git archive` —
 * fully read-only for the repository (no worktree metadata is written).
 * Used by content gates to scan the baseline for new-vs-inherited
 * classification. Caller owns cleanup (removeSnapshot).
 */
export async function extractCommitSnapshot(repoDir: string, sha: string): Promise<SnapshotResult | SnapshotFailure> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'eil-baseline-'));
    // Resolve the realpath: tools report absolute paths through the OS
    // symlink chain (macOS /var -> /private/var), and diagnostic
    // normalization must compare against the same prefix.
    dir = await realpath(dir);
    const archive = await execFileP('git', ['-C', repoDir, 'archive', '--format=tar', sha], {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
      env: gitEnv(),
      timeout: 60000,
      windowsHide: true,
    });
    const tarFile = join(dir, '.eil-snapshot.tar');
    await writeFile(tarFile, archive.stdout);
    await execFileP('tar', ['-xf', tarFile, '-C', dir], { timeout: 60000, windowsHide: true });
    await rm(tarFile, { force: true });
    return { ok: true, dir };
  } catch (error) {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `git archive snapshot failed: ${message}` };
  }
}

export async function removeSnapshot(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Collects the change under review: tracked diff (base..worktree), untracked
 * files (a change may add files git diff does not list), worktree dirty flag,
 * the base commit's own diff for baseline context, and the full patch for the
 * evidence bundle. All operations are read-only.
 */
export async function collectDiff(repoDir: string, baseSha: string, headSha: string): Promise<DiffSummary> {
  const diffResult = await runGit(repoDir, ['diff', '--name-status', '-z', '--find-renames', '--no-color', baseSha, '--']);
  if (diffResult.code !== 0) {
    throw new Error(`git diff failed: ${diffResult.stderr.trim()}`);
  }
  const changed = parseNameStatusZ(diffResult.stdout);

  const untrackedResult = await runGit(repoDir, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedResult.code !== 0) {
    throw new Error(`git ls-files failed: ${untrackedResult.stderr.trim()}`);
  }
  const untracked = untrackedResult.stdout.split('\0').filter((p) => p.length > 0);

  const dirtyResult = await runGit(repoDir, ['diff', '--quiet', headSha], { allowNonZero: true });
  const worktreeDirty = dirtyResult.code !== 0;

  let baselineChanged: ChangedPath[] | null = null;
  let baselineNote: string | undefined;
  const parentSha = await resolveCommit(repoDir, `${baseSha}~1`);
  if (parentSha === null) {
    baselineNote = `base commit ${baseSha} has no parent; baseline comparison is unavailable for this check`;
  } else {
    const baselineResult = await runGit(repoDir, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--no-color',
      parentSha,
      baseSha,
      '--',
    ]);
    if (baselineResult.code !== 0) {
      throw new Error(`git diff (baseline) failed: ${baselineResult.stderr.trim()}`);
    }
    baselineChanged = parseNameStatusZ(baselineResult.stdout);
  }

  const patchResult = await runGit(repoDir, ['diff', '--binary', '--no-color', baseSha, '--']);
  if (patchResult.code !== 0) {
    throw new Error(`git diff (patch) failed: ${patchResult.stderr.trim()}`);
  }
  const parts: string[] = [patchResult.stdout];

  // Untracked files do not appear in `git diff <base>`; include their content
  // via --no-index against /dev/null. This is read-only: unlike `git add -N`
  // it never mutates the target repository's index.
  for (const untrackedPath of untracked) {
    const perFile = await runGit(
      repoDir,
      ['diff', '--binary', '--no-color', '--no-index', '--', '/dev/null', join(repoDir, untrackedPath)],
      { allowNonZero: true },
    );
    if (perFile.code !== 0 && perFile.code !== 1) {
      throw new Error(`git diff --no-index failed for '${untrackedPath}': ${perFile.stderr.trim()}`);
    }
    if (perFile.stdout.length > 0) {
      parts.push(`\n# untracked file: ${untrackedPath}\n${perFile.stdout}`);
    }
  }

  const patch = parts.join('');
  const patchTruncated = patch.length > MAX_PATCH_BYTES;

  const hiddenChanges = await detectHiddenChanges(repoDir, untracked);
  return {
    changed,
    untracked,
    worktreeDirty,
    baselineChanged,
    baselineNote,
    patch: patchTruncated ? patch.slice(0, MAX_PATCH_BYTES) : patch,
    patchTruncated,
    hiddenChanges,
  };
}

/**
 * Detects the hiding tricks a workspace writer can use to keep changes out
 * of `git diff`/`git status` output (1.7 review: an engine blinded the
 * checker via .git/info/exclude + skip-worktree and got needs_review with
 * zero changed files while writing outside the scope).
 */
async function detectHiddenChanges(repoDir: string, visibleUntracked: string[]): Promise<HiddenChangeFinding[]> {
  const findings: HiddenChangeFinding[] = [];

  // skip-worktree / assume-unchanged bits: git ls-files -v marks them S / h.
  const lsV = await runGit(repoDir, ['ls-files', '-v', '-z']);
  if (lsV.code === 0) {
    for (const token of lsV.stdout.split('\0')) {
      if (token.length === 0) continue;
      const code = token.slice(0, 1);
      const path = token.slice(2);
      if (code === 'S') {
        findings.push({ kind: 'skip-worktree', path, detail: 'skip-worktree bit set: modifications to this file are invisible to git diff' });
      } else if (code === 'h') {
        findings.push({ kind: 'assume-unchanged', path, detail: 'assume-unchanged bit set: modifications to this file are invisible to git status' });
      }
    }
  }

  // Untracked files hidden by ANY exclude mechanism (gitignore, global
  // excludesfile, .git/info/exclude): compare with/without excludes.
  const withoutExcludes = await runGit(repoDir, [
    'ls-files', '--others', '--exclude-standard', '-z',
    '-c', 'core.excludesFile=/dev/null',
  ]);
  if (withoutExcludes.code === 0) {
    const visible = new Set(visibleUntracked);
    const all = withoutExcludes.stdout.split('\0').filter((p) => p.length > 0);
    const hidden = all.filter((p) => !visible.has(p) && !isGitignoreSelf(p));
    for (const path of hidden.slice(0, 200)) {
      findings.push({
        kind: 'untracked-hidden-by-exclude',
        path,
        detail: 'untracked file hidden from git status by an exclude mechanism (gitignore / excludesfile / .git/info/exclude)',
      });
    }
  }

  // Nested git repositories: a directory untracked listing names as a
  // boundary (trailing '/') that git does not descend into. Verify the
  // nested .git directly on the filesystem.
  const { existsSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  for (const untrackedPath of visibleUntracked) {
    if (!untrackedPath.endsWith('/')) continue;
    if (existsSync(joinPath(repoDir, untrackedPath, '.git'))) {
      findings.push({
        kind: 'nested-git-repository',
        path: untrackedPath.slice(0, -1),
        detail: 'nested git repository: its content is invisible to the parent repository diff',
      });
    }
  }

  // Files hidden by .gitignore / excludes: `git status --ignored=matching`
  // lists them with the '!!' code. A workspace writer must not be able to
  // park secrets or out-of-scope work where the diff never reports it.
  const ignored = await runGit(repoDir, ['status', '--porcelain', '--ignored=matching', '-z']);
  if (ignored.code === 0) {
    for (const record of ignored.stdout.split('\0')) {
      if (record.length === 0) continue;
      const code = record.slice(0, 2);
      const path = record.slice(3).replace(/\n/g, '\n');
      if (!code.startsWith('!!')) continue;
      if (isGitignoreSelf(path)) continue;
      findings.push({
        kind: 'untracked-hidden-by-exclude',
        path,
        detail: 'file present in the workspace but hidden from the diff by an exclude mechanism (.gitignore / excludesfile / .git/info/exclude)',
      });
    }
  }
  return dedupeFindings(findings);
}

function isGitignoreSelf(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return base === '.gitignore' || base === '.gitmodules';
}

function dedupeFindings(findings: HiddenChangeFinding[]): HiddenChangeFinding[] {
  const seen = new Set<string>();
  const out: HiddenChangeFinding[] = [];
  for (const f of findings) {
    const key = `${f.kind}:${f.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
