import { isAbsolute, posix } from 'node:path';

export interface ParsedDiagnostic {
  /** Gate-specific rule id, e.g. 'tsc:TS2322' or 'eslint:no-console'. */
  rule: string;
  /** Repo-root-relative POSIX path. */
  path: string;
  /** Human-readable detail including position. */
  detail: string;
}

/**
 * Parses `tsc --pretty false` diagnostics:
 *   src/a.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.
 * Non-diagnostic lines are ignored. A failure exit code with zero parsed
 * diagnostics must make the gate fail closed (content-gate handles that).
 */
export function parseTscOutput(output: string): ParsedDiagnostic[] {
  const diagnostics: ParsedDiagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/.exec(line);
    if (match === null) continue;
    const [, rawPath, lineNo, colNo, code, message] = match as unknown as [string, string, string, string, string, string];
    diagnostics.push({
      rule: `tsc:${code}`,
      path: normalizePath(rawPath),
      detail: `${lineNo}:${colNo}: ${message.trim()}`,
    });
  }
  return diagnostics;
}

/**
 * Parses eslint `--format json` output (the `unix` formatter is no longer in
 * ESLint 9 core). Output is a JSON array of file results; absolute filePaths
 * are made relative to the scan root. Unparseable output yields no
 * diagnostics — the gate then fails closed on "exit 1 without parseable
 * diagnostics".
 */
export function parseEslintJsonOutput(output: string, scanRoot: string): ParsedDiagnostic[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const diagnostics: ParsedDiagnostic[] = [];
  for (const fileResult of parsed) {
    if (typeof fileResult !== 'object' || fileResult === null) continue;
    const record = fileResult as { filePath?: unknown; messages?: unknown };
    if (typeof record.filePath !== 'string' || !Array.isArray(record.messages)) continue;
    for (const msg of record.messages) {
      if (typeof msg !== 'object' || msg === null) continue;
      const message = msg as { ruleId?: string | null; line?: unknown; column?: unknown; message?: unknown };
      if (typeof message.message !== 'string') continue;
      const line = typeof message.line === 'number' ? message.line : 0;
      const column = typeof message.column === 'number' ? message.column : 0;
      diagnostics.push({
        rule: `eslint:${message.ruleId ?? 'unknown'}`,
        path: normalizePath(record.filePath, scanRoot),
        detail: `${line}:${column}: ${message.message}`,
      });
    }
  }
  return diagnostics;
}

/**
 * Normalizes a diagnostic path: strips './', converts backslashes, makes
 * absolute paths relative to scanRoot when they point inside it.
 */
export function normalizePath(rawPath: string, scanRoot?: string): string {
  let p = rawPath.trim().replace(/\\/g, '/');
  if (scanRoot !== undefined && isAbsolute(p)) {
    const root = scanRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === root) return '.';
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  }
  p = posix.normalize(p);
  return p.startsWith('./') ? p.slice(2) : p;
}
