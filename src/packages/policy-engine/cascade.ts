import type { TaskRisk } from './risk.js';

/**
 * Tasks 4.2–4.3: deterministic cascade policy (design.md §6) — pure rules,
 * no ML, no model involvement. The planner decides the NEXT attempt from
 * the task risk and the attempt history:
 *
 * - low/medium → cheap tier first, bounded retries (cheap-first);
 * - high → strong tier immediately if configured, otherwise needs_review —
 *   a high-risk task never starts on the cheap tier;
 * - escalation requires a REPRODUCIBLE failure signal (the same failure
 *   signature in ≥2 attempts) or an exhausted cheap-retry budget;
 * - blocked → reject;
 * - every attempt starts on a FRESH workspace (task 4.3: clean state, no
 *   uncontrolled carry-over) and cost history stays per-attempt in the
 *   ledger (task 4.4 artifacts: captureFailedAttempt).
 *
 * Escalation/execution itself is performed by the engine layer (Phase 3);
 * this planner is the policy that layer must obey.
 */

export type AttemptTier = 'cheap' | 'strong';

export interface AttemptRecord {
  id: string;
  tier: AttemptTier;
  status: 'complete' | 'failed' | 'aborted' | 'pending';
  /** Deterministic failure identifiers, e.g. 'gate:tests:fail', 'command:timeout', 'engine:provider-unavailable'. */
  failureSignatures: string[];
}

export type CascadeAction = 'start-cheap' | 'retry-cheap' | 'escalate-strong' | 'needs-review' | 'reject-blocked';

export interface CascadePlan {
  action: CascadeAction;
  tier: AttemptTier | null;
  reason: string;
  /** Always true: a cascade switch or retry must never reuse a dirty workspace. */
  freshWorkspace: true;
}

export interface CascadePolicyInput {
  risk: TaskRisk;
  attempts: readonly AttemptRecord[];
  /** Contract policy.maxAttempts — the total budget for the task. */
  maxAttempts: number;
  /** Routing policy maxCheapRetries — cheap-tier retry budget before escalation. */
  maxCheapRetries: number;
  /** Whether a strong tier is configured (routing.models.strong != null). */
  strongTierConfigured: boolean;
}

const BLOCKED_HINTS: readonly string[] = ['protected-path', 'known-secret', 'destructive-command'];

export function planNextAttempt(input: CascadePolicyInput): CascadePlan {
  const { risk, attempts, maxAttempts, maxCheapRetries, strongTierConfigured } = input;
  const failures = attempts.filter((a) => a.status === 'failed' || a.status === 'aborted');
  const cheapFailures = failures.filter((a) => a.tier === 'cheap');

  // Blocked: no execution at all.
  if (risk === 'blocked') {
    return {
      action: 'reject-blocked',
      tier: null,
      reason: 'risk is blocked (e.g. protected paths touched); no attempt is started',
      freshWorkspace: true,
    };
  }

  // Total budget exhausted → human, not a fabricated success.
  if (attempts.length >= maxAttempts) {
    return {
      action: 'needs-review',
      tier: null,
      reason: `attempt budget exhausted (${attempts.length}/${maxAttempts}); outcome needs human review`,
      freshWorkspace: true,
    };
  }

  // High risk: strong tier immediately, never cheap-first.
  if (risk === 'high') {
    if (strongTierConfigured) {
      return {
        action: 'escalate-strong',
        tier: 'strong',
        reason: 'high-risk task goes straight to the strong tier (no cheap-first for high risk)',
        freshWorkspace: true,
      };
    }
    return {
      action: 'needs-review',
      tier: null,
      reason: 'high-risk task without a configured strong tier → needs_review (lack of strong tier never fabricates success)',
      freshWorkspace: true,
    };
  }

  // Low/medium: cheap-first.
  if (attempts.length === 0) {
    return { action: 'start-cheap', tier: 'cheap', reason: 'low/medium risk with no attempts: cheap tier first', freshWorkspace: true };
  }

  if (attempts.every((a) => a.status === 'complete')) {
    return {
      action: 'needs-review',
      tier: null,
      reason: 'last attempt completed; acceptance is a human event (tests passing ≠ accepted)',
      freshWorkspace: true,
    };
  }

  // Reproducible failure: the same signature in ≥2 attempts.
  const signatureCounts = new Map<string, number>();
  for (const failure of failures) {
    for (const signature of failure.failureSignatures) {
      if (BLOCKED_HINTS.some((hint) => signature.includes(hint))) {
        return {
          action: 'needs-review',
          tier: null,
          reason: `blocking failure signal '${signature}' — no retries can lift it`,
          freshWorkspace: true,
        };
      }
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
    }
  }
  const reproducible = [...signatureCounts.entries()].some(([, count]) => count >= 2);

  // maxCheapRetries counts RETRIES after the first cheap attempt: a budget
  // of 1 allows the initial attempt plus one retry (2 cheap attempts).
  if (cheapFailures.length > maxCheapRetries) {
    if (strongTierConfigured) {
      return {
        action: 'escalate-strong',
        tier: 'strong',
        reason: `cheap retry budget exhausted (${cheapFailures.length}/${maxCheapRetries}) → strong tier`,
        freshWorkspace: true,
      };
    }
    return {
      action: 'needs-review',
      tier: null,
      reason: `cheap retry budget exhausted (${cheapFailures.length}/${maxCheapRetries}) and no strong tier configured → needs_review`,
      freshWorkspace: true,
    };
  }

  if (reproducible && cheapFailures.length >= 1) {
    if (strongTierConfigured) {
      return {
        action: 'escalate-strong',
        tier: 'strong',
        reason: `reproducible failure after a cheap attempt (${[...signatureCounts.entries()].filter(([, c]) => c >= 2).map(([s]) => s).join(', ')}) → strong tier`,
        freshWorkspace: true,
      };
    }
    return {
      action: 'retry-cheap',
      tier: 'cheap',
      reason: 'reproducible failure but no strong tier configured; bounded cheap retries continue (deterministic feedback may still help)',
      freshWorkspace: true,
    };
  }

  return {
    action: 'retry-cheap',
    tier: 'cheap',
    reason: `cheap attempt failed without a reproducible signature yet (${cheapFailures.length}/${maxCheapRetries} retries used); retry on a fresh workspace`,
    freshWorkspace: true,
  };
}
