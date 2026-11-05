export type ViolationClassification = 'new' | 'inherited' | 'baseline_context';

export interface Violation {
  /** Stable machine identifier, e.g. 'protected-path', 'outside-allow', 'symlink-escape'. */
  rule: string;
  /** Repo-root-relative POSIX path the violation refers to (may be the raw path when it cannot be canonicalized). */
  path: string;
  /** Human-readable evidence for review; never a replacement for the structured fields. */
  detail: string;
  classification: ViolationClassification;
}

/**
 * Stable fingerprint used for baseline comparison. Two violations with the
 * same fingerprint in the current diff and the baseline snapshot are treated
 * as the same defect ("inherited"), per diff-quality spec: "Existing defects".
 */
export function violationFingerprint(v: Pick<Violation, 'rule' | 'path' | 'detail'>): string {
  return `${v.rule}::${v.path}::${v.detail}`;
}

export interface ViolationClassificationResult {
  newViolations: Violation[];
  inherited: Violation[];
}

/**
 * Splits current violations into new and inherited by comparing fingerprints
 * against a baseline snapshot. This is the generic mechanism behind task 0.5;
 * content gates (lint/tsc in Phase 1) supply their own baseline scans.
 *
 * Scope violations are attributed differently: a path modified relative to
 * the base commit is, by git semantics, changed *by this change*, so the
 * path-scope gate classifies its own violations as `new` and reports
 * baseline touches of protected paths separately as `baseline_context`
 * (evidence, not forgiveness).
 */
export function classifyViolations(current: Violation[], baseline: Violation[]): ViolationClassificationResult {
  const baselinePrints = new Set(baseline.map(violationFingerprint));
  const newViolations: Violation[] = [];
  const inherited: Violation[] = [];
  for (const violation of current) {
    if (baselinePrints.has(violationFingerprint(violation))) {
      // Rewritten, not mutated: callers may hold the original violation.
      inherited.push({ ...violation, classification: 'inherited' });
    } else {
      newViolations.push({ ...violation, classification: 'new' });
    }
  }
  return { newViolations, inherited };
}
