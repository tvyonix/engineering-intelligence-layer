import { join } from 'node:path';
import type { Violation } from '../policy-engine/violations.js';
import { canonicalizeRepoRelativePath } from '../policy-engine/paths.js';
import {
  compareApiSurface,
  extractPublicApi,
  findPackageRootFor,
  packageDirToRelative,
  resolveTsEntry,
  isWithinRoot,
} from './api-surface.js';
import type { Gate, GateContext, GateOutcome } from './types.js';

export const API_COMPAT_GATE_ID = 'api-compat';

const MAX_PACKAGES = 20;

/**
 * Gate `api-compat` (opt-in via quality.required): compares the public API
 * surface of changed TS packages between the base commit and the working
 * tree. Uses the baseline snapshot provider (git archive of the base
 * commit) — read-only, no execution policy needed.
 *
 * Semantics (diff-quality spec):
 * - removed export or changed signature → fail (`public-api-breaking`);
 * - added exports → recorded, not breaking;
 * - baseline snapshot unavailable → `error`, never `pass`;
 * - package absent at baseline (new package) → `not_applicable` with an
 *   explicit reason: there is provably no prior API to break;
 * - no TS entry point / no package touched → `not_applicable`.
 */
export function apiCompatGate(): Gate {
  return {
    id: API_COMPAT_GATE_ID,
    async run(ctx: GateContext): Promise<GateOutcome> {
      if (ctx.baselineSnapshot === undefined) {
        return {
          status: 'error',
          reason: 'baseline scan unavailable: no baseline snapshot provider; API comparison without a baseline must not pass',
        };
      }

      const changedPaths = new Set<string>();
      for (const entry of [...ctx.diff.changed, ...ctx.diff.untracked.map((u) => ({ path: u, origPath: undefined }))]) {
        for (const raw of [entry.path, entry.origPath]) {
          if (raw === undefined) continue;
          const canonical = canonicalizeRepoRelativePath(raw);
          if (canonical.kind === 'valid') changedPaths.add(canonical.path);
        }
      }

      const packageDirs = new Set<string>();
      for (const changedPath of changedPaths) {
        const packageDir = findPackageRootFor(ctx.repoRealRoot, changedPath);
        if (packageDir !== null && isWithinRoot(ctx.repoRealRoot, packageDir)) {
          packageDirs.add(packageDir);
          if (packageDirs.size > MAX_PACKAGES) {
            return { status: 'error', reason: `more than ${MAX_PACKAGES} packages touched; refusing to scan, failing closed` };
          }
        }
      }
      if (packageDirs.size === 0) {
        return { status: 'not_applicable', reason: 'no changed file resolves to a package directory (package.json)' };
      }

      const snapshot = await ctx.baselineSnapshot();
      if (!snapshot.ok) {
        return {
          status: 'error',
          reason: `baseline scan unavailable: ${snapshot.reason}; API comparison without a baseline must not pass`,
        };
      }

      const violations: Violation[] = [];
      const checked: { package: string; removed: number; changed: number; added: number }[] = [];
      const newPackages: string[] = [];
      const noEntry: string[] = [];
      const surfaceReport: Record<string, unknown> = {};

      for (const packageDir of [...packageDirs].sort()) {
        const rel = packageDirToRelative(ctx.repoRealRoot, packageDir);
        const entryWorktree = resolveTsEntry(packageDir);
        if (entryWorktree === null) {
          noEntry.push(rel);
          continue;
        }
        const entryBaseline = resolveTsEntry(join(snapshot.dir, rel === '.' ? '' : rel));
        if (entryBaseline === null) {
          newPackages.push(rel);
          continue;
        }
        const currentApi = extractPublicApi(entryWorktree);
        if (!currentApi.ok) return { status: 'error', reason: `api-compat: ${rel}: ${currentApi.reason}` };
        const baselineApi = extractPublicApi(entryBaseline);
        if (!baselineApi.ok) {
          return {
            status: 'error',
            reason: `api-compat: baseline extraction failed for ${rel}: ${baselineApi.reason}; failing closed`,
          };
        }
        const change = compareApiSurface(baselineApi.records, currentApi.records);
        checked.push({ package: rel, removed: change.removed.length, changed: change.changed.length, added: change.added.length });
        surfaceReport[rel] = {
          exportsBaseline: baselineApi.records.length,
          exportsCurrent: currentApi.records.length,
          removed: change.removed.map((r) => r.name),
          changed: change.changed.map((c) => c.name),
          added: change.added.map((r) => r.name),
        };
        for (const removed of change.removed) {
          violations.push({
            rule: 'public-api-breaking',
            path: rel === '.' ? 'package.json' : `${rel}/package.json`,
            detail: `export '${removed.name}' (${removed.kind}) was removed; baseline type: ${removed.type}`,
            classification: 'new',
          });
        }
        for (const changed of change.changed) {
          violations.push({
            rule: 'public-api-breaking',
            path: rel === '.' ? 'package.json' : `${rel}/package.json`,
            detail: `export '${changed.name}' changed signature: ${changed.before} -> ${changed.after}`,
            classification: 'new',
          });
        }
      }

      if (checked.length === 0) {
        const details = [
          ...newPackages.map((p) => `new package, no baseline API to compare: ${p}`),
          ...noEntry.map((p) => `no TypeScript entry point: ${p}`),
        ];
        if (details.length > 0) {
          return { status: 'not_applicable', reason: details.join('; ') };
        }
      }

      const newViolations = violations.filter((v) => v.classification === 'new');
      const status = newViolations.length > 0 ? 'fail' : 'pass';
      const parts: string[] = [];
      if (newViolations.length > 0) {
        parts.push(`${newViolations.length} breaking change(s): ${newViolations.slice(0, 5).map((v) => v.detail.slice(0, 60)).join('; ')}${newViolations.length > 5 ? '; …' : ''}`);
      } else if (checked.length > 0) {
        parts.push(`public API compatible across ${checked.length} package(s)`);
      }
      if (newPackages.length > 0) {
        parts.push(`new package(s), no baseline API to compare: ${newPackages.join(', ')}`);
      }
      if (noEntry.length > 0) {
        parts.push(`no TS entry: ${noEntry.join(', ')}`);
      }
      const reason = parts.length > 0 ? parts.join('; ') : 'no changed file resolves to a package directory';

      return {
        status,
        reason,
        violations,
        artifacts: [{ fileName: 'api-surface.json', content: `${JSON.stringify(surfaceReport, null, 2)}\n` }],
      };
    },
  };
}
