import type DatabaseType from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Ledger {
  db: DatabaseType.Database;
  path: string;
}

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Ledger schema (design.md §10) — minimum tables plus explicit migration
 * bookkeeping. Costs follow the evaluation-ledger spec: `cost_kind`
 * distinguishes 'billed' | 'estimated' | 'unknown'; unknown cost is stored
 * as NULL and must never be rendered as 0. Raw source code and secrets are
 * never stored: rows carry identifiers, statuses, durations and counts only
 * (evaluation-ledger spec: "Protect training data").
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'core-tables',
    sql: `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  base_commit TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'check',
  risk TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  engine TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  api_cost_usd REAL,
  cost_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_kind IN ('billed','estimated','unknown')),
  provider_price_version TEXT,
  policy_version TEXT
);

CREATE TABLE gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  gate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  mandatory INTEGER NOT NULL,
  duration_ms INTEGER,
  evidence_ref TEXT
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  reviewer_type TEXT NOT NULL,
  accepted INTEGER,
  duration_seconds INTEGER,
  changes_requested TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE regressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  discovered_at TEXT NOT NULL,
  severity TEXT,
  related_task_id TEXT,
  repair_cost_usd REAL,
  cost_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_kind IN ('billed','estimated','unknown'))
);

CREATE TABLE bench_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  seed INTEGER,
  base_commit TEXT,
  started_at TEXT,
  ended_at TEXT
);

CREATE INDEX idx_attempts_task ON attempts(task_id);
CREATE INDEX idx_gates_attempt ON gates(attempt_id);
CREATE INDEX idx_reviews_task ON reviews(task_id);
CREATE INDEX idx_regressions_task ON regressions(task_id);
`,
  },
];


/**
 * Opens (and migrates) the ledger. The native better-sqlite3 module is
 * loaded LAZILY so the check path never requires native dependencies —
 * `eil check` stays portable to any machine/container without native
 * builds (found during the sandbox security test, task 3.2/T7).
 */
export async function openLedger(dbPath: string): Promise<Ledger> {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(join(dbPath, '.')), { recursive: true });
  }
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return { db, path: dbPath };
}

export function applyMigrations(db: DatabaseType.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`,
  );
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((row) => row.id),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    apply();
  }
}

export function closeLedger(ledger: Ledger): void {
  ledger.db.close();
}

export function listAppliedMigrations(ledger: Ledger): { id: number; name: string; applied_at: string }[] {
  return ledger.db
    .prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id')
    .all() as { id: number; name: string; applied_at: string }[];
}

export type SqliteDatabase = DatabaseType.Database;
