import type { Violation } from '../policy-engine/violations.js';
import { canonicalizeRepoRelativePath } from '../policy-engine/paths.js';
import type { Gate, GateContext, GateOutcome } from './types.js';

export const DEPENDENCY_POLICY_GATE_ID = 'dependency-policy';

/**
 * Package manifests and lockfiles whose change affects dependencies. Basename
 * matching covers monorepo layouts (`packages/app/package.json`).
 */
const MANIFEST_BASENAMES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'deno.lock',
];

function isManifestPath(canonicalPath: string): boolean {
  const base = canonicalPath.split('/').pop() ?? '';
  return MANIFEST_BASENAMES.includes(base);
}

/**
 * Gate `dependency-policy`: inspects manifest/lockfile paths in the diff
 * (design.md gate order step 2). With `noNewDependencies: true` any manifest
 * or lockfile change fails the gate: dependency changes require explicit
 * approval, and the approval workflow ships in Phase 1 (task 1.3) — until
 * then check mode fails closed instead of inventing approval state.
 *
 * `not_applicable` is returned only when the diff provably touches no
 * manifest or lockfile.
 */
export function dependencyPolicyGate(): Gate {
  return {
    id: DEPENDENCY_POLICY_GATE_ID,
    async run(ctx: GateContext): Promise<GateOutcome> {
      const seen = new Set<string>();
      const touchedManifests: string[] = [];
      for (const entry of [...ctx.diff.changed, ...ctx.diff.untracked.map((u) => ({ path: u, origPath: undefined }))]) {
        for (const raw of [entry.path, entry.origPath]) {
          if (raw === undefined) continue;
          const canonical = canonicalizeRepoRelativePath(raw);
          if (canonical.kind === 'invalid') continue;
          if (seen.has(canonical.path)) continue;
          seen.add(canonical.path);
          if (isManifestPath(canonical.path)) {
            touchedManifests.push(canonical.path);
          }
        }
      }

      if (touchedManifests.length === 0) {
        return {
          status: 'not_applicable',
          reason: 'the diff touches no package manifest or lockfile',
        };
      }

      const artifacts = [
        { fileName: 'dependency-policy.json', content: `${JSON.stringify({ touchedManifests }, null, 2)}\n` },
      ];

      if (ctx.contract.policy.noNewDependencies) {
        // Operator approval lives in the policy file (dependencies.approvedFiles):
        // editing that file IS the approval event, and repository content can
        // never grant itself approval (TL decision, 2026-11-05).
        const approved = ctx.policy.dependencies?.approvedFiles ?? [];
        const unapproved = touchedManifests.filter((p) => !approved.includes(p));
        const approvedTouched = touchedManifests.filter((p) => approved.includes(p));
        if (unapproved.length === 0) {
          return {
            status: 'pass',
            reason: `manifest/lockfile changed (${touchedManifests.join(', ')}); covered by operator approval in policy dependencies.approvedFiles`,
            artifacts,
          };
        }
        const violations: Violation[] = unapproved.map((path) => ({
          rule: 'dependency-manifest-changed',
          path,
          detail:
            'contract policy sets noNewDependencies=true and the policy file does not approve this path in dependencies.approvedFiles; a new dependency requires an explicit operator approval record',
          classification: 'new',
        }));
        const note = approvedTouched.length > 0 ? `; approved: ${approvedTouched.join(', ')}` : '';
        return {
          status: 'fail',
          reason: `manifest/lockfile changed without approval under noNewDependencies=true: ${unapproved.join(', ')}${note}`,
          violations,
          artifacts,
        };
      }

      return {
        status: 'pass',
        reason: `manifest/lockfile changed (${touchedManifests.join(', ')}); the contract policy permits dependency changes`,
        artifacts,
      };
    },
  };
}
