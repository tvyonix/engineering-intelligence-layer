#!/usr/bin/env node
/**
 * EIL self-check (dogfooding): runs `eil check` on this repository with the
 * import-boundaries policy in ops/self-policy.yaml, comparing against the
 * ROOT commit — so the invariant is "no forbidden imports and no new import
 * cycles since the modular monolith was born". Fails the CI pipeline on any
 * violation (release gate: "Нет новых запрещённых архитектурных
 * зависимостей внутри самого EIL").
 *
 * Usage: node scripts/self-check.mjs   (after `npm run build`)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const cli = join(repoRoot, 'dist', 'apps', 'cli', 'main.js');
const evidenceDir = join(repoRoot, '.eil-self-check', 'latest');

if (!existsSync(cli)) {
  console.error('self-check: dist not built — run `npm run build` first');
  process.exit(2);
}
rmSync(evidenceDir, { recursive: true, force: true });
mkdirSync(evidenceDir, { recursive: true });

const rootCommit = execFileSync('git', ['-C', repoRoot, 'rev-list', '--max-parents=0', 'HEAD'], {
  encoding: 'utf8',
}).trim();

// 1.7 review: the self-check policy/task must NOT come from the working
// tree — a PR would weaken the rules that check the PR itself. The rules
// are taken from origin/main (the reviewed branch); changing them requires
// a commit to main, where the ops/self-*.yaml diff is explicit. Local runs
// before the first push fall back to HEAD.
const policyRef = (() => {
  try {
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'origin/main'], { encoding: 'utf8', stdio: 'ignore' });
    return 'origin/main';
  } catch {
    return 'HEAD';
  }
})();
const policyPath = join(evidenceDir, 'pinned-self-policy.yaml');
const taskPath = join(evidenceDir, 'pinned-self-task.yaml');
writeFileSync(policyPath, execFileSync('git', ['-C', repoRoot, 'show', `${policyRef}:ops/self-policy.yaml`], { encoding: 'utf8' }));
writeFileSync(taskPath, execFileSync('git', ['-C', repoRoot, 'show', `${policyRef}:ops/self-task.yaml`], { encoding: 'utf8' }));

const result = execFileSync(
  process.execPath,
  [
    cli,
    'check',
    '--repo', repoRoot,
    '--task', taskPath,
    '--policy', policyPath,
    '--base', rootCommit,
    '--out', evidenceDir,
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);

console.log(result.trim().split('\n').slice(-14).join('\n'));
console.log(`self-check: evidence at ${evidenceDir}`);
