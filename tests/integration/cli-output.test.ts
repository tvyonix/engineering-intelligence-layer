import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/apps/cli/main.js';
import { createFixtureRepo, destroyFixtureRepo, minimalPolicyYaml, type FixtureRepo } from '../helpers/fixture-repo.js';

describe('CLI main() output discipline', () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.writeFile('src/app.ts', 'export const app = 1;\n');
    repo.commitAll('base');
  });

  afterEach(async () => {
    await destroyFixtureRepo(repo);
    vi.restoreAllMocks();
  });

  it('--json prints exactly one machine-readable payload, no human summary', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: cli-json
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
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(['check', '--repo', repo.root, '--task', taskPath, '--policy', join(repo.parent, 'policy.yaml'), '--out', join(repo.parent, 'ev'), '--json']);
    expect(code).toBe(0);
    const payloadLines = logs.filter((l) => l.trim().startsWith('{'));
    expect(payloadLines).toHaveLength(1);
    const payload = JSON.parse(payloadLines[0] as string);
    expect(payload.taskId).toBe('cli-json');
    // The human summary must not appear in JSON mode.
    expect(logs.join('\n')).not.toContain('EIL check summary');
  });

  it('without --json the human summary is printed and no raw bundle', async () => {
    const baseCommit = repo.git('rev-parse', 'HEAD').trim();
    const taskPath = join(repo.parent, 'task.yaml');
    await writeFile(
      taskPath,
      `version: 1
id: cli-human
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
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
    const code = await main(['check', '--repo', repo.root, '--task', taskPath, '--policy', join(repo.parent, 'policy.yaml'), '--out', join(repo.parent, 'ev2')]);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('EIL check summary');
    expect(logs.join('\n')).not.toContain('"contractHash"');
  });

  it('unknown command exits 2 with usage', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(['definitely-not-a-command']);
    expect(code).toBe(2);
    expect(errorSpy.mock.calls.join('\n')).toContain('unknown command');
  });
});

describe('packaged bin smoke (dist build)', () => {
  it('eil --version works from dist', () => {
    // Only when dist exists (build ran); otherwise skip quietly.
    const dist = join(process.cwd(), 'dist', 'apps', 'cli', 'main.js');
    if (!exists(dist)) return;
    const out = execFileSync(process.execPath, [dist, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

function exists(path: string): boolean {
  return existsSync(path);
}
