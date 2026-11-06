import picomatch from 'picomatch';
import type { Violation } from './violations.js';

export type TaskRisk = 'low' | 'medium' | 'high' | 'blocked';

export interface RiskAssessment {
  risk: TaskRisk;
  /** Deterministic evidence for the classification, for review and the ledger. */
  reasons: string[];
}

/**
 * High-risk path patterns (design.md §5): privileged CI, authn/authz,
 * cryptography, secret handling, DB migrations, release tooling.
 * Repo-relative POSIX, matched case-insensitively on path segments.
 */
const HIGH_RISK_PATH_PATTERNS: readonly string[] = [
  '.github/workflows/**',
  '.gitlab-ci*',
  'dockerfile*',
  'jenkinsfile*',
  '**/auth/**',
  '**/authz/**',
  '**/crypto/**',
  '**/secret*/**',
  '**/migrations/**',
  '**/migration/**',
  '**/release/**',
];

const HIGH_RISK_FILENAME_RE =
  /(^|\/)(auth|authz|crypto|secret|secrets|credential|credentials|password|token|session|jwt|oauth|signing)([\w.-]*)(\.[a-z]+)?$|(\.pem|\.p12|\.keystore)$/i;

const HIGH_RISK_HINTS: readonly string[] = [
  'security',
  'auth',
  'authz',
  'crypto',
  'secret',
  'credential',
  'session',
  'release',
  'migration',
  'permissions',
  'high',
];

/**
 * Task 4.1: deterministic risk classification (design.md §5) — pure rules,
 * no ML, no model involvement. Properties:
 * - monotonic: the assessment starts at 'low' and only elevates; nothing in
 *   the input (including any model output) can lower a risk level;
 * - 'blocked' is terminal: protected paths touched without approval;
 * - every elevation carries a reason string for the evidence bundle.
 */
export function classifyTaskRisk(input: {
  changedPaths: readonly string[];
  violations: readonly Violation[];
  riskHints?: readonly string[];
}): RiskAssessment {
  const reasons: string[] = [];
  let risk: TaskRisk = 'low';
  const elevate = (level: TaskRisk, reason: string): void => {
    if (level === 'blocked' || (level === 'high' && risk !== 'blocked') || (level === 'medium' && risk === 'low')) {
      risk = level;
    }
    reasons.push(reason);
  };

  // 1. Scope violations from the gates.
  for (const violation of input.violations) {
    if (violation.rule === 'protected-path') {
      elevate('blocked', `protected path touched: ${violation.path}`);
    } else if (violation.rule === 'known-secret') {
      elevate('blocked', `potential secret in the diff: ${violation.path} (design.md §5: known secrets exfiltration is blocked)`);
    } else if (violation.rule === 'symlink-escape' || violation.rule === 'symlink-unresolvable' || violation.rule === 'path-format') {
      elevate('high', `${violation.rule}: ${violation.path} — suspicious path shape, containment could not be proven`);
    } else if (violation.rule === 'dependency-manifest-changed') {
      elevate('high', `dependency change without approval: ${violation.path}`);
    }
  }

  // 2. High-risk path patterns.
  for (const changedPath of input.changedPaths) {
    const lowered = changedPath.toLowerCase();
    for (const pattern of HIGH_RISK_PATH_PATTERNS) {
      if (picomatchMatch(lowered, pattern.toLowerCase())) {
        elevate('high', `high-risk area: ${changedPath} matches ${pattern}`);
        break;
      }
    }
    const base = lowered.split('/').pop() ?? lowered;
    if (HIGH_RISK_FILENAME_RE.test(lowered) || HIGH_RISK_FILENAME_RE.test(base)) {
      elevate('high', `high-risk filename: ${changedPath}`);
    }
  }

  // 3. Breaking public API changes detected by the api-compat gate.
  const breaking = input.violations.filter((v) => v.rule === 'public-api-breaking');
  if (breaking.length > 0) {
    elevate('high', `public API breaking change(s): ${breaking.length}`);
  }

  // 4. Cross-module change: more than one top-level directory.
  const topDirs = new Set(input.changedPaths.map((p) => p.split('/')[0]));
  if (topDirs.size > 1) {
    elevate('medium', `change spans ${topDirs.size} top-level directories (${[...topDirs].sort().join(', ')})`);
  }

  // 5. Operator risk hints: hints may only elevate (monotonicity).
  for (const hint of input.riskHints ?? []) {
    const lowered = hint.toLowerCase();
    if (HIGH_RISK_HINTS.some((h) => lowered.includes(h))) {
      elevate('high', `risk hint elevates: '${hint}'`);
    }
  }

  return { risk, reasons };
}

function picomatchMatch(path: string, pattern: string): boolean {
  return picomatch.isMatch(path, pattern, { dot: true });
}
