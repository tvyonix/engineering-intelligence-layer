import { readFile, symlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/apps/cli/main.js';
import { evidenceBundleSchema } from '../../src/packages/evidence/bundle.js';
import {
  baseTaskYaml,
  createFixtureRepo,
  destroyFixtureRepo,
  minimalPolicyYaml,
  type FixtureRepo,
} from '../helpers/fixture-repo.js';

describe('eil check (integration on real fixture repos)', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/app.ts', 'export const app = 1;\n');
    await repo.writeFile('.github/workflows/ci.yml', 'name: ci\n');
    await repo.writeFile('package.json', '{"name":"fixture","version":"0.0.0"}\n');
    await repo.writeFile('package-lock.json', '{"lockfileVersion":3}\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  async function writeTask(baseCommit: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(taskPath, baseTaskYaml(baseCommit, overrides), 'utf8');
    return taskPath;
  }

  async function writePolicy(required: string[]): Promise<string> {
    const policyPath = join(repo.parent, 'policy.yaml');
    await writeFile(policyPath, minimalPolicyYaml(required), 'utf8');
    return policyPath;
  }

  async function readBundle(evidenceDir: string) {
    const raw = await readFile(join(evidenceDir, 'evidence.json'), 'utf8');
    return evidenceBundleSchema.parse(JSON.parse(raw));
  }

  it('happy path: change inside allow scope passes mandatory gates and yields needs_review (exit 0)', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask(baseCommit);
    const policyPath = await writePolicy(['path-scope', 'dependency-policy']);
    await repo.writeFile('src/feature.ts', 'export const feature = 2;\n'); // untracked, inside allow

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });

    expect(out.exitCode).toBe(0);
    expect(out.evidenceDir).not.toBeNull();
    const bundle = await readBundle(out.evidenceDir as string);
    expect(bundle.verdict).toBe('needs_review');
    expect(bundle.mode).toBe('check-only');
    expect(bundle.humanAccepted).toBeUndefined();
    expect(bundle.estimatedUsd).toBeUndefined();
    expect(bundle.acceptanceCommandsExecuted).toBe(false);
    expect(bundle.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const pathScope = bundle.gateResults.find((g) => g.id === 'path-scope');
    expect(pathScope?.status).toBe('pass');

    // Not-applicable gate is explicitly marked with a provable reason (task 0.6).
    const depPolicy = bundle.gateResults.find((g) => g.id === 'dependency-policy');
    expect(depPolicy?.status).toBe('not_applicable');
    expect(depPolicy?.reason).toContain('no package manifest or lockfile');

    // Evidence artifacts exist on disk.
    await expect(readFile(join(out.evidenceDir as string, 'summary.md'), 'utf8')).resolves.toContain('needs_review');
    await expect(readFile(join(out.evidenceDir as string, 'logs', 'diff.patch'), 'utf8')).resolves.toContain('feature.ts');
  });

  it('forbidden path: change touching a protected path is blocked (exit 1) with a new violation', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask(baseCommit);
    const policyPath = await writePolicy(['path-scope']);
    await repo.writeFile('.github/workflows/ci.yml', 'name: ci\non: [push]\njobs: {}\n'); // protected

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });

    expect(out.exitCode).toBe(1);
    const bundle = await readBundle(out.evidenceDir as string);
    expect(bundle.verdict).toBe('blocked');
    expect(bundle.gateResults.find((g) => g.id === 'path-scope')?.status).toBe('fail');
    expect(bundle.policyViolations).toHaveLength(1);
    expect(bundle.policyViolations[0]?.rule).toBe('protected-path');
    expect(bundle.policyViolations[0]?.classification).toBe('new');
    expect(bundle.policyViolations[0]?.path).toBe('.github/workflows/ci.yml');
  });

  it('overlapping contract (allow covers protect) is valid; the protected change is caught at runtime', async () => {
    // TL decision: overlap is a warning; runtime protect > allow catches the
    // actual change touching the protected file (exit 1).
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: fixture-task
baseCommit: "${baseCommit}"
description: "Contract whose allow covers a protected area"
scope:
  allow:
    - "**"
  protect:
    - ".github/workflows/**"
acceptance:
  - id: unit
    description: "x"
policy:
  maxAttempts: 2
  noNewDependencies: true
`,
      'utf8',
    );
    await writeFile(join(repo.parent, 'policy.yaml'), minimalPolicyYaml(['path-scope']), 'utf8');
    await repo.writeFile('.github/workflows/ci.yml', 'name: ci\njobs: {}\n');

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: join(repo.parent, 'policy.yaml'), quiet: true });
    expect(out.exitCode).toBe(1);
    expect(out.messages.some((m) => m.includes('scope overlap'))).toBe(true);
    const bundle = await readBundle(out.evidenceDir as string);
    expect(bundle.policyViolations[0]?.rule).toBe('protected-path');
    expect(bundle.policyViolations[0]?.detail).toContain('protection takes precedence');
  });

  it('overlapping allow/protect contract now parses with a warning; bogus repo fails at repo check', async () => {
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: fixture-task
baseCommit: "deadbeef"
description: "Overlapping scope, no runtime access yet"
scope:
  allow:
    - "src/**"
  protect:
    - "src/secret.ts"
acceptance:
  - id: unit
    description: "x"
policy:
  maxAttempts: 2
  noNewDependencies: true
`,
      'utf8',
    );
    const out = await runCheck({
      repo: join(repo.parent, 'does-not-exist'),
      task: taskPath,
      quiet: true,
    });
    // Contract accepted (warning), execution proceeds to repository check.
    expect(out.messages.some((m) => m.includes('scope overlap'))).toBe(true);
    expect(
      out.messages.some((m) => m.includes('not a git repository') || m.includes('cannot run git')),
    ).toBe(true);
    expect(out.exitCode).toBe(2);
  });

  it('symlink escaping the repository root is rejected (task 0.3)', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask(baseCommit);
    const policyPath = await writePolicy(['path-scope']);
    await writeFile(repo.outsidePath('outside-secret.txt'), 'external\n', 'utf8');
    await mkdir(join(repo.root, 'src'), { recursive: true });
    await symlink(repo.outsidePath('outside-secret.txt'), join(repo.root, 'src', 'escape-link'));

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });

    expect(out.exitCode).toBe(1);
    const bundle = await readBundle(out.evidenceDir as string);
    const violation = bundle.policyViolations.find((v) => v.rule === 'symlink-escape');
    expect(violation).toBeDefined();
    expect(violation?.path).toBe('src/escape-link');
  });

  it('untracked symlink with broken target fails closed', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask(baseCommit);
    const policyPath = await writePolicy(['path-scope']);
    await symlink(join(repo.parent, 'deleted-target.bin'), join(repo.root, 'src', 'dangling-link'));

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(1);
    const bundle = await readBundle(out.evidenceDir as string);
    // Dangling symlink resolves to a non-existent path; realpath either fails
    // (unresolvable) or stays inside the tmp parent but outside the repo root.
    const rules = bundle.policyViolations.map((v) => v.rule);
    expect(rules).toContain('symlink-unresolvable');
  });

  it('missing results never mean success: required-but-unavailable gate yields error (exit 2)', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask(baseCommit);
    // Default policy (no --policy) requires types/lint/tests. Host execution
    // is denied by default (repo not vetted, no sandbox yet): the check must
    // fail closed and say exactly why.
    await repo.writeFile('src/feature.ts', 'export const feature = 2;\n');

    const out = await runCheck({ repo: repo.root, task: taskPath, quiet: true });

    expect(out.exitCode).toBe(2);
    const bundle = await readBundle(out.evidenceDir as string);
    expect(bundle.verdict).toBe('error');
    const testsGate = bundle.gateResults.find((g) => g.id === 'tests');
    expect(testsGate?.status).toBe('error');
    expect(testsGate?.mandatory).toBe(true);
    expect(testsGate?.reason).toContain('execution_not_permitted');
  });

  it('unknown required gate id in policy is reported as error, not silently skipped', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask(baseCommit);
    const policyPath = await writePolicy(['path-scope', 'mystery-gate']);

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(2);
    const bundle = await readBundle(out.evidenceDir as string);
    const mystery = bundle.gateResults.find((g) => g.id === 'mystery-gate');
    expect(mystery?.status).toBe('error');
    expect(mystery?.reason).toContain('unknown_gate');
  });

  it('base commit override via --base is recorded in the bundle', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask('refs/heads/nonexistent-ref');
    const policyPath = await writePolicy(['path-scope']);
    await repo.writeFile('src/feature.ts', 'export const feature = 2;\n');

    // Without override: task's baseCommit does not resolve → error.
    const badOut = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(badOut.exitCode).toBe(2);
    expect(badOut.messages.some((m) => m.includes('does not resolve'))).toBe(true);

    // With --base override: passes and records the override source.
    const goodOut = await runCheck({ repo: repo.root, task: taskPath, base: baseCommit, policy: policyPath, quiet: true });
    expect(goodOut.exitCode).toBe(0);
    const bundle = await readBundle(goodOut.evidenceDir as string);
    expect(bundle.baseCommitSource).toBe('cli-override');
    expect(bundle.baseCommit).toBe(baseCommit);
  });

  it('baseline context: protected path already touched by the base commit is reported separately (task 0.5)', async () => {
    // Base commit itself modifies the protected workflow file.
    await repo.writeFile('.github/workflows/ci.yml', 'name: ci\non: [push]\n');
    repo.commitAll('base touches protected path');
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask(baseCommit);
    const policyPath = await writePolicy(['path-scope']);
    // Current change touches the same protected path again.
    await repo.writeFile('.github/workflows/ci.yml', 'name: ci\non: [push, pull_request]\n');

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });

    expect(out.exitCode).toBe(1);
    const bundle = await readBundle(out.evidenceDir as string);
    expect(bundle.policyViolations[0]?.classification).toBe('new');
    const context = bundle.baselineContext.find((v) => v.rule === 'protected-path-in-baseline');
    expect(context).toBeDefined();
    expect(context?.path).toBe('.github/workflows/ci.yml');
  });

  it('invalid task YAML is rejected with issues listed', async () => {
    const taskPath = join(repo.parent, 'broken.yaml');
    await writeFile(taskPath, 'version: 1\nid: BAD ID!\n', 'utf8');
    const out = await runCheck({ repo: repo.root, task: taskPath, quiet: true });
    expect(out.exitCode).toBe(2);
    expect(out.messages.some((m) => m.includes('task contract is invalid'))).toBe(true);
  });

  it('rename of a tracked file is checked for both source and destination paths', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = await writeTask(baseCommit);
    const policyPath = await writePolicy(['path-scope']);
    // Rename tracked src/app.ts (inside allow) to a protected path.
    repo.git('mv', 'src/app.ts', '.github/workflows/renamed.yml');

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(1);
    const bundle = await readBundle(out.evidenceDir as string);
    const paths = bundle.policyViolations.map((v) => v.path);
    // Destination lands in a protected area; the origin is inside the allow
    // scope and is not a violation.
    expect(paths).toContain('.github/workflows/renamed.yml');
    expect(paths).not.toContain('src/app.ts');
  });
});
