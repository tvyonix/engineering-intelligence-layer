/**
 * CLI-layer shared types. Exists so main.ts and context-commands.ts do not
 * import each other for types — EIL's own import-boundaries gate counts
 * even type-only imports as graph edges (found during the 1.7 fix).
 */
export interface CheckOptions {
  repo: string;
  task: string;
  base?: string;
  policy?: string;
  out?: string;
  ledger?: string;
  quiet?: boolean;
}

export interface CheckRunOutput {
  exitCode: 0 | 1 | 2;
  bundleJson: string | null;
  evidenceDir: string | null;
  messages: string[];
}
