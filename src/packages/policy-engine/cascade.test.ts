import { describe, expect, it } from 'vitest';
import { planNextAttempt, type AttemptRecord } from './cascade.js';

const attempt = (overrides: Partial<AttemptRecord> & { id: string }): AttemptRecord => ({
  tier: 'cheap',
  status: 'failed',
  failureSignatures: [],
  ...overrides,
});

const base = {
  risk: 'low' as const,
  attempts: [] as AttemptRecord[],
  maxAttempts: 4,
  maxCheapRetries: 1,
  strongTierConfigured: false,
};

describe('cascade planner (tasks 4.2–4.3, deterministic)', () => {
  it('blocked risk is rejected without any attempt', () => {
    const plan = planNextAttempt({ ...base, risk: 'blocked' });
    expect(plan.action).toBe('reject-blocked');
    expect(plan.tier).toBeNull();
    expect(plan.freshWorkspace).toBe(true);
  });

  it('high risk goes straight to the strong tier when configured — never cheap-first', () => {
    const plan = planNextAttempt({ ...base, risk: 'high', strongTierConfigured: true });
    expect(plan.action).toBe('escalate-strong');
    expect(plan.tier).toBe('strong');
  });

  it('high risk without a strong tier → needs_review, never a fabricated success', () => {
    const plan = planNextAttempt({ ...base, risk: 'high', strongTierConfigured: false });
    expect(plan.action).toBe('needs-review');
    expect(plan.reason).toContain('never fabricates success');
  });

  it('low/medium risk starts cheap', () => {
    expect(planNextAttempt(base).action).toBe('start-cheap');
    expect(planNextAttempt({ ...base, risk: 'medium' }).action).toBe('start-cheap');
  });

  it('a single cheap failure with no reproducible signature retries cheap', () => {
    const plan = planNextAttempt({
      ...base,
      attempts: [attempt({ id: 'a1', failureSignatures: ['command:model-timeout'] })],
      maxCheapRetries: 1,
    });
    expect(plan.action).toBe('retry-cheap');
    expect(plan.tier).toBe('cheap');
  });

  it('an exhausted cheap retry budget escalates when the strong tier exists', () => {
    const plan = planNextAttempt({
      ...base,
      attempts: [
        attempt({ id: 'a1', failureSignatures: ['gate:tests:fail'] }),
        attempt({ id: 'a2', failureSignatures: ['gate:lint:fail'] }),
      ],
      maxCheapRetries: 1,
      strongTierConfigured: true,
    });
    expect(plan.action).toBe('escalate-strong');
    expect(plan.reason).toContain('cheap retry budget exhausted');
  });

  it('exhausted budget without a strong tier → needs_review', () => {
    const plan = planNextAttempt({
      ...base,
      attempts: [
        attempt({ id: 'a1', failureSignatures: ['gate:tests:fail'] }),
        attempt({ id: 'a2', failureSignatures: ['gate:lint:fail'] }),
      ],
      maxCheapRetries: 1,
      strongTierConfigured: false,
    });
    expect(plan.action).toBe('needs-review');
  });

  it('a reproducible failure after one cheap attempt escalates early', () => {
    const plan = planNextAttempt({
      ...base,
      attempts: [
        attempt({ id: 'a1', failureSignatures: ['gate:tests:fail'] }),
        attempt({ id: 'a2', failureSignatures: ['gate:tests:fail'] }),
      ],
      maxCheapRetries: 3,
      strongTierConfigured: true,
    });
    expect(plan.action).toBe('escalate-strong');
    expect(plan.reason).toContain('reproducible failure');
  });

  it('a reproducible failure without a strong tier keeps bounded cheap retries', () => {
    const plan = planNextAttempt({
      ...base,
      attempts: [
        attempt({ id: 'a1', failureSignatures: ['gate:tests:fail'] }),
        attempt({ id: 'a2', failureSignatures: ['gate:tests:fail'] }),
      ],
      maxCheapRetries: 3,
      strongTierConfigured: false,
    });
    expect(plan.action).toBe('retry-cheap');
    expect(plan.reason).toContain('no strong tier configured');
  });

  it('a blocking failure signal stops retries immediately', () => {
    const plan = planNextAttempt({
      ...base,
      attempts: [attempt({ id: 'a1', failureSignatures: ['secret:protected-path'] })],
      maxCheapRetries: 3,
      strongTierConfigured: true,
    });
    expect(plan.action).toBe('needs-review');
    expect(plan.reason).toContain('no retries can lift it');
  });

  it('the attempt budget is a hard bound → needs_review', () => {
    const plan = planNextAttempt({
      ...base,
      attempts: [attempt({ id: 'a1', status: 'complete' })],
      maxAttempts: 1,
    });
    expect(plan.action).toBe('needs-review');
    expect(plan.reason).toContain('budget exhausted');
  });

  it('a completed last attempt → needs_review (tests passing ≠ accepted)', () => {
    const plan = planNextAttempt({
      ...base,
      attempts: [attempt({ id: 'a1', status: 'complete' })],
      maxAttempts: 4,
    });
    expect(plan.action).toBe('needs-review');
    expect(plan.reason).toContain('human event');
  });

  it('every plan demands a fresh workspace (no state carry-over)', () => {
    const plans = [
      planNextAttempt(base),
      planNextAttempt({ ...base, risk: 'high', strongTierConfigured: true }),
      planNextAttempt({ ...base, attempts: [attempt({ id: 'a1', failureSignatures: ['x'] })] }),
    ];
    expect(plans.every((p) => p.freshWorkspace === true)).toBe(true);
  });
});
