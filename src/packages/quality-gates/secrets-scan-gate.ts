import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Violation } from '../policy-engine/violations.js';
import { canonicalizeRepoRelativePath } from '../policy-engine/paths.js';
import type { Gate, GateContext, GateOutcome } from './types.js';

export const SECRETS_SCAN_GATE_ID = 'secrets-scan';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.yaml', '.yml', '.sh', '.bash', '.py', '.rb', '.go', '.rs', '.java', '.txt', '.md', '.']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Deterministic, low-false-positive secret signatures. */
const SECRET_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }, // eil-allow-secret-fixture
  { rule: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ }, // eil-allow-secret-fixture
  { rule: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ }, // eil-allow-secret-fixture
  { rule: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ }, // eil-allow-secret-fixture
  { rule: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ }, // eil-allow-secret-fixture
];

const ASSIGNMENT_RE = /\b(api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/i; // eil-allow-secret-fixture (detector fixture)

/**
 * Placeholder exemption is intentionally STRICT (1.7 review): the ENTIRE
 * value must look like a placeholder. Substring hints ('example', '<')
 * allowed smuggling real secrets through — `AKIA…EXAMPLE` and
 * `password = "hunter2…" // a<b` must both stay findings.
 */
const PLACEHOLDER_VALUE_RE =
  /^(?:x{3,}|\*{3,}|<[^>]{1,30}>|\$\{[^}]{1,50}\}|\.{3}|…|n\/?a|true|false|null)$/i;
/**
 * Hyphen-composed placeholder VALUES are also allowed (e.g.
 * "example-placeholder-value"): lowercase/digits/hyphens only AND carrying
 * a placeholder word. Real credentials fail this on case (AKIA…), script
 * chars (ghp_…) or the absence of placeholder words (hunter2hunter2).
 */
const PLACEHOLDER_COMPOSED_RE = /^[a-z0-9-]*(placeholder|example|sample|dummy|fixture|changeme|change-me|redacted)[a-z0-9-]*$/;

export interface SecretFinding {
  rule: string;
  path: string;
  line: number;
  /** Masked excerpt — the secret itself never enters the evidence bundle. */
  maskedExcerpt: string;
  inherited: boolean;
}

export interface SuppressedMarker {
  path: string;
  line: number;
  rule: string;
}

/**
 * Explicit per-line opt-out for intentionally secret-shaped fixtures.
 * 1.7 hardening: the marker only takes effect for files matching the
 * PRIVILEGED allowlist from policy (allowSecretFixtureMarkers) — an author
 * of a diff cannot smuggle a secret past the scan by writing the marker
 * themselves. Suppressions are always recorded in the evidence.
 */
export const SECRET_FIXTURE_MARKER = 'eil-allow-secret-fixture';

export function maskExcerpt(text: string): string {
  const head = text.slice(0, 4);
  const masked = Math.min(Math.max(text.length - 4, 6), 24);
  return `${head}${'*'.repeat(masked)}…`;
}

function isPlaceholderAssignment(line: string): boolean {
  const match = ASSIGNMENT_RE.exec(line);
  if (match === null) return false;
  const sep = match[0].indexOf(match[0].includes(':') ? ':' : '=');
  const value = match[0].slice(sep + 1).trim().replace(/^['"]|['"]$/g, '');
  return PLACEHOLDER_VALUE_RE.test(value) || PLACEHOLDER_COMPOSED_RE.test(value);
}

export interface ScanFileResult {
  findings: SecretFinding[];
  suppressed: SuppressedMarker[];
  scannedFiles: number;
  skippedFiles: number;
}

/**
 * Scans file CONTENT (not the diff patch): .gitattributes `-diff`, NUL
 * bytes and patch-header lookalikes cannot hide anything from a direct
 * read (1.7 review bypass class). Binary-ish content is scanned with NULs
 * normalized to newlines.
 */
export async function scanFilesForSecrets(
  files: { path: string; absolute: string }[],
  options: { markerAllowed: (path: string) => boolean; isBaselineLine: (path: string, line: string) => boolean },
): Promise<ScanFileResult> {
  const findings: SecretFinding[] = [];
  const suppressed: SuppressedMarker[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  for (const file of files) {
    const dot = file.path.lastIndexOf('.');
    const ext = dot === -1 ? '' : file.path.slice(dot);
    if (!SOURCE_EXTENSIONS.has(ext) && !file.path.includes('.env')) {
      skippedFiles += 1;
      continue;
    }
    let content: string;
    try {
      const stats = await stat(file.absolute);
      if (stats.size > MAX_FILE_BYTES) {
        skippedFiles += 1;
        continue;
      }
      const buffer = await readFile(file.absolute);
      content = buffer.includes(0) ? buffer.toString('utf8').replace(/\0/g, '\n') : buffer.toString('utf8');
    } catch {
      continue; // deleted between listing and read
    }
    scannedFiles += 1;
    const markerAllowed = options.markerAllowed(file.path);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i] as string;
      const rule = SECRET_PATTERNS.find((p) => p.re.test(text))?.rule ?? (ASSIGNMENT_RE.test(text) ? 'secret-assignment' : undefined);
      if (rule === undefined) continue;
      if (rule === 'secret-assignment' && isPlaceholderAssignment(text)) continue;
      if (markerAllowed && text.includes(SECRET_FIXTURE_MARKER)) {
        suppressed.push({ path: file.path, line: i + 1, rule });
        continue;
      }
      const inherited = options.isBaselineLine(file.path, text);
      findings.push({ rule, path: file.path, line: i + 1, maskedExcerpt: maskExcerpt(text.trim()), inherited });
    }
  }
  return { findings, suppressed, scannedFiles, skippedFiles };
}

/**
 * Gate `secrets-scan`: screens the CONTENT of every file touched by the
 * change (added or modified, tracked or untracked) for secret-looking
 * content. Lines present verbatim in the base-commit snapshot are
 * classified inherited and do not block; anything new fails the gate with
 * rule 'known-secret' (risk escalates to blocked). Secret VALUES never
 * enter evidence — masked excerpts only; captured patches are redacted
 * separately before storage (redactSecretsInText).
 */
export function secretsScanGate(): Gate {
  return {
    id: SECRETS_SCAN_GATE_ID,
    async run(ctx: GateContext): Promise<GateOutcome> {
      const touched: { path: string; absolute: string }[] = [];
      const seen = new Set<string>();
      for (const entry of [...ctx.diff.changed, ...ctx.diff.untracked.map((u) => ({ path: u, status: 'A', origPath: undefined as string | undefined }))]) {
        if (entry.status === 'D') continue;
        for (const raw of [entry.path, entry.origPath]) {
          if (raw === undefined || seen.has(raw)) continue;
          const canonical = canonicalizeRepoRelativePath(raw);
          if (canonical.kind !== 'valid') continue;
          seen.add(canonical.path);
          touched.push({ path: canonical.path, absolute: join(ctx.repoDir, canonical.path) });
        }
      }
      if (touched.length === 0) {
        return { status: 'not_applicable', reason: 'the change touches no files' };
      }

      const allowGlobs: string[] = (ctx.policy.allowSecretFixtureMarkers as string[] | undefined) ?? [];
      let markerAllowed = (_path: string) => false;
      if (allowGlobs.length > 0) {
        const picomatch = (await import('picomatch')).default;
        markerAllowed = (path: string) => picomatch.isMatch(path, allowGlobs, { dot: true });
      }

      // Baseline line sets for inherited classification.
      const baselineSets = new Map<string, Set<string>>();
      if (ctx.baselineSnapshot !== undefined) {
        const snapshot = await ctx.baselineSnapshot();
        if (snapshot.ok) {
          for (const file of touched) {
            try {
              const content = await readFile(join(snapshot.dir, file.path), 'utf8');
              baselineSets.set(file.path, new Set(content.split('\n')));
            } catch {
              // not in baseline → everything is new
            }
          }
        }
      }

      const result = await scanFilesForSecrets(touched, {
        markerAllowed,
        isBaselineLine: (path, line) => baselineSets.get(path)?.has(line) ?? false,
      });
      const fresh = result.findings.filter((f) => !f.inherited);
      const inherited = result.findings.filter((f) => f.inherited);

      const violations: Violation[] = [
        ...fresh.map<Violation>((f) => ({
          rule: 'known-secret',
          path: `${f.path}:${f.line}`,
          detail: `${f.rule}: suspicious content (masked: ${f.maskedExcerpt}) — the secret value is never stored in evidence`,
          classification: 'new',
        })),
        ...inherited.map<Violation>((f) => ({
          rule: 'known-secret-inherited',
          path: `${f.path}:${f.line}`,
          detail: `${f.rule}: line present in baseline (masked: ${f.maskedExcerpt})`,
          classification: 'inherited',
        })),
      ];

      const status = fresh.length > 0 ? 'fail' : 'pass';
      const reason =
        fresh.length > 0
          ? `${fresh.length} new secret-shaped finding(s): ${fresh.slice(0, 5).map((f) => `${f.rule}@${f.path}:${f.line}`).join('; ')}${fresh.length > 5 ? '; …' : ''}`
          : `scanned ${result.scannedFiles} file(s) (${result.skippedFiles} skipped by extension/size); ${inherited.length} inherited line(s); ${result.suppressed.length} marker suppression(s) recorded`;
      return {
        status,
        reason,
        violations,
        artifacts: [
          {
            fileName: 'secrets-scan.json',
            content: `${JSON.stringify({ findings: result.findings, suppressed: result.suppressed, scannedFiles: result.scannedFiles, skippedFiles: result.skippedFiles }, null, 2)}\n`,
          },
        ],
      };
    },
  };
}

/** Masking helper for evidence writers: redact secret-shaped text before storage. */
export function redactSecretsInText(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(new RegExp(pattern.re.source, 'g'), `[REDACTED:${pattern.rule}]`);
  }
  output = output.replace(new RegExp(ASSIGNMENT_RE.source, 'gi'), (match) => {
    const sep = match.indexOf(match.includes(':') ? ':' : '=');
    return `${match.slice(0, sep + 1)} "[REDACTED:secret-assignment]"`;
  });
  return output;
}
