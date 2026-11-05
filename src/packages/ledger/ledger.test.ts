import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, closeLedger, listAppliedMigrations, openLedger, type Ledger } from './db.js';
import {
  exportJsonl,
  recordAttempt,
  recordBenchRun,
  recordCheckRun,
  recordRegression,
  recordReview,
  validateCost,
  CHECK_ENGINE_ID,
} from './records.js';

let ledger: Ledger;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eil-ledger-'));
  ledger = openLedger(join(dir, 'ledger.db'));
});

afterEach(async () => {
  closeLedger(ledger);
  await rm(dir, { recursive: true, force: true });
});

/** FKs require the task row to exist; create a minimal one. */
function ensureTask(taskId: string): void {
  ledger.db
    .prepare('INSERT OR IGNORE INTO tasks (id, base_commit, type, risk, status, contract_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, 'abc', 'check', 'unknown', 'pending', 'sha256:x', new Date().toISOString());
}

describe('migrations — task 2.4', () => {
  it('apply once and are idempotent', () => {
    const first = listAppliedMigrations(ledger);
    expect(first.map((m) => m.name)).toContain('core-tables');
    applyMigrations(ledger.db);
    expect(listAppliedMigrations(ledger)).toHaveLength(first.length);
  });

  it('creates the six design tables', () => {
    const tables = (ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const table of ['tasks', 'attempts', 'gates', 'reviews', 'regressions', 'bench_runs']) {
      expect(tables).toContain(table);
    }
  });
});

describe('recordCheckRun', () => {
  it('writes task, attempt and gate rows', () => {
    const result = recordCheckRun(ledger, {
      taskId: 'alerts-bulk-ack',
      baseCommit: 'abc123',
      contractHash: 'sha256:deadbeef',
      status: 'needs_review',
      startedAt: '2026-11-05T10:00:00.000Z',
      completedAt: '2026-11-05T10:00:05.000Z',
      policyVersion: 'default',
      evidenceDir: '/evidence/run-1',
      gates: [
        { id: 'path-scope', status: 'pass', mandatory: true, durationMs: 3, evidencePath: 'logs/path-scope--path-scope.json' },
        { id: 'tests', status: 'error', mandatory: true, durationMs: 0 },
      ],
    });
    const task = ledger.db.prepare('SELECT * FROM tasks WHERE id = ?').get('alerts-bulk-ack') as Record<string, unknown>;
    expect(task?.status).toBe('needs_review');
    expect(task?.contract_hash).toBe('sha256:deadbeef');
    const attempt = ledger.db.prepare('SELECT * FROM attempts WHERE id = ?').get(result.attemptId) as Record<string, unknown>;
    expect(attempt?.engine).toBe(CHECK_ENGINE_ID);
    expect(attempt?.model).toBeNull();
    expect(attempt?.api_cost_usd).toBeNull();
    expect(attempt?.cost_kind).toBe('unknown');
    const gates = ledger.db.prepare('SELECT * FROM gates WHERE attempt_id = ?').all(result.attemptId) as Record<string, unknown>[];
    expect(gates).toHaveLength(2);
    expect(gates[0]?.evidence_ref).toBe('/evidence/run-1/logs/path-scope--path-scope.json');
  });

  it('upserts the task row without duplicating', () => {
    const input = {
      taskId: 't1',
      baseCommit: 'a',
      contractHash: 'sha256:1',
      status: 'needs_review',
      startedAt: '2026-11-05T10:00:00.000Z',
      completedAt: '2026-11-05T10:00:01.000Z',
      policyVersion: 'default',
      evidenceDir: '/e',
      gates: [],
    };
    recordCheckRun(ledger, input);
    recordCheckRun(ledger, { ...input, status: 'blocked' });
    const tasks = ledger.db.prepare('SELECT * FROM tasks').all();
    expect(tasks).toHaveLength(1);
    const attempts = ledger.db.prepare('SELECT * FROM attempts').all();
    expect(attempts).toHaveLength(2);
  });
});

describe('cost veracity — task 2.5 / evaluation-ledger spec', () => {
  it('rejects billed/estimated attempts without an amount', () => {
    expect(() =>
      recordAttempt(ledger, { taskId: 'no-such-task', engine: 'pi', status: 'failed', startedAt: 'x', costKind: 'billed' }),
    ).toThrow(/requires api_cost_usd/);
    expect(() =>
      recordAttempt(ledger, { taskId: 't', engine: 'pi', status: 'failed', startedAt: 'x', costKind: 'estimated' }),
    ).toThrow(/requires api_cost_usd/);
  });

  it('rejects unknown cost carrying an amount, and never stores 0 as unknown', () => {
    expect(() =>
      recordAttempt(ledger, { taskId: 't', engine: 'pi', status: 'complete', startedAt: 'x', costKind: 'unknown', apiCostUsd: 0 }),
    ).toThrow(/must not carry api_cost_usd/);
    ensureTask('t');
    const id = recordAttempt(ledger, {
      taskId: 't',
      engine: 'pi',
      model: 'zai/glm-5.3-flash',
      status: 'failed',
      startedAt: 'x',
      costKind: 'unknown',
      providerPriceVersion: null,
      policyVersion: 'v1',
    });
    const row = ledger.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.api_cost_usd).toBeNull();
    expect(row.model).toBe('zai/glm-5.3-flash');
  });

  it('stores billed attempts with amount, tokens and price version', () => {
    ensureTask('t');
    ensureTask('t');
    const id = recordAttempt(ledger, {
      taskId: 't',
      engine: 'pi',
      model: 'zai/glm-5.3-flash',
      status: 'failed',
      startedAt: 'x',
      endedAt: 'y',
      inputTokens: 1200,
      outputTokens: 340,
      cachedTokens: 100,
      apiCostUsd: 0.0042,
      costKind: 'billed',
      providerPriceVersion: 'zai-2026-11',
      policyVersion: 'v1',
    });
    const row = ledger.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.api_cost_usd).toBe(0.0042);
    expect(row.cost_kind).toBe('billed');
    expect(row.provider_price_version).toBe('zai-2026-11');
  });

  it('validateCost is exported and enforced for regressions too', () => {
    expect(() => validateCost({ costKind: 'unknown', apiCostUsd: 0 }, 'ctx')).toThrow();
    expect(() =>
      recordRegression(ledger, { taskId: 'no-such-task', discoveredAt: 'x', costKind: 'estimated' }),
    ).toThrow(/requires api_cost_usd/);
    ensureTask('t');
    const id = recordRegression(ledger, { taskId: 't', discoveredAt: 'x', costKind: 'unknown' });
    expect(id).toBeGreaterThan(0);
  });
});

describe('reviews and bench runs', () => {
  it('stores review results separately from machine gate status', () => {
    recordCheckRun(ledger, {
      taskId: 't',
      baseCommit: 'a',
      contractHash: 'sha256:1',
      status: 'needs_review',
      startedAt: 'x',
      completedAt: 'y',
      policyVersion: 'default',
      evidenceDir: '/e',
      gates: [],
    });
    const id = recordReview(ledger, {
      taskId: 't',
      reviewerType: 'human',
      accepted: true,
      durationSeconds: 900,
      changesRequested: '2 comments resolved before acceptance',
      observedAt: '2026-11-05T11:00:00.000Z',
    });
    const row = ledger.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.accepted).toBe(1);
    expect(row.reviewer_type).toBe('human');
    expect(row.duration_seconds).toBe(900);
  });

  it('records bench run metadata', () => {
    const id = recordBenchRun(ledger, { scenarioId: 'beaver-6step', variant: 'C', seed: 7, baseCommit: 'abc', startedAt: 's', endedAt: 'e' });
    expect(id).toBeGreaterThan(0);
  });
});

describe('JSONL export — task 2.4', () => {
  it('exports every table without raw source code', () => {
    recordCheckRun(ledger, {
      taskId: 't',
      baseCommit: 'a',
      contractHash: 'sha256:1',
      status: 'needs_review',
      startedAt: 'x',
      completedAt: 'y',
      policyVersion: 'default',
      evidenceDir: '/e',
      gates: [{ id: 'path-scope', status: 'pass', mandatory: true, durationMs: 1 }],
    });
    ensureTask('t');
    recordAttempt(ledger, {
      taskId: 't',
      engine: 'pi',
      status: 'failed',
      startedAt: 'x',
      costKind: 'unknown',
    });
    const files = exportJsonl(ledger, join(dir, 'export'));
    for (const table of ['tasks', 'attempts', 'gates', 'reviews', 'regressions', 'bench_runs']) {
      const file = files.find((f) => f.endsWith(`${table}.jsonl`));
      expect(file, table).toBeDefined();
      expect(existsSync(file as string)).toBe(true);
    }
    const attempts = readFileSync((files.find((f) => f.endsWith('attempts.jsonl')) as string), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    // One check attempt (eil-check) + one recorded pi attempt.
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a: Record<string, unknown>) => a.engine).sort()).toEqual(['eil-check', 'pi']);
    for (const attempt of attempts) {
      expect(attempt).not.toHaveProperty('source');
      expect(attempt).not.toHaveProperty('diff');
    }
    const gates = readFileSync((files.find((f) => f.endsWith('gates.jsonl')) as string), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(gates).toHaveLength(1);
  });
});
