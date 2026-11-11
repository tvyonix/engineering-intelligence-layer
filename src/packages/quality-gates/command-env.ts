/**
 * Minimal environment for gate commands and engine execution (1.7 review:
 * the full process.env — including ambient tokens — leaked to every
 * subprocess). Only what tooling genuinely needs is passed through.
 */
const PASS_THROUGH: readonly RegExp[] = [
  /^PATH$/,
  /^HOME$/,
  /^TMPDIR$/,
  /^LANG$/,
  /^LC_[A-Z_]+$/,
  /^SHELL$/,
  /^TZ$/,
  // Windows necessities
  /^SYSTEMROOT$/i,
  /^COMSPEC$/i,
  /^APPDATA$/i,
  /^LOCALAPPDATA$/i,
  /^ProgramFiles(\(x86\))?$/i,
  /^ProgramData$/i,
];

export function buildSandboxedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (PASS_THROUGH.some((re) => re.test(key))) env[key] = value;
  }
  // Git hardening defaults (no ambient GIT_* passthrough).
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  return env;
}
