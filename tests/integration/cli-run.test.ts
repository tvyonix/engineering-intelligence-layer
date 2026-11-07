import { writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/apps/cli/main.js';
import { createFixtureRepo, destroyFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo.js';

describe('eil run (task 3.6, scripted engine mode)', () => {
  let repo: FixtureRepo;
  let baseCommit: string;
  let taskPath: string;
  let policyPath: string;
  let outDir: string;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/app.ts', 'export const app = 1;\n');
    repo.commitAll('base');
    baseCommit = repo.git('rev-parse', 'HEAD').trim();
    taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: run-task
baseCommit: "${baseCommit}"
description: "CLI run task"
scope:
  allow:
    - "src/**"
  protect: []
acceptance:
  - id: u
    description: "x"
policy:
  maxAttempts: 3
  noNewDependencies: false
`,
      'utf8',
    );
    policyPath = join(repo.parent, 'policy.yaml');
    outDir = join(repo.parent, 'out');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  async function vettedPolicy(engineCommand: string): Promise<void> {
    const { realpath } = await import('node:fs/promises');
    await writeFile(
      policyPath,
      `version: 1
execution:
  vettedRepos:
    - "${await realpath(repo.root)}"
  timeoutMs: 30000
  engineCommand: ${JSON.stringify(engineCommand)}
  maxCheapRetries: 1
quality:
  required:
    - "path-scope"
    - "secrets-scan"
`,
      'utf8',
    );
  }

  it('happy path: engine command applies a change inside the workspace, gates pass, exit 0', async () => {
    await vettedPolicy('sh -c "echo \\"export const feature = 1;\\" > src/feature.ts"');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    const code = await main(['run', '--repo', repo.root, '--task', taskPath, '--policy', policyPath, '--out', outDir, '--ledger', join(repo.parent, 'run.db')]);
    vi.restoreAllMocks();

    expect(code).toBe(0);
    // The engine change lives in a discarded workspace, never in the source repo.
    expect(existsSync(join(repo.root, 'src', 'feature.ts'))).toBe(false);

    // Attempt evidence and the pipeline summary exist.
    const attemptEvidence = join(outDir, 'attempt-1', 'evidence.json');
    expect(existsSync(attemptEvidence)).toBe(true);
    const evidence = JSON.parse(readFileSync(attemptEvidence, 'utf8')) as { verdict: string; taskId: string };
    expect(evidence.taskId).toBe('run-task');
    expect(evidence.verdict).toBe('needs_review');

    // Ledger holds the scripted attempt (engine execution) + the check attempt.
    const { openLedger, closeLedger } = await import('../../src/packages/ledger/db.js');
    const ledger = await openLedger(join(repo.parent, 'run.db'));
    try {
      const attempts = ledger.db.prepare('SELECT engine, status, cost_kind FROM attempts ORDER BY id').all() as Record<string, unknown>[];
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(attempts.some((a) => a.engine === 'scripted' && a.status === 'complete')).toBe(true);
      expect(attempts.every((a) => a.cost_kind === 'unknown')).toBe(true);
      const task = ledger.db.prepare('SELECT status, risk FROM tasks WHERE id = ?').get('run-task') as Record<string, unknown>;
      expect(task?.status).toBe('needs_review');
      expect(task?.risk).toBe('low');
    } finally {
      closeLedger(ledger);
    }
  });

  it('unvetted repo: no engine attempts, exit 2, reason surfaced', async () => {
    await writeFile(
      policyPath,
      `version: 1
execution:
  vettedRepos: []
  engineCommand: "echo hi"
quality:
  required:
    - "path-scope"
`,
      'utf8',
    );
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errors.push(a.join(' ')));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(['run', '--repo', repo.root, '--task', taskPath, '--policy', policyPath, '--out', outDir]);
    vi.restoreAllMocks();
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('execution_not_permitted');
  });

  it('missing engineCommand is a clear configuration error', async () => {
    await writeFile(policyPath, `version: 1\nquality:\n  required:\n    - "path-scope"\n`, 'utf8');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errors.push(a.join(' ')));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(['run', '--repo', repo.root, '--task', taskPath, '--policy', policyPath, '--out', outDir]);
    vi.restoreAllMocks();
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('execution.engineCommand');
  });
});
