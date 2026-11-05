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
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const cli = join(repoRoot, 'dist', 'apps', 'cli', 'main.js');
const evidenceDir = join(repoRoot, '.eil-self-check', 'latest');

if (!existsSync(cli)) {
  console.error('self-check: dist not built — run `npm run build` first');
  process.exit(2);
}
rmSync(evidenceDir, { recursive: true, force: true });

const rootCommit = execFileSync('git', ['-C', repoRoot, 'rev-list', '--max-parents=0', 'HEAD'], {
  encoding: 'utf8',
}).trim();

const result = execFileSync(
  process.execPath,
  [
    cli,
    'check',
    '--repo', repoRoot,
    '--task', join(repoRoot, 'ops', 'self-task.yaml'),
    '--policy', join(repoRoot, 'ops', 'self-policy.yaml'),
    '--base', rootCommit,
    '--out', evidenceDir,
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);

console.log(result.trim().split('\n').slice(-14).join('\n'));
console.log(`self-check: evidence at ${evidenceDir}`);
