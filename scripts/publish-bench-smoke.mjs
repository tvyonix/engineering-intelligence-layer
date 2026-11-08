#!/usr/bin/env node
/**
 * Publishes a REAL bench smoke artifact (task 5.6: "опубликовать выборки,
 * логи и ограничения") into ops/bench-artifacts/latest for the 5.7
 * reviewer: results.json, samples JSONL, LIMITATIONS.md and command logs
 * from an actual `eil bench --repeat 3` run on the sequential Beaver
 * fixture with the scripted engine stand-in.
 *
 * The fixture generated here mirrors tests/helpers/beaver-fixture.ts (kept
 * in JS so the script has no build dependency). Run: node scripts/publish-bench-smoke.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const cli = join(repoRoot, 'dist', 'apps', 'cli', 'main.js');
if (!existsSync(cli)) {
  console.error('dist not built — run `npm run build` first');
  process.exit(2);
}

const tmp = mkdtempSync('/tmp/eil-bench-publish-');
const repo = join(tmp, 'repo');
mkdirSync(repo, { recursive: true });
const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

// --- Beaver fixture (plain ESM, mirrors the test helper) ---
const PROBE = `#!/usr/bin/env node
import assert from 'node:assert/strict';
const K = Number(process.argv[2] ?? '0');
const failures = []; const pending = [];
const check = (step, fn) => { try { const r = fn(); if (r && typeof r.then === 'function') pending.push(r.then(() => undefined, (e) => { failures.push({ step, message: String(e && e.message || e) }); })); } catch (e) { failures.push({ step, message: String(e && e.message || e) }); } };
if (K >= 1) check(1, async () => { const { AlertsTable } = await import('./src/alerts-table.js'); const rows = AlertsTable({ alerts: [{ id: 1, label: 'CPU high', status: 'open' }, { id: 2, label: 'Disk low', status: 'ack' }] }); assert.equal(rows.component, 'AlertsTable'); assert.equal(rows.props.alerts.length, 2); });
if (K >= 2) check(2, async () => { const { filterByStatus } = await import('./src/filters.js'); const a = [{ id: 1, status: 'open' }, { id: 2, status: 'ack' }, { id: 3, status: 'open' }]; assert.deepEqual(filterByStatus(a, 'open').map((x) => x.id), [1, 3]); });
if (K >= 3) check(3, async () => { const { bulkAck } = await import('./src/bulk-ack.js'); const a = [{ id: 1, status: 'open' }, { id: 2, status: 'open' }, { id: 3, status: 'ack' }]; const r = bulkAck(a, [1, 3]); assert.equal(r.find((x) => x.id === 1).status, 'ack'); assert.equal(r.find((x) => x.id === 2).status, 'open'); });
if (K >= 4) check(4, async () => { const { createApiClient } = await import('./src/api-client.js'); const api = createApiClient({ fetch: async () => ({ ok: true, json: async () => [{ id: 9, status: 'open' }] }) }); const ok = await api.fetchAlerts(); assert.equal(ok.ok, true); const bad = await createApiClient({ fetch: async () => { throw new Error('boom'); } }).fetchAlerts(); assert.equal(bad.ok, false); });
if (K >= 5) check(5, async () => { const { createApiClient } = await import('./src/api-client.js'); const api = createApiClient({ fetch: async () => ({ ok: true, json: async () => ({ items: [{ alert_id: '7', state: 'OPEN' }] }) }), contract: 'v2' }); const r = await api.fetchAlerts(); assert.deepEqual(r.data, [{ id: '7', status: 'OPEN' }]); });
if (K >= 6) check(6, async () => { const { bulkAck } = await import('./src/bulk-ack.js'); const a = [{ id: 1, status: 'open' }, { id: 2, status: 'open' }]; assert.deepEqual(bulkAck(a, [1, 2]).map((x) => x.status), ['ack', 'ack']); assert.deepEqual(bulkAck(a, []).map((x) => x.status), ['open', 'open']); });
await Promise.all(pending);
const failed = failures.filter((f) => f.step <= K);
if (failed.length) { for (const f of failed) console.error('FAIL step ' + f.step + ': ' + f.message); process.exit(1); }
console.log('PROBE OK: steps 1..' + K + ' verified');
`;
const STEP = `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
const k = Number(process.argv[2] ?? '0');
const write = (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
if (k === 1) write('src/alerts-table.js', "export const AlertsTable = ({ alerts }) => ({ component: 'AlertsTable', props: { alerts } });\\n");
else if (k === 2) write('src/filters.js', "export const filterByStatus = (a, s) => s === 'all' ? a : a.filter((x) => x.status === s);\\n");
else if (k === 3) write('src/bulk-ack.js', "export const bulkAck = (a, ids) => { const set = new Set(ids); return a.map((x) => set.has(x.id) ? { ...x, status: 'ack' } : x); };\\n");
else if (k === 4) write('src/api-client.js', "export const createApiClient = ({ fetch }) => ({ fetchAlerts: async () => { try { const res = await fetch('/alerts'); return { ok: true, data: await res.json() }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } } });\\n");
else if (k === 5) write('src/api-client.js', "export const createApiClient = ({ fetch, contract = 'v1' }) => ({ fetchAlerts: async () => { try { const res = await fetch('/alerts'); const p = await res.json(); if (contract === 'v2') return { ok: true, data: (p.items ?? []).map((i) => ({ id: i.alert_id, status: i.state })) }; return { ok: true, data: p }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } } });\\n");
else if (k === 6) write('src/bulk-ack.js', "export const bulkAck = (a, ids) => { const set = new Set(ids); return a.map((x) => set.has(x.id) && x.status !== 'ack' ? { ...x, status: 'ack' } : x); };\\n");
else { console.error('unknown step'); process.exit(2); }
execFileSync(process.execPath, ['probe.mjs', String(k)], { stdio: 'inherit' });
`;

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'bench-smoke@example.com');
git('config', 'user.name', 'Bench Smoke');
writeFileSync(join(repo, 'package.json'), '{\n  "name": "beaver-smoke",\n  "type": "module"\n}\n');
writeFileSync(join(repo, 'probe.mjs'), PROBE);
writeFileSync(join(repo, 'bench-step.mjs'), STEP);
git('add', '-A');
git('commit', '-q', '-m', 'base');

const manifest = join(tmp, 'bench.yaml');
writeFileSync(
  manifest,
  `version: 1
name: beaver-smoke
repoFixture: beaver-monitor (generated)
seed: 7
variants:
  - {"id": "B", "agent": "scripted", "model": "fixture", "engineeringGates": true, "adaptiveRouting": false, "command": "node bench-step.mjs {step}"}
steps:
${[1, 2, 3, 4, 5, 6].map((n) => `  - {"id": ${n}, "task": "step ${n}", "taskFile": "task.yaml", "policyFile": "policy.yaml"}`).join('\n')}
`,
);
writeFileSync(
  join(tmp, 'task.yaml'),
  `version: 1
id: beaver-smoke-step
baseCommit: "${git('rev-parse', 'HEAD').trim()}"
description: "Sequential step"
scope:
  allow:
    - "src/**"
  protect: []
acceptance:
  - id: probe
    description: "Probe passes for steps 1..K"
policy:
  maxAttempts: 1
  noNewDependencies: false
`,
);
writeFileSync(
  join(tmp, 'policy.yaml'),
  `version: 1
execution:
  vettedRepos:
    - "${execFileSync('realpath', [repo], { encoding: 'utf8' }).trim()}"
  timeoutMs: 60000
quality:
  required:
    - "path-scope"
    - "secrets-scan"
`,
);

const out = join(tmp, 'bench-out');
console.log('running eil bench --repeat 3 on the beaver fixture…');
try {
  execFileSync(
    process.execPath,
    [cli, 'bench', '--manifest', manifest, '--repo', repo, '--policy', join(tmp, 'policy.yaml'), '--out', out, '--repeat', '3'],
    { stdio: 'inherit' },
  );
} catch {
  console.error('bench failed');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

// Publish artifacts into the repository for the 5.7 reviewer.
const target = join(repoRoot, 'ops', 'bench-artifacts', 'latest');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const item of ['results.json', 'LIMITATIONS.md', 'samples', 'logs']) {
  cpSync(join(out, item), join(target, item), { recursive: true });
}
writeFileSync(
  join(target, 'README.md'),
  `# Bench smoke artifact (published)\n\nGenerated by \`scripts/publish-bench-smoke.mjs\` (${new Date().toISOString()}):\n\`eil bench --repeat 3\` on the sequential Beaver fixture, scripted engine\nstand-in, one variant (B). Read LIMITATIONS.md before citing any number.\nThis is the REAL run output, not a test fixture.\n`,
);
console.log(`published → ${target}`);
rmSync(tmp, { recursive: true, force: true });
