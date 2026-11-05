import { describe, expect, it } from 'vitest';
import { computeVerdict, runGates } from './run-gates.js';
import type { EvidenceWriter, Gate, GateContext } from './types.js';

const noopWriter: EvidenceWriter = {
  async write() {
    return 'logs/unused.txt';
  },
};

function minimalCtx(policy: { quality: { required: string[] } }): GateContext {
  return {
    repoDir: '/unused',
    repoRealRoot: '/unused',
    headCommit: 'h',
    baseCommit: 'b',
    baseCommitInput: 'b',
    baseCommitSource: 'task',
    contract: {
      version: 1,
      id: 't',
      baseCommit: 'b',
      description: 'd',
      scope: { allow: ['**'], protect: [] },
      acceptance: [{ id: 'a', description: 'd' }],
      policy: { maxAttempts: 1, noNewDependencies: false },
    },
    contractHash: 'sha256:x',
    policy: { source: 'default', quality: policy.quality },
    diff: {
      changed: [],
      untracked: [],
      worktreeDirty: false,
      baselineChanged: null,
      patch: '',
      patchTruncated: false,
    },
    evidence: noopWriter,
  } as unknown as GateContext;
}

describe('runGates', () => {
  it('synthesizes a missing_result error for a known gate that produced no result', async () => {
    // 'tests' is a known gate id but this registry does not include it.
    const gates: Gate[] = [
      {
        id: 'path-scope',
        async run() {
          return { status: 'pass' };
        },
      },
    ];
    const ctx = minimalCtx({ quality: { required: ['path-scope', 'tests'] } });
    const { results } = await runGates(gates, ctx);
    const absent = results.find((r) => r.id === 'tests');
    expect(absent?.status).toBe('error');
    expect(absent?.mandatory).toBe(true);
    expect(absent?.reason).toContain('missing_result');
  });

  it('synthesizes an unknown_gate error for a required id EIL does not know', async () => {
    const gates: Gate[] = [];
    const ctx = minimalCtx({ quality: { required: ['mystery-gate'] } });
    const { results } = await runGates(gates, ctx);
    const mystery = results.find((r) => r.id === 'mystery-gate');
    expect(mystery?.status).toBe('error');
    expect(mystery?.mandatory).toBe(true);
    expect(mystery?.reason).toContain('unknown_gate');
  });

  it('converts a throwing gate into an error result', async () => {
    const gates: Gate[] = [
      {
        id: 'exploding-gate',
        async run() {
          throw new Error('boom');
        },
      },
    ];
    const ctx = minimalCtx({ quality: { required: ['exploding-gate'] } });
    const { results } = await runGates(gates, ctx);
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.reason).toContain('boom');
  });

  it('marks evidence path when artifacts are written', async () => {
    const gates: Gate[] = [
      {
        id: 'g',
        async run() {
          return { status: 'pass', artifacts: [{ fileName: 'g.json', content: '{}' }] };
        },
      },
    ];
    const ctx = minimalCtx({ quality: { required: ['g'] } });
    const { results } = await runGates(gates, ctx);
    expect(results[0]?.evidencePath).toBe('logs/unused.txt');
  });
});

describe('computeVerdict', () => {
  it('mandatory fail blocks (exit 1) even when other gates pass', () => {
    const v = computeVerdict([
      { id: 'a', status: 'pass', mandatory: true, durationMs: 0 },
      { id: 'b', status: 'fail', mandatory: true, durationMs: 0 },
      { id: 'c', status: 'error', mandatory: false, durationMs: 0 },
    ]);
    expect(v).toEqual({ verdict: 'blocked', exitCode: 1 });
  });

  it('mandatory error yields exit 2 when no mandatory fail exists', () => {
    const v = computeVerdict([
      { id: 'a', status: 'pass', mandatory: true, durationMs: 0 },
      { id: 'b', status: 'error', mandatory: true, durationMs: 0 },
    ]);
    expect(v).toEqual({ verdict: 'error', exitCode: 2 });
  });

  it('all mandatory pass/not_applicable yields needs_review (never accepted)', () => {
    const v = computeVerdict([
      { id: 'a', status: 'pass', mandatory: true, durationMs: 0 },
      { id: 'b', status: 'not_applicable', mandatory: true, durationMs: 0 },
      { id: 'c', status: 'error', mandatory: false, durationMs: 0 },
    ]);
    expect(v).toEqual({ verdict: 'needs_review', exitCode: 0 });
  });

  it('optional gate failures do not block', () => {
    const v = computeVerdict([
      { id: 'a', status: 'pass', mandatory: true, durationMs: 0 },
      { id: 'opt', status: 'fail', mandatory: false, durationMs: 0 },
    ]);
    expect(v.verdict).toBe('needs_review');
  });
});
