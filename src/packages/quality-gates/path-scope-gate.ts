import type { Violation } from '../policy-engine/violations.js';
import { checkPathContainedInRoot, canonicalizeRepoRelativePath } from '../policy-engine/paths.js';
import { createScopeMatcher, matchScope } from '../policy-engine/scope.js';
import type { Gate, GateContext, GateOutcome } from './types.js';

export const PATH_SCOPE_GATE_ID = 'path-scope';

interface PathEntry {
  path: string;
  origPath?: string;
  source: 'diff' | 'untracked';
  status: string;
}

/**
 * Gate `path-scope` (mandatory): every path in the change must
 * - canonicalize cleanly (no absolute/traversal/NUL paths),
 * - fall inside the contract allow scope,
 * - not touch protected patterns (protection beats allow),
 * - physically stay inside the repository root (symlink resolution, task 0.3).
 *
 * Violations of the current change are classified `new` by definition: the
 * diff base..worktree only contains changes made relative to the base commit.
 * Protected paths already touched by the base commit are reported separately
 * as `baseline_context` (task 0.5) — attribution evidence for review, never a
 * pass condition.
 */
export function pathScopeGate(): Gate {
  return {
    id: PATH_SCOPE_GATE_ID,
    async run(ctx: GateContext): Promise<GateOutcome> {
      const matcher = createScopeMatcher(ctx.contract.scope.allow, ctx.contract.scope.protect);
      const entries: PathEntry[] = [
        ...ctx.diff.changed.map((c) => ({ path: c.path, origPath: c.origPath, source: c.source, status: c.status })),
        ...ctx.diff.untracked.map((u) => ({ path: u, source: 'untracked' as const, status: 'A' })),
      ];

      const violations: Violation[] = [];
      const checked = new Set<string>();
      for (const entry of entries) {
        for (const raw of [entry.path, entry.origPath]) {
          if (raw === undefined || checked.has(raw)) continue;
          checked.add(raw);
          const canonical = canonicalizeRepoRelativePath(raw);
          if (canonical.kind === 'invalid') {
            violations.push({
              rule: 'path-format',
              path: raw,
              detail: `path cannot be canonicalized: ${canonical.reason}`,
              classification: 'new',
            });
            continue;
          }
          const scope = matchScope(matcher, canonical.path);
          if (scope.protected) {
            violations.push({
              rule: 'protected-path',
              path: canonical.path,
              detail: `matches protected pattern(s): ${scope.matchedProtect.join(', ')}${
                scope.allowed ? '; also matched allow pattern(s) — protection takes precedence' : ''
              }`,
              classification: 'new',
            });
          } else if (!scope.allowed) {
            violations.push({
              rule: 'outside-allow',
              path: canonical.path,
              detail: `outside allow scope [${ctx.contract.scope.allow.join(', ')}]`,
              classification: 'new',
            });
          }
          const containment = await checkPathContainedInRoot(ctx.repoRealRoot, canonical.path);
          if (!containment.contained) {
            violations.push({
              rule: containment.note === 'symlink-unresolvable' ? 'symlink-unresolvable' : 'symlink-escape',
              path: canonical.path,
              detail:
                containment.note === 'symlink-unresolvable'
                  ? 'symlink cannot be resolved (broken link); containment cannot be verified, failing closed'
                  : `symlink resolves to ${containment.resolved ?? '<unknown>'} outside the repository root`,
              classification: 'new',
            });
          }
        }
      }

      const baselineContext: Violation[] = [];
      if (ctx.diff.baselineChanged !== null) {
        const seen = new Set<string>();
        for (const baselineEntry of ctx.diff.baselineChanged) {
          for (const raw of [baselineEntry.path, baselineEntry.origPath]) {
            if (raw === undefined) continue;
            const canonical = canonicalizeRepoRelativePath(raw);
            if (canonical.kind === 'invalid') continue;
            if (seen.has(canonical.path)) continue;
            seen.add(canonical.path);
            const scope = matchScope(matcher, canonical.path);
            if (scope.protected) {
              baselineContext.push({
                rule: 'protected-path-in-baseline',
                path: canonical.path,
                detail: `base commit ${ctx.baseCommit.slice(0, 12)} already modifies this protected path`,
                classification: 'baseline_context',
              });
            }
          }
        }
      }

      // 1.7 hardening: changes HIDDEN from the diff (skip-worktree,
      // exclude-hidden untracked, nested repos) are integrity violations
      // regardless of scope — an honest diff cannot contain what git
      // refuses to report.
      const ignoreHidden = ctx.policy.workspaceIntegrity?.ignoreHidden ?? [];
      let hiddenMatcher: ((p: string) => boolean) | null = null;
      if (ignoreHidden.length > 0) {
        const picomatch = (await import('picomatch')).default;
        hiddenMatcher = (p: string) => picomatch.isMatch(p, ignoreHidden, { dot: true });
      }
      for (const hidden of ctx.diff.hiddenChanges) {
        if (hiddenMatcher !== null && hidden.kind === 'untracked-hidden-by-exclude' && hiddenMatcher(hidden.path)) {
          continue; // operator-declared intentional build artifact
        }
        violations.push({
          rule: `hidden-change:${hidden.kind}`,
          path: hidden.path,
          detail: hidden.detail,
          classification: 'new',
        });
      }

      const status = violations.length > 0 ? 'fail' : 'pass';
      const reason =
        violations.length > 0
          ? `${violations.length} scope violation(s): ${violations
              .slice(0, 10)
              .map((v) => `${v.rule}:${v.path}`)
              .join('; ')}${violations.length > 10 ? '; …' : ''}`
          : baselineContext.length > 0
            ? `all changed paths within scope; ${baselineContext.length} protected path(s) already touched by the base commit (see baseline_context)`
            : 'all changed paths are within the allow scope and touch no protected path';

      const artifacts = [
        {
          fileName: 'path-scope.json',
          content: `${JSON.stringify({ violations, baselineContext }, null, 2)}\n`,
        },
      ];

      return { status, reason, violations, baselineContext, artifacts };
    },
  };
}
