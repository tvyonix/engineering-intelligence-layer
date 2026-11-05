import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FixtureRepo {
  /** Repository root. */
  root: string;
  /** Temporary parent dir (outside the repo) — use for symlink escape targets. */
  parent: string;
  git(...args: string[]): string;
  writeFile(relPath: string, content: string): Promise<void>;
  commitAll(message: string): void;
  /** Absolute path of the parent temp dir that is NOT inside the repo. */
  outsidePath(name: string): string;
}

export async function createFixtureRepo(): Promise<FixtureRepo> {
  const parent = await mkdtemp(join(tmpdir(), 'eil-fixture-'));
  const root = join(parent, 'repo');
  await mkdir(root, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'eil-fixture@example.com');
  git('config', 'user.name', 'EIL Fixture');
  const repo: FixtureRepo = {
    root,
    parent,
    git,
    async writeFile(relPath: string, content: string) {
      const abs = join(root, relPath);
      await mkdir(abs.split('/').slice(0, -1).join('/'), { recursive: true });
      await writeFile(abs, content, 'utf8');
    },
    commitAll(message: string) {
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
    },
    outsidePath(name: string) {
      return join(parent, name);
    },
  };
  return repo;
}

export async function destroyFixtureRepo(repo: FixtureRepo): Promise<void> {
  await rm(repo.parent, { recursive: true, force: true });
}

export function baseTaskYaml(baseCommit: string, overrides: Record<string, unknown> = {}): string {
  const base = `version: 1
id: fixture-task
baseCommit: "${baseCommit}"
description: "Fixture task for integration tests"
scope:
  allow:
    - "src/**"
    - "tests/**"
  protect:
    - ".github/workflows/**"
    - "package-lock.json"
acceptance:
  - id: unit
    description: "Behaviour covered by unit test"
policy:
  maxAttempts: 2
  noNewDependencies: true
`;
  return base + Object.entries(overrides).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
}

export function minimalPolicyYaml(required: string[]): string {
  return `version: 1
quality:
  required:
${required.map((g) => `    - "${g}"`).join('\n')}
`;
}
