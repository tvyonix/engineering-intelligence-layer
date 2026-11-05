import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/apps/cli/main.js';
import { evidenceBundleSchema } from '../../src/packages/evidence/bundle.js';
import {
  createFixtureRepo,
  destroyFixtureRepo,
  type FixtureRepo,
} from '../helpers/fixture-repo.js';

/**
 * Phase 1 integration tests.
 *
 * Host command execution is denied by default; every command test here runs
 * inside a fixture repo explicitly vetted by realpath in the policy, with
 * operator-supplied commands pointing at EIL's own toolchain (no npm
 * installs inside fixtures, no network).
 */
describe('eil check — command gates (types/lint/tests) with execution policy', () => {
  let repo: FixtureRepo;
  let vettedRoot: string;
  let eilBin: string;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    vettedRoot = await realpath(repo.root);
    eilBin = resolve(process.cwd(), 'node_modules', '.bin');
    await repo.writeFile('package.json', '{\n  "name": "fixture",\n  "version": "0.0.0"\n}\n');
    await repo.writeFile('tsconfig.json', '{\n  "compilerOptions": {\n    "strict": true,\n    "noEmit": true\n  }\n}\n');
    await repo.writeFile('eslint.config.mjs', "export default [\n  { rules: { 'no-console': 'error' } },\n];\n");
    await repo.writeFile('src/good.ts', 'export const good: number = 1;\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  function policyYaml(opts: {
    required: string[];
    commands?: Record<string, string>;
    timeoutMs?: number;
    approvedFiles?: string[];
    boundaries?: string;
  }): string {
    const commands = opts.commands
      ? Object.entries(opts.commands)
          .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
          .join('\n')
      : '';
    const deps = opts.approvedFiles
      ? `dependencies:\n  approvedFiles:\n${opts.approvedFiles.map((f) => `    - "${f}"`).join('\n')}\n`
      : '';
    return `version: 1
quality:
  required:
${opts.required.map((g) => `    - "${g}"`).join('\n')}
${commands ? `  commands:\n${commands}\n` : ''}${deps}${opts.boundaries ?? ''}execution:
  vettedRepos:
    - "${vettedRoot}"
  timeoutMs: ${opts.timeoutMs ?? 60000}
`;
  }

  async function writeTaskAndPolicy(policy: string): Promise<{ taskPath: string; policyPath: string }> {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: phase1-task
baseCommit: "${baseCommit}"
description: "Phase 1 command gates"
scope:
  allow:
    - "src/**"
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
    const policyPath = join(repo.parent, 'policy.yaml');
    await writeFile(policyPath, policy, 'utf8');
    return { taskPath, policyPath };
  }

  async function readBundle(evidenceDir: string) {
    const raw = await readFile(join(evidenceDir, 'evidence.json'), 'utf8');
    return evidenceBundleSchema.parse(JSON.parse(raw));
  }

  it('positive: vetted repo runs tsc/eslint/node-test gates → needs_review (exit 0)', async () => {
    await repo.writeFile('tests/ok.test.js', "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('ok', () => assert.ok(true));\n");
    repo.commitAll('add test');
    const { taskPath, policyPath } = await writeTaskAndPolicy(
      policyYaml({
        required: ['path-scope', 'types', 'lint', 'tests'],
        commands: {
          types: `${eilBin}/tsc -p tsconfig.json --noEmit --pretty false`,
          lint: `${eilBin}/eslint . --format json`,
          tests: 'node --test',
        },
      }),
    );
    await repo.writeFile('src/feature.ts', 'export const feature: number = 2;\n');

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(0);
    const bundle = await readBundle(out.evidenceDir as string);
    expect(bundle.verdict).toBe('needs_review');
    for (const id of ['types', 'lint', 'tests']) {
      expect(bundle.gateResults.find((g) => g.id === id)?.status).toBe('pass');
    }
  });

  it('unvetted repo: command gates report execution_not_permitted error (exit 2)', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(taskPath, `version: 1\nid: phase1-task\nbaseCommit: "${baseCommit}"\ndescription: "x"\nscope:\n  allow:\n    - "**"\n  protect: []\nacceptance:\n  - id: u\n    description: "x"\npolicy:\n  maxAttempts: 2\n  noNewDependencies: false\n`, 'utf8');
    const unvettedPolicy = `version: 1\nquality:\n  required:\n    - "tests"\n`;
    const policyPath = join(repo.parent, 'policy.yaml');
    await writeFile(policyPath, unvettedPolicy, 'utf8');

    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(2);
    const bundle = await readBundle(out.evidenceDir as string);
    const tests = bundle.gateResults.find((g) => g.id === 'tests');
    expect(tests?.status).toBe('error');
    expect(tests?.reason).toContain('execution_not_permitted');
  });

  it('negative: missing tool (exit 127) → error, never pass', async () => {
    const { taskPath, policyPath } = await writeTaskAndPolicy(
      policyYaml({
        required: ['types'],
        commands: { types: 'definitely-not-a-real-tool-xyz --version' },
      }),
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(2);
    const bundle = await readBundle(out.evidenceDir as string);
    const types = bundle.gateResults.find((g) => g.id === 'types');
    expect(types?.status).toBe('error');
    expect(types?.reason).toContain('exited with code');
  });

  it('negative: command timeout → error with timeout reason', async () => {
    const { taskPath, policyPath } = await writeTaskAndPolicy(
      policyYaml({
        required: ['types'],
        commands: { types: 'sleep 5' },
        timeoutMs: 500,
      }),
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(2);
    const bundle = await readBundle(out.evidenceDir as string);
    const types = bundle.gateResults.find((g) => g.id === 'types');
    expect(types?.status).toBe('error');
    expect(types?.reason).toContain('timed out');
  });

  it('negative: unknown exit code 137 (killed child simulation) → error', async () => {
    const { taskPath, policyPath } = await writeTaskAndPolicy(
      policyYaml({
        required: ['tests'],
        commands: { tests: 'sh -c "exit 137"' },
      }),
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(2);
    const bundle = await readBundle(out.evidenceDir as string);
    const tests = bundle.gateResults.find((g) => g.id === 'tests');
    expect(tests?.status).toBe('error');
    expect(tests?.reason).toContain('137');
  });

  it('negative: no test script configured (npm Missing script) → error, not fail', async () => {
    const { taskPath, policyPath } = await writeTaskAndPolicy(
      policyYaml({
        required: ['tests'],
        commands: { tests: 'npm test' },
      }),
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(2);
    const bundle = await readBundle(out.evidenceDir as string);
    const tests = bundle.gateResults.find((g) => g.id === 'tests');
    expect(tests?.status).toBe('error');
    expect(tests?.reason).toContain('no test script');
  });

  it('failing test command → fail (exit 1) with full log in evidence', async () => {
    await repo.writeFile('tests/fail.test.js', "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('boom', () => assert.ok(false, 'expected failure'));\n");
    repo.commitAll('failing test');
    const { taskPath, policyPath } = await writeTaskAndPolicy(
      policyYaml({
        required: ['tests'],
        commands: { tests: 'node --test' },
      }),
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(1);
    const bundle = await readBundle(out.evidenceDir as string);
    const tests = bundle.gateResults.find((g) => g.id === 'tests');
    expect(tests?.status).toBe('fail');
    const log = await readFile(join(out.evidenceDir as string, 'logs', 'tests--output.log'), 'utf8');
    // node --test in non-TTY emits TAP; the failed test is visible as `not ok`.
    expect(log).toContain('not ok');
  });

  it('lint: new violation fails, pre-existing violation is inherited (baseline classification)', async () => {
    await repo.writeFile('src/legacy.js', 'console.log("legacy");\n');
    repo.commitAll('legacy violation at base');
    await repo.writeFile('src/fresh.js', 'console.log("fresh");\n'); // new violation, untracked

    const { taskPath, policyPath } = await writeTaskAndPolicy(
      policyYaml({
        required: ['lint'],
        commands: { lint: `${eilBin}/eslint . --format json` },
      }),
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(1);
    const bundle = await readBundle(out.evidenceDir as string);
    const lint = bundle.gateResults.find((g) => g.id === 'lint');
    expect(lint?.status).toBe('fail');
    expect(lint?.reason).toContain('1 new');
    expect(lint?.reason).toContain('1 inherited');
    const fresh = bundle.policyViolations.find((v) => v.path === 'src/fresh.js');
    const legacy = bundle.policyViolations.find((v) => v.path === 'src/legacy.js');
    expect(fresh?.classification).toBe('new');
    expect(legacy?.classification).toBe('inherited');
  });

  it('lint: inherited-only violations pass the gate but are recorded', async () => {
    await repo.writeFile('src/legacy.js', 'console.log("legacy");\n');
    repo.commitAll('legacy violation at base');
    await repo.writeFile('src/innocent.ts', 'export const ok: number = 3;\n');

    const { taskPath, policyPath } = await writeTaskAndPolicy(
      policyYaml({
        required: ['lint'],
        commands: { lint: `${eilBin}/eslint . --format json` },
      }),
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(0);
    const bundle = await readBundle(out.evidenceDir as string);
    const lint = bundle.gateResults.find((g) => g.id === 'lint');
    expect(lint?.status).toBe('pass');
    expect(lint?.reason).toContain('inherited');
    expect(bundle.policyViolations.some((v) => v.classification === 'inherited')).toBe(true);
  });

  it('lockfile/manifest change: fail without approval, pass with dependencies.approvedFiles', async () => {
    await repo.writeFile('package.json', '{\n  "name": "fixture",\n  "version": "0.0.0",\n  "dependencies": {\n    "left-pad": "1.0.0"\n  }\n}\n');

    const unapproved = await writeTaskAndPolicy(policyYaml({ required: ['dependency-policy'] }));
    const out1 = await runCheck({ repo: repo.root, task: unapproved.taskPath, policy: unapproved.policyPath, quiet: true });
    expect(out1.exitCode).toBe(1);
    const bundle1 = await readBundle(out1.evidenceDir as string);
    expect(bundle1.policyViolations[0]?.rule).toBe('dependency-manifest-changed');
    expect(bundle1.policyViolations[0]?.classification).toBe('new');

    const approved = await writeTaskAndPolicy(policyYaml({ required: ['dependency-policy'], approvedFiles: ['package.json'] }));
    const out2 = await runCheck({ repo: repo.root, task: approved.taskPath, policy: approved.policyPath, quiet: true });
    expect(out2.exitCode).toBe(0);
    const bundle2 = await readBundle(out2.evidenceDir as string);
    const dep = bundle2.gateResults.find((g) => g.id === 'dependency-policy');
    expect(dep?.status).toBe('pass');
    expect(dep?.reason).toContain('approval');
  });

  it('truncated patch (diff > 16 MiB) → diff-patch-integrity error, exit 2, never pass', async () => {
    const bigContent = `${'x'.repeat(99)}\n`.repeat(200_000); // ~20 MB
    await repo.writeFile('src/big.generated.ts', bigContent);

    const { taskPath, policyPath } = await writeTaskAndPolicy(policyYaml({ required: ['path-scope'] }));
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    expect(out.exitCode).toBe(2);
    const bundle = await readBundle(out.evidenceDir as string);
    const integrity = bundle.gateResults.find((g) => g.id === 'diff-patch-integrity');
    expect(integrity?.status).toBe('error');
    expect(integrity?.mandatory).toBe(true);
    expect(integrity?.reason).toContain('patch_truncated');
    expect(bundle.verdict).toBe('error');
  });
});

describe('eil check — import boundaries (task 1.2)', () => {
  let repo: FixtureRepo;
  let vettedRoot: string;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    vettedRoot = await realpath(repo.root);
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  async function runWithBoundaries(boundariesYaml: string): Promise<{ exitCode: 0 | 1 | 2; bundle: ReturnType<typeof evidenceBundleSchema.parse>; evidenceDir: string }> {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: boundaries-task
baseCommit: "${baseCommit}"
description: "Import boundaries"
scope:
  allow:
    - "src/**"
  protect: []
acceptance:
  - id: u
    description: "x"
policy:
  maxAttempts: 2
  noNewDependencies: false
`,
      'utf8',
    );
    const policyPath = join(repo.parent, 'policy.yaml');
    await writeFile(
      policyPath,
      `version: 1
quality:
  required:
    - "path-scope"
    - "import-boundaries"
${boundariesYaml}execution:
  vettedRepos:
    - "${vettedRoot}"
`,
      'utf8',
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    const bundle = evidenceBundleSchema.parse(JSON.parse(await readFile(join(out.evidenceDir as string, 'evidence.json'), 'utf8')));
    return { exitCode: out.exitCode as 0 | 1 | 2, bundle, evidenceDir: out.evidenceDir as string };
  }

  it('forbidden import from a changed file fails the gate', async () => {
    await repo.writeFile('src/internal/secret.ts', 'export const secret = 1;\n');
    await repo.writeFile('src/app.ts', 'export { secret } from "./internal/secret";\n');
    repo.commitAll('base with internal module');
    await repo.writeFile('src/client.ts', 'import { secret } from "./internal/secret";\nexport const x = secret;\n');

    const { exitCode, bundle } = await runWithBoundaries(`boundaries:
  forbiddenImports:
    - from: "src/**"
      disallow:
        - "src/internal/**"
`);
    expect(exitCode).toBe(1);
    const violation = bundle.policyViolations.find((v) => v.rule === 'forbidden-import');
    expect(violation?.path).toBe('src/client.ts');
    expect(violation?.detail).toContain('src/internal/secret.ts');
  });

  it('new import cycle fails; pre-existing cycle is inherited', async () => {
    // Base: cycle a -> b -> a (pre-existing).
    await repo.writeFile('src/a.ts', 'import { b } from "./b";\nexport const a = () => b();\n');
    await repo.writeFile('src/b.ts', 'import { a } from "./a";\nexport const b = () => a();\n');
    repo.commitAll('base with pre-existing cycle');
    // Current change: c joins the cycle (b -> c -> a), and also renames the cycle set.
    await repo.writeFile('src/c.ts', 'export const c = 1;\n');
    await repo.writeFile('src/b.ts', 'import { a } from "./a";\nimport { c } from "./c";\nexport const b = () => a() + c;\n');
    await repo.writeFile('src/c.ts', 'import { a } from "./a";\nexport const c = () => a();\n');

    const { exitCode, bundle } = await runWithBoundaries(`boundaries:
  forbidNewCycles: true
`);
    expect(exitCode).toBe(1);
    const newCycle = bundle.policyViolations.find((v) => v.rule === 'new-import-cycle');
    expect(newCycle).toBeDefined();
    expect(newCycle?.detail).toContain('src/a.ts');
    expect(newCycle?.detail).toContain('src/c.ts');
    // The base cycle a<->b is a subset member-set of the new SCC; the new SCC
    // fingerprint differs, so it is reported as new. No separate inherited
    // entry is expected here because the {a,b} SCC no longer exists.
    expect(bundle.policyViolations.filter((v) => v.rule === 'import-cycle-inherited')).toHaveLength(0);
  });

  it('pre-existing unchanged cycle is inherited and does not fail', async () => {
    await repo.writeFile('src/a.ts', 'import { b } from "./b";\nexport const a = () => b();\n');
    await repo.writeFile('src/b.ts', 'import { a } from "./a";\nexport const b = () => a();\n');
    repo.commitAll('base with cycle');
    await repo.writeFile('src/plain.ts', 'export const plain = 1;\n');

    const { exitCode, bundle } = await runWithBoundaries(`boundaries:
  forbidNewCycles: true
`);
    expect(exitCode).toBe(0);
    const inherited = bundle.policyViolations.find((v) => v.rule === 'import-cycle-inherited');
    expect(inherited).toBeDefined();
    const gate = bundle.gateResults.find((g) => g.id === 'import-boundaries');
    expect(gate?.status).toBe('pass');
  });

  it('dynamic import() is detected for forbidden imports', async () => {
    await repo.writeFile('src/internal/secret.ts', 'export const secret = 1;\n');
    repo.commitAll('base');
    await repo.writeFile('src/lazy.ts', 'export const load = () => import("./internal/secret");\n');

    const { exitCode, bundle } = await runWithBoundaries(`boundaries:
  forbiddenImports:
    - from: "src/**"
      disallow:
        - "src/internal/**"
`);
    expect(exitCode).toBe(1);
    expect(bundle.policyViolations.some((v) => v.rule === 'forbidden-import' && v.path === 'src/lazy.ts')).toBe(true);
  });
});
