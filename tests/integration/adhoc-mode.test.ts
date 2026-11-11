import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/apps/cli/main.js';
import { evidenceBundleSchema } from '../../src/packages/evidence/bundle.js';
import { createFixtureRepo, destroyFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo.js';

describe('ad-hoc mode: eil check --repo . without any config files', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/app.ts', 'export const app = 1;\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
  });

  it('a clean diff: quick static gates, needs_review, exit 0', async () => {
    await repo.writeFile('src/feature.ts', 'export const feature = 2;\n');
    const out = await runCheck({ repo: repo.root, quiet: true });
    expect(out.exitCode).toBe(0);
    expect(out.messages.some((m) => m.includes('ad-hoc mode'))).toBe(true);
    const evidence = evidenceBundleSchema.parse(JSON.parse(await readFile(join(out.evidenceDir as string, 'evidence.json'), 'utf8')));
    expect(evidence.taskId).toBe('ad-hoc-check');
    expect(evidence.verdict).toBe('needs_review');
    expect(evidence.gateResults.map((g) => g.id).sort()).toEqual(['dependency-policy', 'path-scope', 'secrets-scan']);
  });

  it('a secret in the diff still blocks in ad-hoc mode', async () => {
    await repo.writeFile('src/leak.ts', 'const k = "AKIAABCDEFGHIJKLMNOP";\n'); // eil-allow-secret-fixture
    const out = await runCheck({ repo: repo.root, quiet: true });
    expect(out.exitCode).toBe(1);
    const evidence = evidenceBundleSchema.parse(JSON.parse(await readFile(join(out.evidenceDir as string, 'evidence.json'), 'utf8')));
    expect(evidence.verdict).toBe('blocked');
    expect(evidence.risk).toBe('blocked');
    expect(evidence.policyViolations.some((v) => v.rule === 'known-secret')).toBe(true);
  });

  it('nothing executes on the host: no command gates run in ad-hoc defaults', async () => {
    await repo.writeFile('src/x.ts', 'export const x = 1;\n');
    const out = await runCheck({ repo: repo.root, quiet: true });
    expect(out.exitCode).toBe(0);
    const evidence = evidenceBundleSchema.parse(JSON.parse(await readFile(join(out.evidenceDir as string, 'evidence.json'), 'utf8')));
    // The quick set deliberately excludes types/lint/tests: no host execution
    // without explicit operator intent.
    expect(evidence.gateResults.some((g) => ['types', 'lint', 'tests'].includes(g.id))).toBe(false);
  });
});
