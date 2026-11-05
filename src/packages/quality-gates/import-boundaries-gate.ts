import picomatch from 'picomatch';
import type { Violation } from '../policy-engine/violations.js';
import { canonicalizeRepoRelativePath } from '../policy-engine/paths.js';
import { buildImportGraph, cycleFingerprint, findCycles, GraphLimitExceededError } from './import-graph.js';
import type { Gate, GateContext, GateOutcome } from './types.js';

export const IMPORT_BOUNDARIES_GATE_ID = 'import-boundaries';

/**
 * Gate `import-boundaries` (opt-in via policy.boundaries):
 * - `forbiddenImports`: a changed file matching `from` must not import
 *   targets matching `disallow` (repo-relative picomatch patterns);
 * - `forbidNewCycles`: import cycles that did not exist at the base commit
 *   fail the gate ("запрет новых циклов"); pre-existing cycles are recorded
 *   as inherited.
 *
 * This gate only reads source files — it never executes repository content,
 * so it is not subject to the host-execution permission policy.
 *
 * Limitations (documented): regex-based relative-import extraction, no
 * tsconfig path aliases, no barrel re-export expansion. ts-morph-based
 * analysis arrives with the context tools in Phase 2.
 */
export function importBoundariesGate(): Gate {
  return {
    id: IMPORT_BOUNDARIES_GATE_ID,
    async run(ctx: GateContext): Promise<GateOutcome> {
      const boundaries = ctx.policy.boundaries;
      if (boundaries === undefined) {
        return { status: 'not_applicable', reason: 'opt-in gate: no boundaries policy configured' };
      }

      const changedPaths = new Set<string>();
      for (const entry of [...ctx.diff.changed, ...ctx.diff.untracked.map((u) => ({ path: u, origPath: undefined }))]) {
        for (const raw of [entry.path, entry.origPath]) {
          if (raw === undefined) continue;
          const canonical = canonicalizeRepoRelativePath(raw);
          if (canonical.kind === 'valid') changedPaths.add(canonical.path);
        }
      }

      const violations: Violation[] = [];

      // 1. Forbidden imports for changed files.
      if (boundaries.forbiddenImports !== undefined) {
        for (const rule of boundaries.forbiddenImports) {
          const fromMatcher = (p: string) => picomatch.isMatch(p, rule.from, { dot: true });
          const disallowMatcher = (p: string) => picomatch.isMatch(p, rule.disallow, { dot: true });
          let graph;
          try {
            graph = await buildImportGraph(ctx.repoDir);
          } catch (error) {
            if (error instanceof GraphLimitExceededError) {
              return { status: 'error', reason: `import graph scan failed: ${error.message}; failing closed` };
            }
            throw error;
          }
          const edgesFromChanged = graph.edges.filter((e) => changedPaths.has(e.from) && fromMatcher(e.from));
          for (const edge of edgesFromChanged) {
            if (disallowMatcher(edge.to)) {
              violations.push({
                rule: 'forbidden-import',
                path: edge.from,
                detail: `forbidden dependency: '${edge.from}' imports '${edge.to}' which matches disallow [${rule.disallow.join(', ')}]`,
                classification: 'new',
              });
            }
          }
        }
      }

      // 2. New import cycles.
      if (boundaries.forbidNewCycles === true) {
        let currentCycles: string[][];
        try {
          const graph = await buildImportGraph(ctx.repoDir);
          currentCycles = findCycles(graph.edges);
        } catch (error) {
          if (error instanceof GraphLimitExceededError) {
            return { status: 'error', reason: `import graph scan failed: ${error.message}; failing closed` };
          }
          throw error;
        }
        if (ctx.baselineSnapshot === undefined) {
          return {
            status: 'error',
            reason: 'baseline scan unavailable: no baseline snapshot provider; cannot prove a cycle is new — failing closed',
          };
        }
        const snapshot = await ctx.baselineSnapshot();
        if (!snapshot.ok) {
          return {
            status: 'error',
            reason: `baseline scan unavailable: ${snapshot.reason}; cannot prove a cycle is new — failing closed`,
          };
        }
        let baselineCycles: string[][];
        try {
          const baselineGraph = await buildImportGraph(snapshot.dir);
          baselineCycles = findCycles(baselineGraph.edges);
        } catch (error) {
          if (error instanceof GraphLimitExceededError) {
            return { status: 'error', reason: `baseline import graph scan failed: ${error.message}; failing closed` };
          }
          throw error;
        }
        const baselinePrints = new Set(baselineCycles.map(cycleFingerprint));
        for (const cycle of currentCycles) {
          const fingerprint = cycleFingerprint(cycle);
          if (!baselinePrints.has(fingerprint)) {
            violations.push({
              rule: 'new-import-cycle',
              path: cycle[0] ?? '',
              detail: `new import cycle: ${cycle.join(' -> ')} -> ${cycle[0] ?? ''} (not present in base commit ${ctx.baseCommit.slice(0, 12)})`,
              classification: 'new',
            });
          } else {
            violations.push({
              rule: 'import-cycle-inherited',
              path: cycle[0] ?? '',
              detail: `pre-existing import cycle (also present in base commit): ${cycle.join(' -> ')}`,
              classification: 'inherited',
            });
          }
        }
      }

      const newViolations = violations.filter((v) => v.classification === 'new');
      const status = newViolations.length > 0 ? 'fail' : 'pass';
      const reason =
        violations.length === 0
          ? 'no forbidden imports and no new import cycles among changed files'
          : `${newViolations.length} new boundary violation(s), ${violations.length - newViolations.length} inherited; ${violations
              .slice(0, 5)
              .map((v) => `${v.rule}@${v.path}`)
              .join('; ')}`;
      const artifacts = [
        {
          fileName: 'import-boundaries.json',
          content: `${JSON.stringify({ violations }, null, 2)}\n`,
        },
      ];
      return { status, reason, violations, artifacts };
    },
  };
}
