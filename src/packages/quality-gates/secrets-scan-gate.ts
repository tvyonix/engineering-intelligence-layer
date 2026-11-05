import type { Violation } from '../policy-engine/violations.js';
import type { Gate, GateContext, GateOutcome } from './types.js';
import { normalizePath } from './diagnostics.js';

export const SECRETS_SCAN_GATE_ID = 'secrets-scan';

export interface AddedLine {
  file: string;
  /** 1-based line number in the NEW file. */
  line: number;
  text: string;
}

/**
 * Extracts added lines from a unified diff patch, including the untracked
 * sections appended by check mode (`--no-index` against /dev/null). Only
 * '+' lines are returned — exactly what would leave the repository if a
 * provider were involved.
 */
export function addedLinesFromPatch(patch: string, scanRoot?: string): AddedLine[] {
  const added: AddedLine[] = [];
  let currentFile = '';
  let newLine = 0;
  let inHunk = false;
  for (const rawLine of patch.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      inHunk = false;
      currentFile = '';
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      const path = rawLine.slice(4).trim();
      if (path === '/dev/null') {
        currentFile = '';
      } else {
        const stripped = path.replace(/^b\//, '');
        currentFile = normalizePath(stripped, scanRoot);
        if (scanRoot !== undefined && currentFile === stripped) {
          // git --no-index headers drop the leading slash: match the
          // relative form of the scan root as well ('tmp/repo/…').
          const rootRelative = scanRoot.replace(/^\/+/, '');
          if (stripped.startsWith(`${rootRelative}/`)) {
            currentFile = stripped.slice(rootRelative.length + 1);
          }
        }
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(rawLine);
    if (hunk !== null) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || currentFile === '') continue;
    if (rawLine.startsWith('+')) {
      added.push({ file: currentFile, line: newLine, text: rawLine.slice(1) });
      newLine += 1;
    } else if (rawLine.startsWith('-')) {
      // removed line: new-file counter unchanged
    } else if (rawLine.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      newLine += 1;
    }
  }
  return added;
}

/** Deterministic, low-false-positive secret signatures. */
const SECRET_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { rule: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

/** Generic assignment rule with placeholder exclusion to keep false positives low. */
const ASSIGNMENT_RE = /\b(api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/i;
const PLACEHOLDER_HINTS = ['example', 'sample', 'placeholder', 'changeme', 'change-me', 'dummy', 'fixture', 'xxxx', '<', '${', 'redacted'];

function isPlaceholder(text: string): boolean {
  const lowered = text.toLowerCase();
  return PLACEHOLDER_HINTS.some((hint) => lowered.includes(hint));
}

export interface SecretFinding {
  rule: string;
  path: string;
  line: number;
  /** Masked excerpt — the secret itself never enters the evidence bundle. */
  maskedExcerpt: string;
}

export function maskExcerpt(text: string): string {
  // Keep the first 4 characters as a review hint; always mask at least 6
  // characters (capped at 24) so even short findings are not exposed.
  const head = text.slice(0, 4);
  const masked = Math.min(Math.max(text.length - 4, 6), 24);
  return `${head}${'*'.repeat(masked)}…`;
}

/** Scans added lines for secret-looking content (deterministic). */
export function scanForSecrets(added: AddedLine[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const line of added) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(line.text)) {
        findings.push({ rule: pattern.rule, path: line.file, line: line.line, maskedExcerpt: maskExcerpt(line.text.trim()) });
        break; // one finding per line: first matching rule wins
      }
    }
    if (ASSIGNMENT_RE.test(line.text) && !isPlaceholder(line.text)) {
      const hasStructured = SECRET_PATTERNS.some((p) => p.re.test(line.text));
      if (!hasStructured) {
        findings.push({ rule: 'secret-assignment', path: line.file, line: line.line, maskedExcerpt: maskExcerpt(line.text.trim()) });
      }
    }
  }
  return findings;
}

/**
 * Gate `secrets-scan` (task 3.3, check-only part): scans the added lines of
 * the diff for secret-looking content BEFORE anything could ever leave the
 * repository. Findings fail the gate (mandatory) with a `known-secret` rule
 * name, which the risk classifier escalates to `blocked` (design.md §5:
 * known secrets exfiltration).
 *
 * The secret VALUE is never stored: evidence carries path, line, rule and a
 * masked excerpt only. Repository instructions asking to run commands or
 * reveal secrets are treated as data — this gate reads them as text, and
 * nothing in check mode executes content (prompt-injection is inert here).
 */
export function secretsScanGate(): Gate {
  return {
    id: SECRETS_SCAN_GATE_ID,
    async run(ctx: GateContext): Promise<GateOutcome> {
      if (ctx.diff.patch === null) {
        return { status: 'error', reason: 'patch unavailable; secrets cannot be verified — failing closed' };
      }
      const added = addedLinesFromPatch(ctx.diff.patch, ctx.repoDir);
      const findings = scanForSecrets(added);
      const violations: Violation[] = findings.map((f) => ({
        rule: 'known-secret',
        path: `${f.path}:${f.line}`,
        detail: `${f.rule}: suspicious content in added line (masked: ${f.maskedExcerpt}) — the secret value is never stored in evidence`,
        classification: 'new',
      }));
      const status = findings.length > 0 ? 'fail' : 'pass';
      const reason =
        findings.length > 0
          ? `${findings.length} potential secret(s) in added lines: ${findings.slice(0, 5).map((f) => `${f.rule}@${f.path}:${f.line}`).join('; ')}${findings.length > 5 ? '; …' : ''}`
          : `no secret-looking content in ${added.length} added line(s)`;
      return {
        status,
        reason,
        violations,
        artifacts: [{ fileName: 'secrets-scan.json', content: `${JSON.stringify({ findings }, null, 2)}\n` }],
      };
    },
  };
}
