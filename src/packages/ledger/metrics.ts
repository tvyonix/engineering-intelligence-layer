import type { Ledger } from './db.js';

/**
 * Task 5.4 — metric honesty (design.md §11, evolution-benchmark spec).
 *
 * Rules implemented here:
 * - Costs are summed ONLY from attempts/repairs with cost_kind
 *   'billed' | 'estimated'. Attempts with 'unknown' cost contribute no
 *   number but ARE counted — a value computed while unknowns exist is
 *   reported as a lower bound, never as the true cost, and never as 0.
 * - Cost per Accepted Task with zero human-accepted tasks is UNAVAILABLE —
 *   it is never divided by a fabricated unit.
 * - Verification attempts by the eil-check engine carry no model cost and
 *   are excluded from cost sums (they would only add unknown noise).
 * - Tests passing never equals acceptance: acceptance comes only from
 *   review rows (task 5.5).
 */

export interface MetricValue {
  available: boolean;
  reason?: string;
  valueUsd?: number;
  /** true when the value excludes unknown-cost attempts (true cost is higher). */
  lowerBound?: boolean;
  /** Attempts/repairs with unknown cost excluded from the numeric sum. */
  unknownCount?: number;
  notes: string[];
}

export interface RecStepRatio {
  step: number;
  controlUsd: number | null;
  variantUsd: number | null;
  ratio: number | null;
}

export interface RelativeEvolutionCost {
  available: boolean;
  reason?: string;
  value?: number;
  perStep: RecStepRatio[];
  notes: string[];
}

export interface RegressionTaxMetric {
  available: boolean;
  reason?: string;
  value?: number;
  attributedRepairUsd?: number;
  totalChangeUsd?: number;
  unattributedCount?: number;
  lowerBound?: boolean;
  unknownCount?: number;
  notes: string[];
}

export interface BenchMetrics {
  costPerAcceptedTask: MetricValue;
  cascadeWaste: MetricValue;
  relativeEvolutionCost: RelativeEvolutionCost;
  regressionTax: RegressionTaxMetric;
  /** Counters used to render the honesty section. */
  counters: {
    acceptedTasks: number;
    attemptsTotal: number;
    attemptsUnknownCost: number;
  };
}

interface CostRow {
  api_cost_usd: number | null;
  cost_kind: string;
}

function sumKnownCosts(rows: CostRow[]): { knownUsd: number; unknownCount: number } {
  let knownUsd = 0;
  let unknownCount = 0;
  for (const row of rows) {
    if (row.cost_kind === 'unknown' || row.api_cost_usd === null || row.api_cost_usd === undefined) {
      unknownCount += 1;
      continue;
    }
    knownUsd += row.api_cost_usd;
  }
  return { knownUsd, unknownCount };
}

/** Model-attempt cost rows for a task (excludes the eil-check engine: no model cost). */
function attemptCostRows(ledger: Ledger, taskId: string): CostRow[] {
  return ledger.db
    .prepare(
      `SELECT api_cost_usd, cost_kind FROM attempts
       WHERE task_id = ? AND engine != 'eil-check'`,
    )
    .all(taskId) as CostRow[];
}

interface AcceptedTaskRow {
  id: string;
}

/**
 * A task is accepted only if its LATEST review accepted it — accept-then-
 * reject must not leave the task counted as accepted (1.7 review).
 */
function acceptedTaskIds(ledger: Ledger): string[] {
  const rows = ledger.db
    .prepare(
      `SELECT task_id AS id FROM reviews r
       WHERE observed_at = (
         SELECT MAX(r2.observed_at) FROM reviews r2 WHERE r2.task_id = r.task_id
       ) AND accepted = 1`,
    )
    .all() as AcceptedTaskRow[];
  return rows.map((r) => r.id);
}

/** Cost per Accepted Task = sum(attempt + verification API costs) / accepted count. */
export function costPerAcceptedTask(ledger: Ledger): MetricValue {
  const accepted = acceptedTaskIds(ledger);
  const notes: string[] = [];
  if (accepted.length === 0) {
    return {
      available: false,
      reason: 'no human-accepted tasks yet (acceptance is a review event, not a gate result); the metric is not divided by a fabricated unit',
      notes,
    };
  }
  let knownUsd = 0;
  let unknownCount = 0;
  for (const taskId of accepted) {
    const sums = sumKnownCosts(attemptCostRows(ledger, taskId));
    knownUsd += sums.knownUsd;
    unknownCount += sums.unknownCount;
  }
  if (knownUsd === 0 && unknownCount > 0) {
    return {
      available: false,
      reason: 'no measured costs at all (every attempt is unknown-cost): an unknown-only sum is not presented as $0 (1.7 review)',
      notes,
    };
  }
  if (unknownCount > 0) {
    notes.push(`${unknownCount} attempt(s) with unknown cost are excluded from the numeric sum — the true value is at least this number`);
  }
  return {
    available: true,
    valueUsd: knownUsd / accepted.length,
    ...(unknownCount > 0 ? { lowerBound: true as const, unknownCount } : {}),
    notes,
  };
}

/**
 * Cascade Waste = sum(costs of attempts that did not produce the accepted
 * artifact). Not a counterfactual routing regret: paired alternative
 * executions would be required for that (design.md §11).
 */
export function cascadeWaste(ledger: Ledger): MetricValue {
  const accepted = new Set(acceptedTaskIds(ledger));
  const notes: string[] = [];

  // The accepted artifact is produced by the LAST complete attempt of an
  // accepted task; every other attempt is waste.
  const attempts = ledger.db
    .prepare(
      `SELECT id, task_id, api_cost_usd, cost_kind, status, engine FROM attempts ORDER BY id`,
    )
    .all() as { id: number; task_id: string; api_cost_usd: number | null; cost_kind: string; status: string; engine: string }[];

  const lastCompleteByTask = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.engine === 'eil-check') continue;
    if (accepted.has(attempt.task_id) && attempt.status === 'complete') {
      lastCompleteByTask.set(attempt.task_id, attempt.id);
    }
  }

  const wasteRows: CostRow[] = [];
  for (const attempt of attempts) {
    if (attempt.engine === 'eil-check') continue;
    if (accepted.has(attempt.task_id) && lastCompleteByTask.get(attempt.task_id) === attempt.id) continue;
    wasteRows.push({ api_cost_usd: attempt.api_cost_usd, cost_kind: attempt.cost_kind });
  }
  if (attempts.length === 0) {
    return { available: false, reason: 'empty ledger: no attempts recorded, waste is undefined rather than zero (1.7 review)', notes };
  }
  const { knownUsd, unknownCount } = sumKnownCosts(wasteRows);
  if (knownUsd === 0 && unknownCount > 0) {
    return {
      available: false,
      reason: 'all wasted attempts have unknown cost: an unknown-only waste is not presented as $0 (1.7 review)',
      notes,
    };
  }
  if (unknownCount > 0) {
    notes.push(`${unknownCount} wasted attempt(s) have unknown cost and are excluded from the numeric sum — the true waste is at least this number`);
  }
  if (wasteRows.length === 0) {
    notes.push('no non-accepted attempts recorded yet');
  }
  notes.push('cascade waste is not a counterfactual routing regret: paired alternative executions would be required for that');
  return {
    available: true,
    valueUsd: knownUsd,
    ...(unknownCount > 0 ? { lowerBound: true as const, unknownCount } : {}),
    notes,
  };
}

/**
 * Relative Evolution Cost (design.md §11): REC_k = C_EIL,k / C_control,k for
 * the same requirement and comparable start state. Requires measured costs
 * on BOTH sides per step; missing costs keep that step's ratio unavailable.
 */
export function relativeEvolutionCost(
  ledger: Ledger,
  options: { scenario: string; variant: string; control: string },
): RelativeEvolutionCost {
  const notes: string[] = [];
  const steps = ledger.db
    .prepare(
      `SELECT id FROM tasks WHERE type = 'bench-step' AND id LIKE ? ORDER BY id`,
    )
    .all(`${options.scenario}__%`) as { id: string }[];
  const stepNumbers = [...new Set(steps.map((row) => Number(row.id.split('__step-')[1])))].sort((a, b) => a - b);

  if (stepNumbers.length === 0) {
    return {
      available: false,
      reason: `no bench steps found for scenario '${options.scenario}'`,
      perStep: [],
      notes,
    };
  }

  const perStep: RecStepRatio[] = [];
  let controlTotal = 0;
  let variantTotal = 0;
  let complete = true;
  for (const step of stepNumbers) {
    const controlRows = attemptCostRows(ledger, benchTaskId(options.scenario, options.control, step));
    const variantRows = attemptCostRows(ledger, benchTaskId(options.scenario, options.variant, step));
    const controlSums = sumKnownCosts(controlRows);
    const variantSums = sumKnownCosts(variantRows);
    const controlUnknown = controlSums.unknownCount > 0 || controlRows.length === 0;
    const variantUnknown = variantSums.unknownCount > 0 || variantRows.length === 0;
    const ratio =
      controlUnknown || variantUnknown ? null : controlSums.knownUsd === 0 ? null : variantSums.knownUsd / controlSums.knownUsd;
    if (ratio === null) complete = false;
    if (controlUnknown) notes.push(`step ${step}: control '${options.control}' has no measured cost — ratio unavailable`);
    if (variantUnknown) notes.push(`step ${step}: variant '${options.variant}' has no measured cost — ratio unavailable`);
    const controlMeasured = controlSums.knownUsd > 0 || (controlSums.unknownCount === 0 && controlRows.length > 0);
    const variantMeasured = variantSums.knownUsd > 0 || (variantSums.unknownCount === 0 && variantRows.length > 0);
    perStep.push({
      step,
      controlUsd: controlMeasured ? controlSums.knownUsd : null,
      variantUsd: variantMeasured ? variantSums.knownUsd : null,
      ratio,
    });
    controlTotal += controlMeasured ? controlSums.knownUsd : 0;
    variantTotal += variantMeasured ? variantSums.knownUsd : 0;
  }

  if (!complete) {
    return {
      available: false,
      reason: 'at least one step lacks measured costs on both sides; REC is unavailable rather than partially invented',
      perStep,
      notes,
    };
  }
  if (controlTotal === 0) {
    return {
      available: false,
      reason: 'control total cost is zero with measured rows; REC is undefined',
      perStep,
      notes,
    };
  }
  return { available: true, value: variantTotal / controlTotal, perStep, notes };
}

function benchTaskId(scenario: string, variant: string, step: number): string {
  return `${scenario}__${variant}__step-${step}`;
}

/**
 * Regression Tax (design.md §11): cost of repairing previous accepted
 * changes / total change cost, with attribution confidence reported.
 * Unattributed regressions (no related task) are excluded from the numeric
 * value and counted.
 */
export function regressionTax(ledger: Ledger, taskId?: string): RegressionTaxMetric {
  const notes: string[] = [];
  const repairs = (
    taskId !== undefined
      ? ledger.db.prepare(`SELECT repair_cost_usd, cost_kind, related_task_id, task_id FROM regressions WHERE task_id = ? OR related_task_id = ?`).all(taskId, taskId)
      : ledger.db.prepare(`SELECT repair_cost_usd, cost_kind, related_task_id, task_id FROM regressions`).all()
  ) as { repair_cost_usd: number | null; cost_kind: string; related_task_id: string | null; task_id: string }[];

  const attributed = repairs.filter((r) => r.related_task_id !== null || taskId !== undefined);
  const unattributedCount = repairs.length - attributed.length;
  if (repairs.length === 0) {
    return {
      available: false,
      reason: 'no regressions recorded yet — absence of data is not a zero tax',
      notes,
    };
  }
  if (attributed.length === 0) {
    return {
      available: false,
      reason: 'all recorded regressions are unattributed; the attributed tax is undefined rather than zero',
      unattributedCount,
      notes,
    };
  }
  const repairSums = sumKnownCosts(attributed.map((r) => ({ api_cost_usd: r.repair_cost_usd, cost_kind: r.cost_kind })));

  // Total change cost: attempts of the tasks the repairs are attributed to
  // (or the requested task).
  const taskIds = taskId !== undefined ? [taskId] : [...new Set(attributed.map((r) => r.related_task_id ?? r.task_id))];
  let totalChange = 0;
  let totalUnknown = 0;
  for (const id of taskIds) {
    const sums = sumKnownCosts(attemptCostRows(ledger, id));
    totalChange += sums.knownUsd;
    totalUnknown += sums.unknownCount;
  }

  if (unattributedCount > 0) {
    notes.push(`${unattributedCount} regression(s) have no related task and are excluded from the numeric value (attribution confidence: unattributed)`);
  }
  if (repairSums.unknownCount > 0 || totalUnknown > 0) {
    notes.push('unknown repair or change costs are excluded from the numeric value — the true tax differs');
  }
  if (totalChange === 0) {
    return {
      available: false,
      reason: 'attributed tasks have no measured change cost; the tax is undefined',
      attributedRepairUsd: repairSums.knownUsd,
      unattributedCount,
      notes,
    };
  }
  return {
    available: true,
    value: repairSums.knownUsd / totalChange,
    attributedRepairUsd: repairSums.knownUsd,
    totalChangeUsd: totalChange,
    unattributedCount,
    ...(repairSums.unknownCount > 0 || totalUnknown > 0
      ? {
          lowerBound: true as const,
          unknownCount: repairSums.unknownCount + totalUnknown,
        }
      : {}),
    notes,
  };
}

export function computeBenchMetrics(
  ledger: Ledger,
  options: { scenario?: string; variant?: string; control?: string } = {},
): BenchMetrics {
  const attempts = ledger.db.prepare('SELECT engine, cost_kind FROM attempts').all() as { engine: string; cost_kind: string }[];
  return {
    costPerAcceptedTask: costPerAcceptedTask(ledger),
    cascadeWaste: cascadeWaste(ledger),
    relativeEvolutionCost:
      options.scenario !== undefined && options.variant !== undefined
        ? relativeEvolutionCost(ledger, {
            scenario: options.scenario,
            variant: options.variant,
            control: options.control ?? 'A',
          })
        : {
            available: false,
            reason: 'scenario/variant not provided (pass --scenario and --variant, control defaults to A)',
            perStep: [],
            notes: [],
          },
    regressionTax: regressionTax(ledger),
    counters: {
      acceptedTasks: acceptedTaskIds(ledger).length,
      attemptsTotal: attempts.length,
      attemptsUnknownCost: attempts.filter((a) => a.cost_kind === 'unknown').length,
    },
  };
}

/** Human-readable honesty-first summary (markdown). */
export function renderMetricsMarkdown(metrics: BenchMetrics): string {
  const lines: string[] = [];
  lines.push('# EIL metrics');
  lines.push('');
  lines.push(
    `Counters: ${metrics.counters.acceptedTasks} accepted task(s), ${metrics.counters.attemptsTotal} attempt(s) (${metrics.counters.attemptsUnknownCost} with unknown cost).`,
  );
  lines.push('');
  const fmt = (m: MetricValue, name: string, extra: string[] = []) => {
    lines.push(`## ${name}`);
    if (!m.available) {
      lines.push(`- **UNAVAILABLE** — ${m.reason ?? 'missing data'}`);
    } else {
      const valueText = m.valueUsd !== undefined ? `$${m.valueUsd.toFixed(4)}` : 'unknown';
      const bound = m.lowerBound === true ? ' (lower bound — unknown-cost items excluded)' : '';
      lines.push(`- **${valueText}${bound}**`);
    }
    for (const note of [...extra, ...m.notes]) lines.push(`- ${note}`);
    lines.push('');
  };
  fmt(metrics.costPerAcceptedTask, 'Cost per Accepted Task');
  fmt(metrics.cascadeWaste, 'Cascade Waste (not a routing regret)');
  if (metrics.relativeEvolutionCost.available) {
    lines.push('## Relative Evolution Cost');
    lines.push(`- **${metrics.relativeEvolutionCost.value?.toFixed(3)}×** vs control`);
    for (const step of metrics.relativeEvolutionCost.perStep) {
      lines.push(
        `- step ${step.step}: control $${step.controlUsd?.toFixed(4)} / variant $${step.variantUsd?.toFixed(4)} → ratio ${step.ratio === null ? 'unavailable' : step.ratio.toFixed(3)}`,
      );
    }
  } else {
    lines.push('## Relative Evolution Cost');
    lines.push(`- **UNAVAILABLE** — ${metrics.relativeEvolutionCost.reason ?? 'missing data'}`);
  }
  for (const note of metrics.relativeEvolutionCost.notes) lines.push(`- ${note}`);
  lines.push('');
  const tax = metrics.regressionTax;
  lines.push('## Regression Tax');
  if (!tax.available) {
    lines.push(`- **UNAVAILABLE** — ${tax.reason ?? 'missing data'}`);
  } else {
    lines.push(`- **${(tax.value ?? 0).toFixed(3)}** (attributed repairs $${tax.attributedRepairUsd?.toFixed(4)} / change cost $${tax.totalChangeUsd?.toFixed(4)})`);
  }
  for (const note of tax.notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('Missing data is reported as unavailable or as an explicit lower bound — never substituted with zeros.');
  lines.push('');
  return lines.join('\n');
}
