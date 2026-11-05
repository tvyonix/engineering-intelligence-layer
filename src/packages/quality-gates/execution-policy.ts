import type { ResolvedPolicy } from '../contracts/policy.js';

export interface ExecutionPermission {
  permitted: boolean;
  reason: string;
}

/**
 * Host command execution policy (TL decision, 2026-11-05).
 *
 * Gate commands (typecheck, lint, tests) execute repository code through
 * package-manager scripts and tool configs. Until an approved sandbox
 * runner (Linux VM/container) exists, commands may only run inside
 * repositories explicitly vetted by the operator in `execution.vettedRepos`
 * (realpath form). Everything else fails closed with `execution_not_permitted`.
 */
export function isExecutionPermitted(policy: ResolvedPolicy, repoRealRoot: string): ExecutionPermission {
  if (policy.execution === undefined) {
    return {
      permitted: false,
      reason:
        'execution_not_permitted: no sandbox runner is approved yet and the policy grants no host execution; EIL never runs repository commands on this machine by default',
    };
  }
  if (policy.execution.vettedRepos.includes(repoRealRoot)) {
    return { permitted: true, reason: `repository ${repoRealRoot} is vetted for host execution in policy` };
  }
  return {
    permitted: false,
    reason: `execution_not_permitted: repository ${repoRealRoot} is not listed in execution.vettedRepos; add it explicitly after verification`,
  };
}

export function executionTimeoutMs(policy: ResolvedPolicy): number {
  return policy.execution?.timeoutMs ?? 120_000;
}

export function executionMaxOutputBytes(policy: ResolvedPolicy): number {
  return policy.execution?.maxOutputBytes ?? 1024 * 1024;
}
