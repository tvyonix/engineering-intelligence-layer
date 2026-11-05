import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/apps/cli/main.js';
import { runImpact, runLedger, runReferences, runSymbols } from '../../src/apps/cli/context-commands.js';
import { openLedger, closeLedger, listAppliedMigrations } from '../../src/packages/ledger/db.js';
import { CHECK_ENGINE_ID } from '../../src/packages/ledger/records.js';
import {
  createFixtureRepo,
  destroyFixtureRepo,
  minimalPolicyYaml,
  type FixtureRepo,
} from '../helpers/fixture-repo.js';

describe('eil check --ledger + task record (tasks 2.4-2.6)', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/app.ts', 'export const app = 1;\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  it('records the check run into the SQLite ledger and writes task-record.md', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: ledger-task
baseCommit: "${baseCommit}"
description: "Ledger integration task"
scope:
  allow:
    - "src/**"
  protect: []
acceptance:
  - id: unit
    description: "Behaviour covered"
    command: "npm test"
policy:
  maxAttempts: 2
  noNewDependencies: false
`,
      'utf8',
    );
    const policyPath = join(repo.parent, 'policy.yaml');
    await writeFile(policyPath, minimalPolicyYaml(['path-scope']), 'utf8');
    await repo.writeFile('src/feature.ts', 'export const feature = 2;\n');
    const dbPath = join(repo.parent, 'ledger.db');
    const evidenceDir = join(repo.parent, 'ev');

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, out: evidenceDir, ledger: dbPath, quiet: true });
    expect(out.exitCode).toBe(0);

    // Deterministic risk (4.1): single src file, no signals → low.
    const evidence = JSON.parse(await readFile(join(evidenceDir, 'evidence.json'), 'utf8'));
    expect(evidence.risk).toBe('low');

    const ledger = await openLedger(dbPath);
    try {
      expect(listAppliedMigrations(ledger).map((m) => m.name)).toContain('core-tables');
      const task = ledger.db.prepare('SELECT * FROM tasks WHERE id = ?').get('ledger-task') as Record<string, unknown>;
      expect(task?.status).toBe('needs_review');
      expect(task?.risk).toBe('low');
      const attempts = ledger.db.prepare('SELECT * FROM attempts').all() as Record<string, unknown>[];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.engine).toBe(CHECK_ENGINE_ID);
      expect(attempts[0]?.cost_kind).toBe('unknown');
      expect(attempts[0]?.api_cost_usd).toBeNull();
      const gates = ledger.db.prepare('SELECT gate_id, status, mandatory FROM gates').all() as Record<string, unknown>[];
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeLedger(ledger);
    }

    // Task Record (2.6).
    const taskRecord = await readFile(join(evidenceDir, 'task-record.md'), 'utf8');
    expect(taskRecord).toContain('# Task Record — ledger-task');
    expect(taskRecord).toContain('## Human acceptance');
    expect(taskRecord).toContain('not accepted');
    expect(taskRecord).toContain('Model API cost: unknown');
    expect(taskRecord).toContain('recorded, not executed in check mode');
  });

  it('risk classification surfaces in bundle, CLI and ledger (4.1)', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    // Auth path inside allow + security hint → high risk with no gate failure.
    await writeFile(
      taskPath,
      `version: 1
id: risk-task
baseCommit: "${baseCommit}"
description: "Auth change"
riskHints:
  - "touches session handling"
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
    await repo.writeFile('src/auth/login.ts', 'export const login = 1;\n');
    const dbPath = join(repo.parent, 'risk-ledger.db');
    const evidenceDir = join(repo.parent, 'ev-risk');

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, out: evidenceDir, ledger: dbPath, quiet: true });
    expect(out.exitCode).toBe(0); // gates pass; risk is orthogonal to the verdict
    const evidence = JSON.parse(await readFile(join(evidenceDir, 'evidence.json'), 'utf8'));
    expect(evidence.risk).toBe('high');
    expect(evidence.riskReasons.join('\n')).toContain('high-risk area: src/auth/login.ts');
    expect(evidence.riskReasons.join('\n')).toContain("risk hint elevates: 'touches session handling'");
    expect(out.messages.some((m) => m.includes('risk: high'))).toBe(true);

    const ledger = await openLedger(dbPath);
    try {
      const task = ledger.db.prepare('SELECT risk FROM tasks WHERE id = ?').get('risk-task') as Record<string, unknown>;
      expect(task?.risk).toBe('high');
    } finally {
      closeLedger(ledger);
    }

    // Protected path → blocked risk; the gate verdict stays the blocker.
    await writeFile(
      taskPath,
      `version: 1
id: risk-blocked
baseCommit: "${baseCommit}"
description: "Env change"
scope:
  allow:
    - "**"
  protect:
    - ".env*"
acceptance:
  - id: u
    description: "x"
policy:
  maxAttempts: 1
  noNewDependencies: false
`,
      'utf8',
    );
    await repo.writeFile('.env.local', 'SECRET=1\n');
    const blocked = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, out: join(repo.parent, 'ev-blocked'), ledger: dbPath, quiet: true });
    expect(blocked.exitCode).toBe(1);
    const blockedEvidence = JSON.parse(await readFile(join(repo.parent, 'ev-blocked', 'evidence.json'), 'utf8'));
    expect(blockedEvidence.risk).toBe('blocked');
    const ledger2 = await openLedger(dbPath);
    try {
      const task = ledger2.db.prepare('SELECT risk FROM tasks WHERE id = ?').get('risk-blocked') as Record<string, unknown>;
      expect(task?.risk).toBe('blocked');
    } finally {
      closeLedger(ledger2);
    }
  });

  it('ledger write failure does not change the check verdict', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: broken-ledger
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
    // A directory where the DB file should be → sqlite open fails.
    const dbPath = join(repo.parent, 'ledger-blocker');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dbPath, { recursive: true });

    const out = await runCheck({
      repo: repo.root,
      task: taskPath,
      policy: policyPath,
      out: join(repo.parent, 'ev2'),
      ledger: dbPath,
      quiet: true,
    });
    expect(out.exitCode).toBe(0);
    expect(out.messages.some((m) => m.includes('ledger write failed'))).toBe(true);
  });
});

describe('eil context commands (tasks 2.1-2.3)', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/lib.ts', 'export function target(): number { return 1; }\n');
    await repo.writeFile('src/use.ts', 'import { target } from "./lib";\nexport const used = target();\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  it('symbols returns declarations JSON', async () => {
    const out = await runSymbols({ repo: repo.root, file: 'src/lib.ts' });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.json as string);
    expect(parsed.file).toBe('src/lib.ts');
    expect(parsed.declarations.some((d: { name: string }) => d.name === 'target')).toBe(true);
  });

  it('references returns exact coordinates and import references', async () => {
    const out = await runReferences({ repo: repo.root, file: 'src/lib.ts', name: 'target' });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.json as string);
    expect(parsed.declaration?.file).toBe('src/lib.ts');
    expect(parsed.references.some((r: { file: string; lineText: string }) => r.file === 'src/use.ts' && r.lineText.includes('import'))).toBe(true);
  });

  it('impact reports affected files with honest completeness', async () => {
    await repo.writeFile('src/core.ts', 'export const core = 1;\n');
    await repo.writeFile('src/depends-core.ts', 'import { core } from "./core";\nexport const d = core;\n');
    repo.commitAll('core');
    await repo.writeFile('src/core.ts', 'export const core = 2;\n');
    const head = repo.git('rev-parse', 'HEAD').trim();
    const out = await runImpact({ repo: repo.root, base: head });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.json as string);
    expect(parsed.changedFiles).toEqual(['src/core.ts']);
    expect(parsed.affectedFiles).toContain('src/depends-core.ts');
    expect(parsed.completeness).toBe('static-import-analysis');
  });

  it('refuses to follow a symlink escaping the repo (symbols)', async () => {
    const { symlink, writeFile: wf } = await import('node:fs/promises');
    await wf(repo.outsidePath('outside.ts'), 'export const o = 1;\n', 'utf8');
    await symlink(repo.outsidePath('outside.ts'), join(repo.root, 'src/escape.ts'));
    const out = await runSymbols({ repo: repo.root, file: 'src/escape.ts' });
    expect(out.exitCode).toBe(2);
    expect(out.messages.join('\n')).toContain('escapes the repository root');
  });

  it('ledger init and export work end to end', async () => {
    const dbPath = join(repo.parent, 'cli-ledger.db');
    const init = await runLedger({ action: 'init', db: dbPath });
    expect(init.exitCode).toBe(0);
    expect(existsSync(dbPath)).toBe(true);

    // Seed through a check run.
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: cli-ledger-task
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
    await repo.writeFile('src/feature.ts', 'export const f = 3;\n');
    await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, out: join(repo.parent, 'ev3'), ledger: dbPath, quiet: true });

    const exportDir = join(repo.parent, 'export');
    const exp = await runLedger({ action: 'export', db: dbPath, out: exportDir });
    expect(exp.exitCode).toBe(0);
    const attempts = readFileSync(join(exportDir, 'attempts.jsonl'), 'utf8').trim().split('\n');
    expect(attempts.length).toBe(1);
    expect(JSON.parse(attempts[0] as string).engine).toBe(CHECK_ENGINE_ID);

    const unknown = await runLedger({ action: 'vacuum', db: dbPath });
    expect(unknown.exitCode).toBe(2);
  });
});
