import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeLedger, openLedger, type Ledger } from './db.js';
import { recordAttempt, recordBenchRun, recordCheckRun, recordRegression, recordReview } from './records.js';
import { cascadeWaste, computeBenchMetrics, costPerAcceptedTask, regressionTax, relativeEvolutionCost, renderMetricsMarkdown } from './metrics.js';

let ledger: Ledger;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eil-metrics-'));
  ledger = openLedger(join(dir, 'metrics.db'));
});

afterEach(async () => {
  closeLedger(ledger);
  await rm(dir, { recursive: true, force: true });
});

function ensureTask(id: string, type: string = 'check'): void {
  ledger.db
    .prepare("INSERT OR IGNORE INTO tasks (id, base_commit, type, risk, status, contract_hash, created_at) VALUES (?, 'a', ?, 'low', 'pending', 'sha256:x', 'now')")
    .run(id, type);
}

describe('Cost per Accepted Task — unavailable without human acceptance (spec scenario)', () => {
  it('is UNAVAILABLE when no accepted tasks exist, never divided by a fabricated unit', () => {
    ensureTask('t1');
    recordAttempt(ledger, { taskId: 't1', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 5, costKind: 'billed' });
    const metric = costPerAcceptedTask(ledger);
    expect(metric.available).toBe(false);
    expect(metric.reason).toContain('no human-accepted tasks');
    expect(metric.valueUsd).toBeUndefined();
  });

  it('divides attempt+verification costs by accepted count; failed attempts count too', () => {
    ensureTask('a1');
    ensureTask('a2');
    // a1: one failed attempt ($1) + the successful one ($2) — both count.
    recordAttempt(ledger, { taskId: 'a1', engine: 'pi', status: 'failed', startedAt: 'x', apiCostUsd: 1, costKind: 'billed' });
    recordAttempt(ledger, { taskId: 'a1', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 2, costKind: 'billed' });
    recordAttempt(ledger, { taskId: 'a2', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 3, costKind: 'estimated' });
    recordReview(ledger, { taskId: 'a1', reviewerType: 'human', accepted: true, observedAt: 'x' });
    recordReview(ledger, { taskId: 'a2', reviewerType: 'human', accepted: true, observedAt: 'x' });
    const metric = costPerAcceptedTask(ledger);
    expect(metric.available).toBe(true);
    expect(metric.valueUsd).toBeCloseTo(3); // (1+2+3)/2
    expect(metric.lowerBound).toBeUndefined();
  });

  it('unknown-cost attempts are excluded from the number but labeled as a lower bound', () => {
    ensureTask('u1');
    recordAttempt(ledger, { taskId: 'u1', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 4, costKind: 'billed' });
    recordAttempt(ledger, { taskId: 'u1', engine: 'pi', status: 'failed', startedAt: 'x', costKind: 'unknown' });
    recordReview(ledger, { taskId: 'u1', reviewerType: 'human', accepted: true, observedAt: 'x' });
    const metric = costPerAcceptedTask(ledger);
    expect(metric.available).toBe(true);
    expect(metric.valueUsd).toBe(4);
    expect(metric.lowerBound).toBe(true);
    expect(metric.unknownCount).toBe(1);
    expect(metric.notes.join(' ')).toContain('at least this number');
  });

  it('excludes eil-check verification attempts from cost sums', () => {
    ensureTask('v1');
    recordAttempt(ledger, { taskId: 'v1', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 2, costKind: 'billed' });
    recordCheckRun(ledger, {
      taskId: 'v1',
      baseCommit: 'a',
      contractHash: 'sha256:1',
      status: 'needs_review',
      startedAt: 'x',
      completedAt: 'y',
      policyVersion: 'default',
      evidenceDir: '/e',
      gates: [],
    });
    recordReview(ledger, { taskId: 'v1', reviewerType: 'human', accepted: true, observedAt: 'x' });
    const metric = costPerAcceptedTask(ledger);
    expect(metric.valueUsd).toBe(2);
    expect(metric.unknownCount).toBeUndefined();
  });
});

describe('Cascade Waste', () => {
  it('sums non-accepted attempts; the last complete attempt of an accepted task is not waste', () => {
    ensureTask('w1');
    ensureTask('w2');
    recordAttempt(ledger, { taskId: 'w1', engine: 'pi', status: 'failed', startedAt: 'x', apiCostUsd: 1, costKind: 'billed' });
    recordAttempt(ledger, { taskId: 'w1', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 2, costKind: 'billed' });
    recordAttempt(ledger, { taskId: 'w2', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 5, costKind: 'billed' });
    recordReview(ledger, { taskId: 'w1', reviewerType: 'human', accepted: true, observedAt: 'x' });
    // w2 never accepted → its only attempt is waste.
    const metric = cascadeWaste(ledger);
    expect(metric.available).toBe(true);
    expect(metric.valueUsd).toBe(6); // failed $1 + w2's $5
    expect(metric.notes.join(' ')).toContain('not a counterfactual routing regret');
  });

  it('counts unknown-cost waste without adding zeros', () => {
    ensureTask('w3');
    recordAttempt(ledger, { taskId: 'w3', engine: 'pi', status: 'failed', startedAt: 'x', costKind: 'unknown' });
    const metric = cascadeWaste(ledger);
    expect(metric.valueUsd).toBe(0);
    expect(metric.unknownCount).toBe(1);
    expect(metric.lowerBound).toBe(true);
  });
});

describe('Relative Evolution Cost', () => {
  it('is UNAVAILABLE when steps lack measured costs on both sides', () => {
    ensureTask('beaver__B__step-1', 'bench-step');
    recordBenchRun(ledger, { scenarioId: 'beaver', variant: 'B', startedAt: 'x' });
    const rec = relativeEvolutionCost(ledger, { scenario: 'beaver', variant: 'B', control: 'A' });
    expect(rec.available).toBe(false);
    expect(rec.reason).toContain('lacks measured costs');
  });

  it('computes per-step ratios and the aggregate when both sides are measured', () => {
    for (const step of [1, 2]) {
      ensureTask(`beaver__A__step-${step}`, 'bench-step');
      ensureTask(`beaver__B__step-${step}`, 'bench-step');
      recordAttempt(ledger, { taskId: `beaver__A__step-${step}`, engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 2, costKind: 'billed' });
      recordAttempt(ledger, { taskId: `beaver__B__step-${step}`, engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 1, costKind: 'billed' });
    }
    const rec = relativeEvolutionCost(ledger, { scenario: 'beaver', variant: 'B', control: 'A' });
    expect(rec.available).toBe(true);
    expect(rec.value).toBeCloseTo(0.5);
    expect(rec.perStep.every((s) => s.ratio !== null && Math.abs(s.ratio - 0.5) < 1e-9)).toBe(true);
  });

  it('stays honest when only one step is measured', () => {
    ensureTask('beaver__A__step-1', 'bench-step');
    ensureTask('beaver__B__step-1', 'bench-step');
    ensureTask('beaver__B__step-2', 'bench-step');
    recordAttempt(ledger, { taskId: 'beaver__A__step-1', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 2, costKind: 'billed' });
    recordAttempt(ledger, { taskId: 'beaver__B__step-1', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 1, costKind: 'billed' });
    const rec = relativeEvolutionCost(ledger, { scenario: 'beaver', variant: 'B', control: 'A' });
    expect(rec.available).toBe(false);
    expect(rec.perStep.find((s) => s.step === 1)?.ratio).not.toBeNull();
    expect(rec.perStep.find((s) => s.step === 2)?.ratio).toBeNull();
  });
});

describe('Regression Tax', () => {
  it('is UNAVAILABLE with no regressions — absence of data is not zero tax', () => {
    const metric = regressionTax(ledger);
    expect(metric.available).toBe(false);
    expect(metric.reason).toContain('not a zero tax');
  });

  it('divides attributed repair cost by the change cost of related tasks', () => {
    ensureTask('r1');
    recordAttempt(ledger, { taskId: 'r1', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 10, costKind: 'billed' });
    recordRegression(ledger, { taskId: 'r1', discoveredAt: 'x', relatedTaskId: 'r1', apiCostUsd: 2.5, costKind: 'billed' });
    const metric = regressionTax(ledger);
    expect(metric.available).toBe(true);
    expect(metric.value).toBeCloseTo(0.25);
    expect(metric.attributedRepairUsd).toBeCloseTo(2.5);
    expect(metric.totalChangeUsd).toBeCloseTo(10);
  });

  it('counts unattributed regressions instead of silently including them', () => {
    ensureTask('r2');
    recordAttempt(ledger, { taskId: 'r2', engine: 'pi', status: 'complete', startedAt: 'x', apiCostUsd: 10, costKind: 'billed' });
    recordRegression(ledger, { taskId: 'r2', discoveredAt: 'x', relatedTaskId: null, apiCostUsd: 9, costKind: 'billed' });
    const metric = regressionTax(ledger);
    expect(metric.available).toBe(false);
    expect(metric.reason).toContain('unattributed');
    expect(metric.unattributedCount).toBe(1);
  });
});

describe('renderMetricsMarkdown', () => {
  it('renders UNAVAILABLE sections and honesty notes', () => {
    const metrics = computeBenchMetrics(ledger, { scenario: 'beaver', variant: 'B', control: 'A' });
    const md = renderMetricsMarkdown(metrics);
    expect(md).toContain('UNAVAILABLE');
    expect(md).toContain('never substituted with zeros');
    expect(md).toContain('Cost per Accepted Task');
    expect(md).toContain('Cascade Waste');
    expect(md).toContain('Relative Evolution Cost');
    expect(md).toContain('Regression Tax');
  });
});
