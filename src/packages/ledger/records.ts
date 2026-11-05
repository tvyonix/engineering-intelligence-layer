import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ledger } from './db.js';

export type CostKind = 'billed' | 'estimated' | 'unknown';

export interface CostFields {
  apiCostUsd?: number | null;
  costKind: CostKind;
}

/**
 * Task 2.5: cost veracity invariants (evaluation-ledger spec).
 * - 'billed'    → apiCostUsd present (provider reported usage at known rates);
 * - 'estimated' → apiCostUsd present (computed from versioned price table);
 * - 'unknown'   → apiCostUsd MUST be absent: unknown is never rendered as $0.
 */
export function validateCost(cost: CostFields, context: string): void {
  if (cost.costKind === 'unknown') {
    if (cost.apiCostUsd !== undefined && cost.apiCostUsd !== null) {
      throw new Error(`${context}: cost_kind 'unknown' must not carry api_cost_usd (report the cost as billed or estimated instead)`);
    }
    return;
  }
  if (cost.apiCostUsd === undefined || cost.apiCostUsd === null) {
    throw new Error(`${context}: cost_kind '${cost.costKind}' requires api_cost_usd; use cost_kind 'unknown' when the cost is not known`);
  }
  if (cost.apiCostUsd < 0) {
    throw new Error(`${context}: api_cost_usd must not be negative`);
  }
}

export interface RecordCheckRunInput {
  taskId: string;
  baseCommit: string;
  contractHash: string;
  /** Check verdict: needs_review | blocked | error. */
  status: string;
  startedAt: string;
  completedAt: string;
  policyVersion: string;
  evidenceDir: string;
  gates: {
    id: string;
    status: string;
    mandatory: boolean;
    durationMs: number;
    evidencePath?: string;
  }[];
}

export interface RecordCheckRunOutput {
  taskId: string;
  attemptId: number;
  gateIds: number[];
}

export const CHECK_ENGINE_ID = 'eil-check';

/**
 * Writes one check run into the ledger: the task row (upsert by task id),
 * one attempt for the check itself (engine 'eil-check', cost unknown — check
 * mode makes no model API calls) and one gate row per gate result.
 */
export function recordCheckRun(ledger: Ledger, input: RecordCheckRunInput): RecordCheckRunOutput {
  const insertTask = ledger.db.prepare(`
    INSERT INTO tasks (id, base_commit, type, risk, status, contract_hash, created_at)
    VALUES (?, ?, 'check', 'unknown', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      base_commit = excluded.base_commit,
      status = excluded.status,
      contract_hash = excluded.contract_hash
  `);
  const insertAttempt = ledger.db.prepare(`
    INSERT INTO attempts (task_id, engine, model, effort, status, started_at, ended_at,
                          input_tokens, output_tokens, cached_tokens, api_cost_usd,
                          cost_kind, provider_price_version, policy_version)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 'unknown', NULL, ?)
  `);
  const insertGate = ledger.db.prepare(`
    INSERT INTO gates (attempt_id, gate_id, status, mandatory, duration_ms, evidence_ref)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const run = ledger.db.transaction(() => {
    const now = new Date().toISOString();
    insertTask.run(input.taskId, input.baseCommit, input.status, input.contractHash, now);
    const attemptInfo = insertAttempt.run(
      input.taskId,
      CHECK_ENGINE_ID,
      input.status,
      input.startedAt,
      input.completedAt,
      input.policyVersion,
    );
    const attemptId = Number(attemptInfo.lastInsertRowid);
    const gateIds: number[] = [];
    for (const gate of input.gates) {
      const evidenceRef = gate.evidencePath !== undefined ? `${input.evidenceDir}/${gate.evidencePath}` : input.evidenceDir;
      const info = insertGate.run(attemptId, gate.id, gate.status, gate.mandatory ? 1 : 0, gate.durationMs, evidenceRef);
      gateIds.push(Number(info.lastInsertRowid));
    }
    return { taskId: input.taskId, attemptId, gateIds };
  });
  return run();
}

export interface RecordAttemptInput extends CostFields {
  taskId: string;
  engine: string;
  model?: string | null;
  effort?: string | null;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  providerPriceVersion?: string | null;
  policyVersion?: string | null;
}

/** Records an agent attempt with full cost-veracity discipline (task 2.5). */
export function recordAttempt(ledger: Ledger, input: RecordAttemptInput): number {
  validateCost(input, `attempt(task=${input.taskId}, engine=${input.engine})`);
  const info = ledger.db
    .prepare(
      `INSERT INTO attempts (task_id, engine, model, effort, status, started_at, ended_at,
                            input_tokens, output_tokens, cached_tokens, api_cost_usd,
                            cost_kind, provider_price_version, policy_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.engine,
      input.model ?? null,
      input.effort ?? null,
      input.status,
      input.startedAt,
      input.endedAt ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cachedTokens ?? null,
      input.apiCostUsd ?? null,
      input.costKind,
      input.providerPriceVersion ?? null,
      input.policyVersion ?? null,
    );
  return Number(info.lastInsertRowid);
}

export interface RecordReviewInput {
  taskId: string;
  reviewerType: string;
  accepted?: boolean | null;
  durationSeconds?: number | null;
  /** Aggregated summary only — never raw diffs or source fragments. */
  changesRequested?: string | null;
  observedAt: string;
}

/** Records a human or independent review event, separate from gate status. */
export function recordReview(ledger: Ledger, input: RecordReviewInput): number {
  const info = ledger.db
    .prepare(
      `INSERT INTO reviews (task_id, reviewer_type, accepted, duration_seconds, changes_requested, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.reviewerType,
      input.accepted === undefined || input.accepted === null ? null : input.accepted ? 1 : 0,
      input.durationSeconds ?? null,
      input.changesRequested ?? null,
      input.observedAt,
    );
  return Number(info.lastInsertRowid);
}

export interface RecordRegressionInput extends CostFields {
  taskId: string;
  discoveredAt: string;
  severity?: string | null;
  relatedTaskId?: string | null;
}

export function recordRegression(ledger: Ledger, input: RecordRegressionInput): number {
  validateCost(input, `regression(task=${input.taskId})`);
  const info = ledger.db
    .prepare(
      `INSERT INTO regressions (task_id, discovered_at, severity, related_task_id, repair_cost_usd, cost_kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.discoveredAt,
      input.severity ?? null,
      input.relatedTaskId ?? null,
      input.apiCostUsd ?? null,
      input.costKind,
    );
  return Number(info.lastInsertRowid);
}

export interface RecordBenchRunInput {
  scenarioId: string;
  variant: string;
  seed?: number | null;
  baseCommit?: string | null;
  startedAt: string;
  endedAt?: string | null;
}

export function recordBenchRun(ledger: Ledger, input: RecordBenchRunInput): number {
  const info = ledger.db
    .prepare(
      `INSERT INTO bench_runs (scenario_id, variant, seed, base_commit, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.scenarioId, input.variant, input.seed ?? null, input.baseCommit ?? null, input.startedAt, input.endedAt ?? null);
  return Number(info.lastInsertRowid);
}

export const EXPORTABLE_TABLES = ['tasks', 'attempts', 'gates', 'reviews', 'regressions', 'bench_runs'] as const;

/**
 * Task 2.4: JSONL export — one file per table. Rows contain structured
 * fields only (identifiers, statuses, durations, token/cost numbers); no
 * raw source code or secrets exist in the schema, satisfying the
 * evaluation-ledger "Protect training data" requirement by construction.
 */
export function exportJsonl(ledger: Ledger, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const table of EXPORTABLE_TABLES) {
    const rows = ledger.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const fileName = join(outDir, `${table}.jsonl`);
    const content = rows.map((row) => JSON.stringify(row)).join('\n');
    writeFileSync(fileName, content.length > 0 ? `${content}\n` : '', 'utf8');
    written.push(fileName);
  }
  return written;
}
