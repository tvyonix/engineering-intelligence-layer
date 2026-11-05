import { describe, expect, it } from 'vitest';
import { canonicalJson, hashTaskContract } from './hash.js';
import { parseTaskContract, scopeOverlapWarnings } from './task-contract.js';

const validContract = {
  version: 1,
  id: 'alerts-bulk-ack',
  baseCommit: 'abc1234',
  description: 'Add bulk acknowledgement of alerts',
  scope: {
    allow: ['src/features/alerts/**', 'tests/alerts/**'],
    protect: ['.github/workflows/**', '.env*'],
  },
  acceptance: [
    { id: 'unit', description: 'Bulk acknowledgement updates only selected alerts' },
  ],
  policy: {
    maxUsd: 3.0,
    maxAttempts: 2,
    noNewDependencies: true,
  },
};

describe('task contract validation', () => {
  it('accepts the valid contract and produces a stable sha256 hash', () => {
    const first = parseTaskContract(validContract, hashTaskContract);
    const second = parseTaskContract(validContract, hashTaskContract);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(first.contractHash).toBe(second.contractHash);
    }
  });

  it('hash is independent of object key order', () => {
    const reordered = {
      policy: { noNewDependencies: true, maxAttempts: 2, maxUsd: 3.0 },
      acceptance: [{ id: 'unit', description: 'Bulk acknowledgement updates only selected alerts' }],
      scope: {
        protect: ['.github/workflows/**', '.env*'],
        allow: ['src/features/alerts/**', 'tests/alerts/**'],
      },
      description: 'Add bulk acknowledgement of alerts',
      baseCommit: 'abc1234',
      id: 'alerts-bulk-ack',
      version: 1,
    };
    expect(hashTaskContract(reordered)).toBe(hashTaskContract(validContract));
  });

  it('different contracts produce different hashes', () => {
    const changed = { ...validContract, description: 'Different description' };
    expect(hashTaskContract(changed)).not.toBe(hashTaskContract(validContract));
  });

  it('rejects unknown top-level fields (strict privileged contract)', () => {
    const result = parseTaskContract({ ...validContract, extra: true }, hashTaskContract);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('extra');
  });

  it('rejects unsupported version, empty scope.allow and empty acceptance', () => {
    const wrongVersion = parseTaskContract({ ...validContract, version: 2 }, hashTaskContract);
    expect(wrongVersion.ok).toBe(false);

    const emptyAllow = parseTaskContract(
      { ...validContract, scope: { allow: [], protect: [] } },
      hashTaskContract,
    );
    expect(emptyAllow.ok).toBe(false);

    const emptyAcceptance = parseTaskContract({ ...validContract, acceptance: [] }, hashTaskContract);
    expect(emptyAcceptance.ok).toBe(false);
  });

  it('rejects non-positive maxAttempts and non-positive maxUsd', () => {
    const zeroAttempts = parseTaskContract(
      { ...validContract, policy: { ...validContract.policy, maxAttempts: 0 } },
      hashTaskContract,
    );
    expect(zeroAttempts.ok).toBe(false);

    const negativeBudget = parseTaskContract(
      { ...validContract, policy: { ...validContract.policy, maxUsd: -1 } },
      hashTaskContract,
    );
    expect(negativeBudget.ok).toBe(false);
  });

  it('rejects traversal and absolute glob patterns in scope', () => {
    const traversal = parseTaskContract(
      { ...validContract, scope: { allow: ['../etc/**'], protect: [] } },
      hashTaskContract,
    );
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.issues.join('\n')).toContain('..');

    const absolute = parseTaskContract(
      { ...validContract, scope: { allow: ['/etc/**'], protect: [] } },
      hashTaskContract,
    );
    expect(absolute.ok).toBe(false);
  });
});

describe('scope overlap is valid with warnings (TL decision: protect > allow at runtime)', () => {
  it('protect inside allow is a valid contract with a warning', () => {
    const result = parseTaskContract(
      { ...validContract, scope: { allow: ['src/**'], protect: ['src/secret.ts'] } },
      hashTaskContract,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('covers protected pattern');
      expect(result.warnings[0]).toContain('protection takes precedence');
    }
  });

  it('identical allow and protect patterns warn but stay valid', () => {
    const warnings = scopeOverlapWarnings({ allow: ['src/**'], protect: ['src/**'] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('identical');
  });

  it('catch-all allow over any protection warns but stays valid', () => {
    expect(scopeOverlapWarnings({ allow: ['**'], protect: ['docs/x.md'] })).toHaveLength(1);
  });

  it('allow glob matching a literal protected file warns but stays valid', () => {
    expect(scopeOverlapWarnings({ allow: ['src/*.ts'], protect: ['src/index.ts'] })).toHaveLength(1);
  });

  it('disjoint allow/protect sets produce no warnings', () => {
    expect(
      scopeOverlapWarnings({
        allow: ['src/features/alerts/**', 'tests/alerts/**'],
        protect: ['.github/workflows/**', '.env*', 'package-lock.json'],
      }),
    ).toHaveLength(0);
  });

  it('end-to-end: overlapping contract parses with warnings and a stable hash', () => {
    const result = parseTaskContract(
      { ...validContract, scope: { allow: ['src/**'], protect: ['src/index.ts'] } },
      hashTaskContract,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.warnings.length).toBe(1);
    }
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow();
  });
});
