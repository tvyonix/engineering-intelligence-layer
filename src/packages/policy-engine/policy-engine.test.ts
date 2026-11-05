import { describe, expect, it } from 'vitest';
import { canonicalizeRepoRelativePath } from './paths.js';
import { matchScope, createScopeMatcher } from './scope.js';
import { classifyViolations, violationFingerprint } from './violations.js';
import { globCovers } from '../contracts/task-contract.js';

describe('canonicalizeRepoRelativePath (task 0.3)', () => {
  it('normalizes redundant separators and dot segments', () => {
    expect(canonicalizeRepoRelativePath('src//feature.ts')).toEqual({ kind: 'valid', path: 'src/feature.ts' });
    expect(canonicalizeRepoRelativePath('./src/./feature.ts')).toEqual({ kind: 'valid', path: 'src/feature.ts' });
  });

  it('rejects absolute paths and windows drive letters', () => {
    expect(canonicalizeRepoRelativePath('/etc/passwd').kind).toBe('invalid');
    expect(canonicalizeRepoRelativePath('C:/tmp/x').kind).toBe('invalid');
  });

  it('rejects path traversal above the repository root', () => {
    const direct = canonicalizeRepoRelativePath('../outside.txt');
    expect(direct.kind).toBe('invalid');

    const sneaky = canonicalizeRepoRelativePath('src/../../outside.txt');
    expect(sneaky.kind).toBe('invalid');

    const deep = canonicalizeRepoRelativePath('a/b/../../../c');
    expect(deep.kind).toBe('invalid');
  });

  it('rejects NUL bytes and empty paths', () => {
    expect(canonicalizeRepoRelativePath('src\0/x').kind).toBe('invalid');
    expect(canonicalizeRepoRelativePath('').kind).toBe('invalid');
  });

  it('keeps legitimate inner "..." names', () => {
    expect(canonicalizeRepoRelativePath('src/a...b/file.ts')).toEqual({ kind: 'valid', path: 'src/a...b/file.ts' });
  });
});

describe('scope matching (protect beats allow)', () => {
  const matcher = createScopeMatcher(['src/features/alerts/**', 'tests/alerts/**'], [
    '.github/workflows/**',
    '.env*',
    'package-lock.json',
  ]);

  it('paths inside allow are allowed', () => {
    const match = matchScope(matcher, 'src/features/alerts/Badge.tsx');
    expect(match.allowed).toBe(true);
    expect(match.protected).toBe(false);
  });

  it('paths outside allow are violations even if not protected', () => {
    const match = matchScope(matcher, 'src/other/Thing.tsx');
    expect(match.allowed).toBe(false);
    expect(match.protected).toBe(false);
  });

  it('protected paths are flagged even when also covered by allow', () => {
    const wide = createScopeMatcher(['**'], ['.github/workflows/**']);
    const match = matchScope(wide, '.github/workflows/ci.yml');
    expect(match.protected).toBe(true);
    expect(match.allowed).toBe(true);
  });

  it('.git internals are always protected', () => {
    const match = matchScope(createScopeMatcher(['**'], []), '.git/hooks/pre-commit');
    expect(match.protected).toBe(true);
  });

  it('dotfiles are matched with dot:true (.env* protect)', () => {
    expect(matchScope(matcher, '.env.local').protected).toBe(true);
  });
});

describe('globCovers', () => {
  it('detects prefix coverage', () => {
    expect(globCovers('src/**', 'src/secrets/**')).toBe(true);
    expect(globCovers('src/features/**', 'src/secrets/**')).toBe(false);
    expect(globCovers('**', 'anything/x')).toBe(true);
  });
});

describe('classifyViolations (task 0.5: new vs inherited)', () => {
  const current = [
    { rule: 'lint:no-explicit-any', path: 'src/a.ts', detail: 'found: any', classification: 'new' as const },
    { rule: 'lint:no-console', path: 'src/b.ts', detail: 'console.log', classification: 'new' as const },
  ];
  const baseline = [
    { rule: 'lint:no-console', path: 'src/b.ts', detail: 'console.log', classification: 'new' as const },
    { rule: 'lint:no-console', path: 'src/c.ts', detail: 'console.log', classification: 'new' as const },
  ];

  it('classifies fingerprint matches as inherited and the rest as new', () => {
    const { newViolations, inherited } = classifyViolations(current, baseline);
    expect(newViolations.map((v) => v.path)).toEqual(['src/a.ts']);
    expect(inherited.map((v) => v.path)).toEqual(['src/b.ts']);
  });

  it('fingerprint includes rule, path and detail', () => {
    expect(violationFingerprint({ rule: 'r', path: 'p', detail: 'd' })).toBe('r::p::d');
    const a = { rule: 'r', path: 'p', detail: 'd1' };
    const b = { rule: 'r', path: 'p', detail: 'd2' };
    expect(violationFingerprint(a)).not.toBe(violationFingerprint(b));
  });

  it('empty baseline means everything is new', () => {
    const { newViolations, inherited } = classifyViolations(current, []);
    expect(newViolations).toHaveLength(2);
    expect(inherited).toHaveLength(0);
  });
});
