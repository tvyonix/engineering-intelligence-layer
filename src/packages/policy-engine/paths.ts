import { lstat, realpath } from 'node:fs/promises';
import { join as pathJoin, posix } from 'node:path';

export interface InvalidPath {
  kind: 'invalid';
  path: string;
  reason: string;
}

export interface ValidPath {
  kind: 'valid';
  path: string;
}

export type PathCheckResult = ValidPath | InvalidPath;

/**
 * Canonicalizes a git-provided repo-root-relative path.
 *
 * git diff always reports paths relative to the repository root using POSIX
 * separators, so anything else is treated as an attack or a bug and rejected:
 * absolute paths, Windows drive letters, NUL bytes and `..` traversal.
 * Canonicalization collapses redundant separators and `.` segments.
 */
export function canonicalizeRepoRelativePath(raw: string): PathCheckResult {
  if (raw.length === 0) return { kind: 'invalid', path: raw, reason: 'empty path' };
  if (raw.includes('\0')) return { kind: 'invalid', path: raw, reason: 'path contains NUL byte' };
  if (raw.startsWith('/') || posix.isAbsolute(raw)) {
    return { kind: 'invalid', path: raw, reason: 'absolute paths are not valid inside a git diff' };
  }
  if (/^[A-Za-z]:/.test(raw)) {
    return { kind: 'invalid', path: raw, reason: 'windows drive-letter paths are not valid inside a git diff' };
  }
  const normalized = posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) {
    return { kind: 'invalid', path: raw, reason: 'path traverses above the repository root' };
  }
  if (normalized === '.' || normalized.length === 0) {
    return { kind: 'invalid', path: raw, reason: 'path resolves to the repository root itself' };
  }
  return { kind: 'valid', path: normalized };
}

export interface ContainmentResult {
  /** false means the path escapes the repository root or is a broken symlink. */
  contained: boolean;
  /** Absolute realpath when resolvable, null otherwise. */
  resolved: string | null;
  /** 'not-present-in-worktree' | 'symlink-escape' | 'symlink-unresolvable' | undefined */
  note?: string;
  /** True when the final path component is a symbolic link. */
  isSymlink: boolean;
}

/**
 * Verifies that a changed path physically stays inside the repository root.
 *
 * Git reports logical paths; a symlink recorded inside the repo can point
 * anywhere on the filesystem. Both the final component and intermediate
 * directory symlinks are resolved via realpath and containment is checked
 * against the realpathed repository root.
 *
 * Missing worktree files (e.g. deletions) cannot escape and are not followed.
 * Broken symlinks are reported as unresolvable: the change cannot be verified
 * to stay inside the root, so it fails closed.
 */
export async function checkPathContainedInRoot(rootRealPath: string, relativePath: string): Promise<ContainmentResult> {
  const absolute = pathJoin(rootRealPath, relativePath);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    return { contained: true, resolved: null, note: 'not-present-in-worktree', isSymlink: false };
  }
  const isSymlink = stats.isSymbolicLink();
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    return { contained: false, resolved: null, note: 'symlink-unresolvable', isSymlink };
  }
  const contained = resolved === rootRealPath || resolved.startsWith(`${rootRealPath}/`);
  if (!contained) {
    return { contained: false, resolved, note: 'symlink-escape', isSymlink };
  }
  return { contained: true, resolved, isSymlink };
}
