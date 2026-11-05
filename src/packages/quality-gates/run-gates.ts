import { API_COMPAT_GATE_ID, apiCompatGate } from './api-compat-gate.js';
import { DS_CONFORMANCE_GATE_ID, dsConformanceGate } from './ds-conformance-gate.js';
import { DEPENDENCY_POLICY_GATE_ID, dependencyPolicyGate } from './dependency-policy-gate.js';
import { contentGate } from './content-gate.js';
import { parseEslintJsonOutput, parseTscOutput } from './diagnostics.js';
import { IMPORT_BOUNDARIES_GATE_ID, importBoundariesGate } from './import-boundaries-gate.js';
import { PATH_SCOPE_GATE_ID, pathScopeGate } from './path-scope-gate.js';
import { SECRETS_SCAN_GATE_ID, secretsScanGate } from './secrets-scan-gate.js';
import { TESTS_GATE_ID, testsGate } from './tests-gate.js';
import type { Gate, GateContext, GateResult } from './types.js';
import type { Violation } from '../policy-engine/violations.js';

export interface RunGatesOutput {
  results: GateResult[];
  /** All violations produced by gates, in gate order (task 0.5: new vs inherited is per-violation). */
  violations: Violation[];
  /** Baseline context entries (protected paths already touched by the base commit). */
  baselineContext: Violation[];
}

export const KNOWN_GATE_IDS: readonly string[] = [
  PATH_SCOPE_GATE_ID,
  DEPENDENCY_POLICY_GATE_ID,
  'types',
  'lint',
  TESTS_GATE_ID,
  IMPORT_BOUNDARIES_GATE_ID,
  API_COMPAT_GATE_ID,
  DS_CONFORMANCE_GATE_ID,
  SECRETS_SCAN_GATE_ID,
] as const;

export function buildGateRegistry(): Gate[] {
  return [
    pathScopeGate(),
    dependencyPolicyGate(),
    contentGate({
      id: 'types',
      defaultCommand: 'npx --no-install tsc --noEmit --pretty false',
      parseOutput: (output) => parseTscOutput(output),
    }),
    contentGate({
      id: 'lint',
      defaultCommand: 'npx --no-install eslint . --format json',
      parseOutput: (output, scanRoot) => parseEslintJsonOutput(output, scanRoot),
    }),
    testsGate(),
    importBoundariesGate(),
    apiCompatGate(),
    dsConformanceGate(),
    secretsScanGate(),
  ];
}

/**
 * Synthetic integrity result injected when the saved patch had to be
 * truncated: the evidence bundle no longer contains the full diff, so the
 * check cannot claim completeness. TL decision, 2026-11-05: "Если система
 * не смогла проверить весь diff, результат должен быть error, а не pass".
 */
function patchIntegrityResult(ctx: GateContext): GateResult | null {
  if (!ctx.diff.patchTruncated) return null;
  return {
    id: 'diff-patch-integrity',
    status: 'error',
    mandatory: true,
    durationMs: 0,
    reason:
      'patch_truncated: the saved diff exceeded the 16 MiB evidence cap; the full diff could not be captured for review, so the check is incomplete — failing closed',
  };
}

/**
 * Selects gates to run: every gate the policy requires, plus opt-in gates
 * activated by policy sections (ds-conformance when a `ds` section exists,
 * import-boundaries when a `boundaries` section exists) even if not listed
 * in quality.required. Unknown required gate ids are handled by runGates,
 * which synthesizes an error result for them.
 */
export function selectGates(registry: Gate[], ctx: Pick<GateContext, 'policy'>): Gate[] {
  const required = new Set(ctx.policy.quality.required);
  return registry.filter(
    (gate) =>
      required.has(gate.id) ||
      (gate.id === DS_CONFORMANCE_GATE_ID && ctx.policy.ds !== undefined) ||
      (gate.id === IMPORT_BOUNDARIES_GATE_ID && ctx.policy.boundaries !== undefined),
  );
}

function isMandatory(ctx: GateContext, gateId: string): boolean {
  return ctx.policy.quality.required.includes(gateId);
}

/**
 * Runs selected gates sequentially. Guarantees:
 * - a gate that throws yields an `error` result, never a silent skip;
 * - every required gate id appears exactly once in the results; a gate that
 *   produced no result (or an unknown id) is synthesized as `error`
 *   ("отсутствие результатов не возвращает success", tasks.md 0.6);
 * - unknown required ids are reported as errors so a policy typo cannot
 *   silently drop a gate.
 */
export async function runGates(gates: Gate[], ctx: GateContext): Promise<RunGatesOutput> {
  const results: GateResult[] = [];
  const violations: Violation[] = [];
  const baselineContext: Violation[] = [];
  for (const gate of gates) {
    const startedAt = Date.now();
    const mandatory = isMandatory(ctx, gate.id);
    try {
      const outcome = await gate.run(ctx);
      const result: GateResult = {
        id: gate.id,
        status: outcome.status,
        mandatory,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
      if (outcome.reason !== undefined) result.reason = outcome.reason;
      if (outcome.artifacts !== undefined && outcome.artifacts.length > 0) {
        for (const artifact of outcome.artifacts) {
          const evidencePath = await ctx.evidence.write(gate.id, artifact.fileName, artifact.content);
          result.evidencePath = evidencePath;
        }
      }
      if (outcome.violations !== undefined) violations.push(...outcome.violations);
      if (outcome.baselineContext !== undefined) baselineContext.push(...outcome.baselineContext);
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: gate.id,
        status: 'error',
        mandatory,
        durationMs: Math.max(0, Date.now() - startedAt),
        reason: `gate_threw: ${message}`,
      });
    }
  }

  const covered = new Set(results.map((r) => r.id));
  const integrity = patchIntegrityResult(ctx);
  if (integrity !== null && !covered.has(integrity.id)) {
    results.push(integrity);
    covered.add(integrity.id);
  }
  for (const requiredId of ctx.policy.quality.required) {
    if (!covered.has(requiredId)) {
      const known = KNOWN_GATE_IDS.includes(requiredId);
      results.push({
        id: requiredId,
        status: 'error',
        mandatory: true,
        durationMs: 0,
        reason: known
          ? `missing_result: required gate '${requiredId}' was not selected or produced no result; absence is never success`
          : `unknown_gate: policy requires '${requiredId}' which is not a known EIL gate; cannot verify it, failing closed`,
      });
    }
  }
  return { results, violations, baselineContext };
}

export type CheckVerdict = 'blocked' | 'error' | 'needs_review';

export interface VerdictResult {
  verdict: CheckVerdict;
  exitCode: 0 | 1 | 2;
}

/**
 * Verdict aggregation (diff-quality spec):
 * - any mandatory `fail` → blocked, exit 1: the change cannot be accepted
 *   regardless of any LLM opinion;
 * - otherwise any mandatory `error` (or synthesized missing result) → error,
 *   exit 2: the check itself is incomplete, which also prohibits acceptance;
 * - otherwise → needs_review, exit 0: gates passed, but in check mode no
 *   human acceptance exists, so the task is never `accepted` (task-contract
 *   spec: "Tests green but not reviewed").
 */
export function computeVerdict(results: GateResult[]): VerdictResult {
  const mandatory = results.filter((r) => r.mandatory);
  if (mandatory.some((r) => r.status === 'fail')) {
    return { verdict: 'blocked', exitCode: 1 };
  }
  if (mandatory.some((r) => r.status === 'error')) {
    return { verdict: 'error', exitCode: 2 };
  }
  return { verdict: 'needs_review', exitCode: 0 };
}
