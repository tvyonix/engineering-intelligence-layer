import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/apps/cli/main.js';
import { runAccept, runMetrics } from '../../src/apps/cli/context-commands.js';
import { openLedger, closeLedger } from '../../src/packages/ledger/db.js';
import {
  createFixtureRepo,
  destroyFixtureRepo,
  minimalPolicyYaml,
  type FixtureRepo,
} from '../helpers/fixture-repo.js';

describe('human acceptance event + metrics (tasks 5.4 + 5.5)', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/app.ts', 'export const app = 1;\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  async function seedTaskWithCheck(dbPath: string, taskId: string): Promise<void> {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, `${taskId}.task.yaml`);
    await writeFile(
      taskPath,
      `version: 1
id: ${taskId}
baseCommit: "${baseCommit}"
description: "x"
scope:
  allow:
    - "src/**"
  protect: []
acceptance:
  - id: u
    description: "x"
policy:
  maxAttempts: 1
  noNewDependencies: false
`,
      'utf8',
    );
    const policyPath = join(repo.parent, 'policy.yaml');
    await writeFile(policyPath, minimalPolicyYaml(['path-scope']), 'utf8');
    await repo.writeFile(`src/${taskId}.ts`, 'export const x = 1;\n');
    const check = await runCheck({
      repo: repo.root,
      task: taskPath,
      policy: policyPath,
      out: join(repo.parent, `ev-${taskId}`),
      ledger: dbPath,
      quiet: true,
    });
    expect(check.exitCode).toBe(0);
  }

  it('gates passing leaves needs_review; accept records the human event and flips status', async () => {
    const dbPath = join(repo.parent, 'accept.db');
    await seedTaskWithCheck(dbPath, 'accept-task');

    const ledgerBefore = openLedger(dbPath);
    const statusBefore = (ledgerBefore.db.prepare('SELECT status FROM tasks WHERE id = ?').get('accept-task') as Record<string, unknown>)?.status;
    closeLedger(ledgerBefore);
    expect(statusBefore).toBe('needs_review'); // gates passed but NOT accepted

    const missing = await runAccept({ db: dbPath, task: 'no-such-task', reviewer: 'human:alice' });
    expect(missing.exitCode).toBe(2);

    const accepted = await runAccept({
      db: dbPath,
      task: 'accept-task',
      reviewer: 'human:alice',
      durationSeconds: 1200,
      changesRequested: '1 nit resolved before acceptance',
    });
    expect(accepted.exitCode).toBe(0);
    const payload = JSON.parse(accepted.json as string);
    expect(payload.status).toBe('accepted');
    expect(payload.previousStatus).toBe('needs_review');

    const ledger = openLedger(dbPath);
    try {
      const task = ledger.db.prepare('SELECT status FROM tasks WHERE id = ?').get('accept-task') as Record<string, unknown>;
      expect(task?.status).toBe('accepted');
      const review = ledger.db.prepare('SELECT * FROM reviews WHERE task_id = ?').get('accept-task') as Record<string, unknown>;
      expect(review?.accepted).toBe(1);
      expect(review?.reviewer_type).toBe('human:alice');
      expect(review?.duration_seconds).toBe(1200);
    } finally {
      closeLedger(ledger);
    }
  });

  it('rejection records accepted=0 and sets status rejected', async () => {
    const dbPath = join(repo.parent, 'reject.db');
    await seedTaskWithCheck(dbPath, 'reject-task');
    const rejected = await runAccept({ db: dbPath, task: 'reject-task', reviewer: 'human:bob', rejected: true, changesRequested: 'scope creep' });
    expect(rejected.exitCode).toBe(0);
    const payload = JSON.parse(rejected.json as string);
    expect(payload.status).toBe('rejected');
    const ledger = openLedger(dbPath);
    try {
      const review = ledger.db.prepare('SELECT accepted, changes_requested FROM reviews WHERE task_id = ?').get('reject-task') as Record<string, unknown>;
      expect(review?.accepted).toBe(0);
      expect(review?.changes_requested).toBe('scope creep');
    } finally {
      closeLedger(ledger);
    }
  });

  it('metrics: CPAT unavailable before acceptance, becomes a value after; honest counters', async () => {
    const dbPath = join(repo.parent, 'metrics.db');
    await seedTaskWithCheck(dbPath, 'metric-task');

    const before = await runMetrics({ db: dbPath });
    expect(before.exitCode).toBe(0);
    const beforeMetrics = JSON.parse(before.json as string);
    expect(beforeMetrics.costPerAcceptedTask.available).toBe(false);
    expect(beforeMetrics.counters.acceptedTasks).toBe(0);

    const accepted = await runAccept({ db: dbPath, task: 'metric-task', reviewer: 'human:carol' });
    expect(accepted.exitCode).toBe(0);

    const after = await runMetrics({ db: dbPath });
    const afterMetrics = JSON.parse(after.json as string);
    expect(afterMetrics.costPerAcceptedTask.available).toBe(true);
    // The only attempt is the eil-check verification (no model cost) — the
    // known sum is 0 and it is NOT presented as an unknown-attempt penalty:
    // verification attempts carry no model cost by design.
    expect(afterMetrics.costPerAcceptedTask.valueUsd).toBe(0);
    expect(afterMetrics.counters.acceptedTasks).toBe(1);

    const md = await runMetrics({ db: dbPath, format: 'markdown' });
    expect(md.json as string).toContain('# EIL metrics');
    expect(md.json as string).toContain('never substituted with zeros');
  });
});
