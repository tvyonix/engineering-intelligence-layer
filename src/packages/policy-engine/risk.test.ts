import { describe, expect, it } from 'vitest';
import { classifyTaskRisk } from './risk.js';
import type { Violation } from './violations.js';

const v = (rule: string, path: string): Violation => ({ rule, path, detail: 'x', classification: 'new' });

describe('classifyTaskRisk (task 4.1, deterministic, monotonic)', () => {
  it('low for a single contained change with no signals', () => {
    const result = classifyTaskRisk({ changedPaths: ['src/ui/button.tsx'], violations: [] });
    expect(result.risk).toBe('low');
    expect(result.reasons).toHaveLength(0);
  });

  it('blocked when a protected path is touched', () => {
    const result = classifyTaskRisk({
      changedPaths: ['.github/workflows/ci.yml'],
      violations: [v('protected-path', '.github/workflows/ci.yml')],
    });
    expect(result.risk).toBe('blocked');
    expect(result.reasons.join('\n')).toContain('protected path touched');
  });

  it('high for privileged CI, auth, crypto, secrets and migration paths', () => {
    for (const path of [
      '.github/workflows/release.yml',
      'src/auth/login.ts',
      'src/lib/crypto/keys.ts',
      'config/secrets.ts',
      'db/migrations/001_init.ts',
      'ops/release/publish.sh',
      'certs/server.pem',
    ]) {
      const result = classifyTaskRisk({ changedPaths: [path], violations: [] });
      expect(result.risk, path).toBe('high');
      expect(result.reasons.join('\n'), path).toMatch(/high-risk/);
    }
  });

  it('high for suspicious path shapes (symlink escape, unparseable path)', () => {
    const escape = classifyTaskRisk({ changedPaths: ['src/link.ts'], violations: [v('symlink-escape', 'src/link.ts')] });
    expect(escape.risk).toBe('high');

    const format = classifyTaskRisk({ changedPaths: [], violations: [v('path-format', '../outside')] });
    expect(format.risk).toBe('high');
  });

  it('high for unapproved dependency changes and breaking API changes', () => {
    const deps = classifyTaskRisk({ changedPaths: ['package.json'], violations: [v('dependency-manifest-changed', 'package.json')] });
    expect(deps.risk).toBe('high');

    const api = classifyTaskRisk({ changedPaths: ['packages/lib/index.ts'], violations: [v('public-api-breaking', 'packages/lib/package.json')] });
    expect(api.risk).toBe('high');
  });

  it('medium when the change spans multiple top-level directories', () => {
    const result = classifyTaskRisk({ changedPaths: ['src/a.ts', 'docs/b.md'], violations: [] });
    expect(result.risk).toBe('medium');
    expect(result.reasons.join('\n')).toContain('top-level directories');
  });

  it('risk hints elevate but never lower', () => {
    const hinted = classifyTaskRisk({ changedPaths: ['src/ui/button.tsx'], violations: [], riskHints: ['touches security-sensitive flow'] });
    expect(hinted.risk).toBe('high');

    // A hint cannot de-elevate a high risk.
    const kept = classifyTaskRisk({ changedPaths: ['src/auth/login.ts'], violations: [], riskHints: ['cosmetic only'] });
    expect(kept.risk).toBe('high');
  });

  it('blocked wins over every other elevation', () => {
    const result = classifyTaskRisk({
      changedPaths: ['src/auth/login.ts', '.env'],
      violations: [v('protected-path', '.env'), v('symlink-escape', 'src/link.ts')],
      riskHints: ['security'],
    });
    expect(result.risk).toBe('blocked');
  });
});
