import picomatch from 'picomatch';

/**
 * Git internals are protected unconditionally. Policy cannot widen what
 * `.git` matches; it may only add more protected patterns.
 */
export const ALWAYS_PROTECTED: readonly string[] = ['.git/**'] as const;

export interface ScopeMatcher {
  allow: readonly string[];
  protect: readonly string[];
}

export interface ScopeMatch {
  /** The path matches at least one protect pattern (protection takes precedence over allow). */
  protected: boolean;
  /** The path matches at least one allow pattern. */
  allowed: boolean;
  matchedProtect: string[];
  matchedAllow: string[];
}

export function createScopeMatcher(allow: readonly string[], protect: readonly string[]): ScopeMatcher {
  return { allow, protect };
}

function matchAny(path: string, patterns: readonly string[]): string[] {
  const matched: string[] = [];
  for (const pattern of patterns) {
    if (picomatch.isMatch(path, pattern, { dot: true })) {
      matched.push(pattern);
    }
  }
  return matched;
}

/**
 * Scope decision for a single canonical repo-relative path:
 * - protected wins over allow (a path in both is a protected-path violation);
 * - a path outside allow is an outside-allow violation;
 * - `.git` internals are always protected.
 */
export function matchScope(matcher: ScopeMatcher, canonicalPath: string): ScopeMatch {
  const matchedProtect = matchAny(canonicalPath, [...matcher.protect, ...ALWAYS_PROTECTED]);
  const matchedAllow = matchAny(canonicalPath, matcher.allow);
  return {
    protected: matchedProtect.length > 0,
    allowed: matchedAllow.length > 0,
    matchedProtect,
    matchedAllow,
  };
}
