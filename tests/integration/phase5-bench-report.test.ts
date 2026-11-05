import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/apps/cli/main.js';
import { runReport } from '../../src/apps/cli/context-commands.js';
import { openLedger, closeLedger } from '../../src/packages/ledger/db.js';
import { analyzeComparability, parseBenchmarkManifest } from '../../src/packages/benchmarks/manifest.js';
import { renderPrReport, buildPrReport } from '../../src/packages/evidence/pr-report.js';
import { createBeaverFixture, destroyBeaverFixture, BEAVER_STEPS, type BeaverFixture } from '../helpers/beaver-fixture.js';
import { evidenceBundleSchema } from '../../src/packages/evidence/bundle.js';
import {
  createFixtureRepo,
  destroyFixtureRepo,
  minimalPolicyYaml,
  type FixtureRepo,
} from '../helpers/fixture-repo.js';

describe('PR report (task 5.1)', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/app.ts', 'export const app = 1;\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  it('renders a self-contained PR summary from an evidence bundle', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: pr-task
baseCommit: "${baseCommit}"
description: "PR report task"
scope:
  allow:
    - "src/**"
  protect:
    - ".github/**"
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
    await repo.writeFile('.github/workflows/ci.yml', 'name: ci\njobs: {}\n'); // protected → blocked

    const check = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, out: join(repo.parent, 'ev'), quiet: true });
    expect(check.exitCode).toBe(1);

    const report = await runReport({ evidence: join(repo.parent, 'ev') });
    expect(report.exitCode).toBe(0);
    const text = report.json as string;
    expect(text).toContain('## EIL check: pr-task');
    expect(text).toContain('`blocked`');
    expect(text).toContain('cannot be accepted');
    expect(text).toContain('protected-path');
    expect(text).toContain('Human acceptance:** none recorded');
    expect(text).toContain('Model API cost:** unknown');
    // Self-contained: no absolute host paths leak into the report.
    expect(text).not.toContain('/private/var');
    expect(text).not.toContain('/var/folders');
    expect(text).not.toContain(repo.parent);
  });

  it('round-trips through the evidence schema and renders needs_review cleanly', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: ok-task
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
    await writeFile(join(repo.parent, 'policy.yaml'), minimalPolicyYaml(['path-scope']), 'utf8');
    await repo.writeFile('src/feature.ts', 'export const feature = 2;\n');
    await runCheck({ repo: repo.root, task: taskPath, policy: join(repo.parent, 'policy.yaml'), out: join(repo.parent, 'ev-ok'), quiet: true });
    const { bundle, report } = await buildPrReport(join(repo.parent, 'ev-ok'));
    expect(evidenceBundleSchema.parse(bundle).taskId).toBe('ok-task');
    expect(report).toContain('This is not acceptance');
    expect(renderPrReport(bundle)).toBe(report);
  });
});

describe('benchmark manifest (task 5.2)', () => {
  const validManifest = {
    version: 1,
    name: 'beaver-evolution-sample',
    repoFixture: 'fixtures/beaver-monitor',
    variants: [
      { id: 'A', agent: 'pi', model: 'zai/glm-5.3-flash', engineeringGates: false, adaptiveRouting: false },
      { id: 'B', agent: 'pi', model: 'zai/glm-5.3-flash', engineeringGates: true, adaptiveRouting: false },
    ],
    steps: [{ id: 1, task: 'Basic alerts table' }],
  };

  it('parses the example-shaped manifest', () => {
    const parsed = parseBenchmarkManifest(validManifest);
    expect(parsed.ok).toBe(true);
  });

  it('rejects duplicate variant ids and broken names', () => {
    const dup = parseBenchmarkManifest({
      ...validManifest,
      variants: [validManifest.variants[0], { ...validManifest.variants[0] }],
    });
    expect(dup.ok).toBe(false);

    const badName = parseBenchmarkManifest({ ...validManifest, name: 'BAD NAME!' });
    expect(badName.ok).toBe(false);
  });

  it('flags incomparable configurations instead of treating them causal', () => {
    const same = parseBenchmarkManifest(validManifest);
    if (!same.ok) throw new Error('unreachable');
    expect(analyzeComparability(same.manifest).comparable).toBe(true);

    const differing = parseBenchmarkManifest({
      ...validManifest,
      variants: [
        ...validManifest.variants,
        { id: 'C', agent: 'codex', model: 'gpt-x', engineeringGates: true, adaptiveRouting: true, command: 'node other-engine.mjs {step}' },
      ],
    });
    if (!differing.ok) throw new Error('unreachable');
    const report = analyzeComparability(differing.manifest);
    expect(report.comparable).toBe(false);
    expect(report.reasons.join('\n')).toContain('NOT causal');
    expect(Object.keys(report.fingerprints).sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('sequential benchmark runner + Beaver fixture (tasks 5.2 + 5.3)', () => {
  let fixture: BeaverFixture;

  beforeEach(async () => {
    fixture = await createBeaverFixture();
  });

  afterEach(async () => {
    await destroyBeaverFixture(fixture);
  });

  async function writeManifest(variants: unknown[], extra: Record<string, unknown> = {}): Promise<string> {
    const manifestPath = join(fixture.parent, 'bench.yaml');
    await writeFile(
      manifestPath,
      `version: 1
name: beaver-evolution
repoFixture: beaver-monitor
${'seed: 7\n'}variants:
${variants.map((v) => '  - ' + JSON.stringify(v)).join('\n')}
steps:
${BEAVER_STEPS.map((s) => `  - {"id": ${s.id}, "task": "${s.task}", "taskFile": "task.yaml", "policyFile": "policy.yaml"}`).join('\n')}
metrics:
  - cost_per_accepted_task
  - regression_tax
`,
      'utf8',
    );
    void extra;
    // task/policy resolved relative to the manifest directory.
    await writeFile(
      join(fixture.parent, 'task.yaml'),
      `version: 1
id: beaver-step
baseCommit: "${fixture.git('rev-parse', 'HEAD').trim()}"
description: "Sequential step"
scope:
  allow:
    - "src/**"
  protect: []
acceptance:
  - id: probe
    description: "Probe passes for steps 1..K"
    command: "node probe.mjs"
policy:
  maxAttempts: 1
  noNewDependencies: false
`,
      'utf8',
    );
    await writeFile(join(fixture.parent, 'policy.yaml'), minimalPolicyYaml(['path-scope']), 'utf8');
    return manifestPath;
  }

  it('executes command variants on a vetted fixture with regression re-checks and records the ledger', async () => {
    const manifestPath = await writeManifest([
      { id: 'B', agent: 'scripted', model: 'fixture', engineeringGates: true, adaptiveRouting: false, command: 'node bench-step.mjs {step}' },
      { id: 'C', agent: 'scripted', model: 'fixture', engineeringGates: true, adaptiveRouting: true, command: 'node bench-step.mjs {step}' },
    ]);
    // Vet the fixture repository for host execution.
    const { realpath } = await import('node:fs/promises');
    await writeFile(
      join(fixture.parent, 'bench-policy.yaml'),
      `version: 1
execution:
  vettedRepos:
    - "${await realpath(fixture.root)}"
  timeoutMs: 60000
quality:
  required:
    - "path-scope"
`,
      'utf8',
    );
    const dbPath = join(fixture.parent, 'bench.db');
    const { runBench } = await import('../../src/packages/benchmarks/runner.js');
    const result = await runBench({
      manifest: manifestPath,
      repo: fixture.root,
      out: join(fixture.parent, 'bench-out'),
      policy: join(fixture.parent, 'bench-policy.yaml'),
      ledger: dbPath,
      quiet: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).not.toBeNull();
    expect(result.summary?.comparable).toBe(true);
    expect(result.summary?.outcomes).toHaveLength(12); // 2 variants × 6 steps
    for (const outcome of result.summary?.outcomes ?? []) {
      expect(outcome.status, `${outcome.variant} step ${outcome.step}`).toBe('executed');
      expect(outcome.checkVerdict).toBe('needs_review');
      expect(outcome.checkExitCode).toBe(0);
    }

    const ledger = openLedger(dbPath);
    try {
      const benchRuns = ledger.db.prepare('SELECT * FROM bench_runs').all() as Record<string, unknown>[];
      expect(benchRuns).toHaveLength(2);
      expect(benchRuns.every((r) => r.base_commit !== null && r.variant !== null)).toBe(true);
      const attempts = ledger.db.prepare('SELECT * FROM attempts').all() as Record<string, unknown>[];
      // 2 variants × 6 steps, each with one check attempt? No: one bench attempt per step; check attempts come via runCheck without ledger.
      expect(attempts).toHaveLength(12);
      expect(attempts.every((a) => a.status === 'complete')).toBe(true);
      expect(attempts.every((a) => a.cost_kind === 'unknown' && a.api_cost_usd === null)).toBe(true);
      const tasks = ledger.db.prepare("SELECT * FROM tasks WHERE type = 'bench-step'").all();
      expect(tasks).toHaveLength(12);
    } finally {
      closeLedger(ledger);
    }
  });

  it('records honest pending attempts when no engine command is configured', async () => {
    const manifestPath = await writeManifest([
      { id: 'A', agent: 'pi', model: 'zai/glm-5.3-flash', engineeringGates: false, adaptiveRouting: false },
    ]);
    const dbPath = join(fixture.parent, 'bench.db');
    const { runBench } = await import('../../src/packages/benchmarks/runner.js');
    const result = await runBench({
      manifest: manifestPath,
      repo: fixture.root,
      out: join(fixture.parent, 'bench-out'),
      ledger: dbPath,
      quiet: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary?.outcomes).toHaveLength(6);
    for (const outcome of result.summary?.outcomes ?? []) {
      expect(outcome.status).toBe('pending');
      expect(outcome.notes.join(' ')).toContain('no engine command configured');
    }
    const ledger = openLedger(dbPath);
    try {
      const attempts = ledger.db.prepare('SELECT status FROM attempts').all() as Record<string, unknown>[];
      expect(attempts.every((a) => a.status === 'pending')).toBe(true);
    } finally {
      closeLedger(ledger);
    }
  });

  it('fails honestly when a command variant is not permitted (unvetted repo)', async () => {
    const manifestPath = await writeManifest([
      { id: 'B', agent: 'scripted', model: 'fixture', engineeringGates: true, adaptiveRouting: false, command: 'node bench-step.mjs {step}' },
    ]);
    const { runBench } = await import('../../src/packages/benchmarks/runner.js');
    const result = await runBench({
      manifest: manifestPath,
      repo: fixture.root,
      out: join(fixture.parent, 'bench-out'),
      quiet: true,
    }); // default policy: no execution grants
    expect(result.exitCode).toBe(1);
    for (const outcome of result.summary?.outcomes ?? []) {
      expect(outcome.status).toBe('failed');
      expect(outcome.notes.join(' ')).toContain('execution_not_permitted');
    }
  });
});
