import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/apps/cli/main.js';
import { evidenceBundleSchema } from '../../src/packages/evidence/bundle.js';
import { createFixtureRepo, destroyFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo.js';

/**
 * Phase 1.4 (api-compat) and 1.5 (ds-conformance) integration tests.
 * Both gates are opt-in via policy; fixtures need no host command execution.
 */
describe('eil check — api-compat gate (task 1.4)', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  async function commitLib(indexContent: string, message: string): Promise<string> {
    await repo.writeFile('packages/lib/package.json', '{"name":"lib","types":"./index.ts"}\n');
    await repo.writeFile('packages/lib/index.ts', indexContent);
    repo.commitAll(message);
    return repo.git('rev-parse', 'HEAD').trim();
  }

  async function runWithApiCompat(): Promise<{
    exitCode: 0 | 1 | 2;
    bundle: ReturnType<typeof evidenceBundleSchema.parse>;
    evidenceDir: string;
  }> {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: api-task
baseCommit: "${baseCommit}"
description: "API compatibility"
scope:
  allow:
    - "packages/**"
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
    - "api-compat"
`,
      'utf8',
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    const bundle = evidenceBundleSchema.parse(
      JSON.parse(await readFile(join(out.evidenceDir as string, 'evidence.json'), 'utf8')),
    );
    return { exitCode: out.exitCode as 0 | 1 | 2, bundle, evidenceDir: out.evidenceDir as string };
  }

  it('removed export fails the gate (public-api-breaking)', async () => {
    await commitLib('export function greet(name: string): string { return name; }\nexport const version = 1;\n', 'base lib');
    await repo.writeFile('packages/lib/index.ts', 'export const version = 1;\n');

    const { exitCode, bundle } = await runWithApiCompat();
    expect(exitCode).toBe(1);
    const violation = bundle.policyViolations.find((v) => v.rule === 'public-api-breaking');
    expect(violation).toBeDefined();
    expect(violation?.detail).toContain("'greet'");
    expect(violation?.detail).toContain('was removed');
    expect(bundle.gateResults.find((g) => g.id === 'api-compat')?.status).toBe('fail');
  });

  it('changed signature fails; added export and internal change pass', async () => {
    await commitLib('export function greet(name: string): string { return name; }\n', 'base lib');
    await repo.writeFile('packages/lib/index.ts', 'export function greet(name: number): number { return name; }\nexport const extra = 2;\n');

    const { exitCode, bundle } = await runWithApiCompat();
    expect(exitCode).toBe(1);
    const changed = bundle.policyViolations.find((v) => v.detail.includes("'greet' changed signature"));
    expect(changed).toBeDefined();
    expect(changed?.detail).toContain('name: string');

    // Only an added export: compatible.
    await repo.git('checkout', '--', 'packages/lib/index.ts');
    await repo.writeFile('packages/lib/index.ts', 'export function greet(name: string): string { return name; }\nexport const extra = 2;\n');
    const ok = await runWithApiCompat();
    expect(ok.exitCode).toBe(0);
    const gate = ok.bundle.gateResults.find((g) => g.id === 'api-compat');
    expect(gate?.status).toBe('pass');
    expect(gate?.reason).toContain('compatible');
  });

  it('works on a repository whose base commit has no parent (initial commit as base)', async () => {
    // Single-commit repo: base == initial commit, no parent — the snapshot
    // provider still extracts the base tree, so comparison works.
    await repo.writeFile('packages/lib/package.json', '{"name":"lib","types":"./index.ts"}\n');
    await repo.writeFile('packages/lib/index.ts', 'export function greet(name: string): string { return name; }\n');
    repo.commitAll('initial');
    await repo.writeFile('packages/lib/index.ts', 'export const version = 1;\n');

    const { exitCode, bundle } = await runWithApiCompat();
    expect(exitCode).toBe(1);
    expect(bundle.policyViolations.some((v) => v.detail.includes("'greet'") && v.detail.includes('was removed'))).toBe(true);
  });

  it('new package (no baseline entry) is explicitly not_applicable; repo without TS entry too', async () => {
    await repo.writeFile('README.md', '# fixture\n');
    repo.commitAll('empty base');
    // New package introduced by the change.
    await repo.writeFile('packages/newlib/package.json', '{"name":"newlib","types":"./index.ts"}\n');
    await repo.writeFile('packages/newlib/index.ts', 'export const x = 1;\n');
    const fresh = await runWithApiCompat();
    expect(fresh.exitCode).toBe(0);
    const freshGate = fresh.bundle.gateResults.find((g) => g.id === 'api-compat');
    expect(freshGate?.status).toBe('not_applicable');
    expect(freshGate?.reason).toContain('no baseline API to compare');

    // No TS entry at all in touched packages.
    await repo.writeFile('packages/plain/package.json', '{"name":"plain","main":"main.js"}\n');
    await repo.writeFile('packages/plain/main.js', 'module.exports = 1;\n');
    const plain = await runWithApiCompat();
    const plainGate = plain.bundle.gateResults.find((g) => g.id === 'api-compat');
    expect(plainGate?.status).toBe('not_applicable');
  });
});

describe('eil check — ds-conformance gate (task 1.5)', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/app.tsx', 'export const view = <Button variant="primary">ok</Button>;\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  async function runWithDs(dsYaml: string): Promise<{
    exitCode: 0 | 1 | 2;
    bundle: ReturnType<typeof evidenceBundleSchema.parse>;
    evidenceDir: string;
  }> {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: ds-task
baseCommit: "${baseCommit}"
description: "DS conformance"
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
    - "ds-conformance"
${dsYaml}`,
      'utf8',
    );
    const out = await runCheck({ repo: repo.root, task: taskPath, policy: policyPath, quiet: true });
    const bundle = evidenceBundleSchema.parse(
      JSON.parse(await readFile(join(out.evidenceDir as string, 'evidence.json'), 'utf8')),
    );
    return { exitCode: out.exitCode as 0 | 1 | 2, bundle, evidenceDir: out.evidenceDir as string };
  }

  it('forbidden component and forbidden prop fail with file and contract named', async () => {
    await repo.writeFile(
      'src/feature.tsx',
      'export const bad = <LegacyTable rows={[]} legacyVariant="x">t</LegacyTable>;\n',
    );
    const { exitCode, bundle } = await runWithDs(`ds:
  registry: beaver-ui
  forbiddenComponents:
    - "LegacyTable"
  forbiddenProps:
    LegacyTable:
      - "legacyVariant"
    Button:
      - "oldType"
`);
    expect(exitCode).toBe(1);
    const component = bundle.policyViolations.find((v) => v.rule === 'ds-component-forbidden');
    expect(component?.path).toBe('src/feature.tsx');
    expect(component?.detail).toContain('LegacyTable');
    expect(component?.detail).toContain('beaver-ui');
    const prop = bundle.policyViolations.find((v) => v.rule === 'ds-prop-forbidden');
    expect(prop).toBeDefined();
    expect(prop?.detail).toContain('legacyVariant');
  });

  it('multi-line JSX attributes are checked; clean files pass', async () => {
    await repo.writeFile(
      'src/multi.tsx',
      'export const ok = (\n  <Button\n    variant="primary"\n    disabled\n  >go</Button>\n);\n',
    );
    const { exitCode, bundle } = await runWithDs(`ds:
  registry: beaver-ui
  forbiddenProps:
    Button:
      - "legacyVariant"
  forbidRawColors: true
`);
    expect(exitCode).toBe(0);
    expect(bundle.gateResults.find((g) => g.id === 'ds-conformance')?.status).toBe('pass');
  });

  it('raw color literals fail when forbidRawColors is set', async () => {
    await repo.writeFile('src/tokens.ts', 'export const accent = "#FF8800";\n');
    const { exitCode, bundle } = await runWithDs(`ds:
  registry: beaver-ui
  forbidRawColors: true
`);
    expect(exitCode).toBe(1);
    const color = bundle.policyViolations.find((v) => v.rule === 'ds-raw-color');
    expect(color?.path).toBe('src/tokens.ts');
    expect(color?.detail).toContain('#FF8800');
  });

  it('DS imports outside allowedImports fail; allowed ones pass', async () => {
    await repo.writeFile('src/screen.tsx', 'import { OldButton } from "@beaver-ui/legacy";\nexport const v = <OldButton />;\n');
    const bad = await runWithDs(`ds:
  registry: beaver-ui
  componentImports:
    - "@beaver-ui/*"
  allowedImports:
    - "@beaver-ui/next"
`);
    expect(bad.exitCode).toBe(1);
    expect(bad.bundle.policyViolations.some((v) => v.rule === 'ds-import-not-allowed' && v.path === 'src/screen.tsx')).toBe(true);

    await repo.writeFile('src/screen.tsx', 'import { Button } from "@beaver-ui/next";\nexport const v = <Button />;\n');
    const good = await runWithDs(`ds:
  registry: beaver-ui
  componentImports:
    - "@beaver-ui/*"
  allowedImports:
    - "@beaver-ui/next"
`);
    expect(good.exitCode).toBe(0);
  });
});
