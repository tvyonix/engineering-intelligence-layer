import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Task 5.3: sequential 6-step Beaver UI evolution fixture.
 *
 * Plain-ESM "UI" modules (functional components) with a deterministic
 * applier + regression probe: after step k, `node probe.mjs k` re-verifies
 * the invariants of ALL steps 1..k — the sequential-evolution requirement
 * (evolution-benchmark spec: previous steps' requirements are re-checked
 * and regressions are attributed by step id).
 *
 * The fixture is self-contained (no npm install): files are plain ESM
 * JavaScript that node can execute directly.
 */

export interface BeaverFixture {
  root: string;
  parent: string;
  git(...args: string[]): string;
  commitAll(message: string): void;
  /** Applies step k by writing the step's file changes (used to seed states in tests). */
  applyStep(k: number): Promise<void>;
}

/** Verifies invariants of steps 1..K by importing the current modules. */
const PROBE = `#!/usr/bin/env node
// Regression probe: node probe.mjs <K> — verifies invariants of steps 1..K.
import assert from 'node:assert/strict';

const K = Number(process.argv[2] ?? '0');
const failures = [];
const pending = [];
const check = (step, fn) => {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => undefined, (error) => { failures.push({ step, message: error instanceof Error ? error.message : String(error) }); }));
    }
  } catch (error) {
    failures.push({ step, message: error instanceof Error ? error.message : String(error) });
  }
};

if (K >= 1) check(1, async () => {
  const { AlertsTable } = await import('./src/alerts-table.js');
  const rows = AlertsTable({ alerts: [{ id: 1, label: 'CPU high', status: 'open' }, { id: 2, label: 'Disk low', status: 'ack' }] });
  assert.equal(rows.component, 'AlertsTable');
  assert.equal(rows.props.alerts.length, 2);
  assert.deepEqual(rows.props.alerts.map((a) => a.id), [1, 2]);
});

if (K >= 2) check(2, async () => {
  const { filterByStatus } = await import('./src/filters.js');
  const alerts = [{ id: 1, status: 'open' }, { id: 2, status: 'ack' }, { id: 3, status: 'open' }];
  assert.deepEqual(filterByStatus(alerts, 'open').map((a) => a.id), [1, 3]);
  assert.deepEqual(filterByStatus(alerts, 'ack').map((a) => a.id), [2]);
  assert.deepEqual(filterByStatus(alerts, 'all').length, 3);
});

if (K >= 3) check(3, async () => {
  const { bulkAck } = await import('./src/bulk-ack.js');
  const alerts = [{ id: 1, status: 'open' }, { id: 2, status: 'open' }, { id: 3, status: 'ack' }];
  const result = bulkAck(alerts, [1, 3]);
  // only selected ids are acknowledged; unselected open alert stays open
  assert.equal(result.find((a) => a.id === 1).status, 'ack');
  assert.equal(result.find((a) => a.id === 2).status, 'open');
  assert.equal(result.find((a) => a.id === 3).status, 'ack');
});

if (K >= 4) check(4, async () => {
  const { createApiClient } = await import('./src/api-client.js');
  const api = createApiClient({ fetch: async () => ({ ok: true, json: async () => [{ id: 9, status: 'open' }] }) });
  {
    const ok = await api.fetchAlerts();
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.data.map((a) => a.id), [9]);
    const failing = createApiClient({ fetch: async () => { throw new Error('boom'); } });
    const bad = await failing.fetchAlerts();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /boom/);
  }
});

if (K >= 5) check(5, async () => {
  const { createApiClient } = await import('./src/api-client.js');
  const api = createApiClient({
    fetch: async () => ({ ok: true, json: async () => ({ items: [{ alert_id: '7', state: 'OPEN' }] }) }),
    contract: 'v2',
  });
  const result = await api.fetchAlerts();
  // v2 contract is mapped back to the v1 shape (backward compatibility)
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [{ id: '7', status: 'OPEN' }]);
});

if (K >= 6) check(6, async () => {
  const { bulkAck } = await import('./src/bulk-ack.js');
  const alerts = [{ id: 1, status: 'open' }, { id: 2, status: 'open' }];
  const result = bulkAck(alerts, [1, 2]);
  // the step-6 fix must keep the step-3 invariant intact
  assert.deepEqual(result.map((a) => a.status), ['ack', 'ack']);
  assert.deepEqual(bulkAck(alerts, []).map((a) => a.status), ['open', 'open']);
});

await Promise.all(pending);
const failed = failures.filter((f) => f.step <= K);
if (failed.length > 0) {
  for (const f of failed) console.error('FAIL step ' + f.step + ': ' + f.message);
  console.error('PROBE: ' + failed.length + ' regression(s) at K=' + K);
  process.exit(1);
}
console.log('PROBE OK: steps 1..' + K + ' verified');
`;

const BENCH_STEP = `#!/usr/bin/env node
// Deterministic engine stand-in: applies step <K> file changes, then re-verifies
// invariants of steps 1..K (regression re-check). Usage: node bench-step.mjs <K>
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

const k = Number(process.argv[2] ?? '0');
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const STEP_FILES = {
  1: { 'src/alerts-table.js': "export const AlertsTable = ({ alerts }) => ({ component: 'AlertsTable', props: { alerts } });\\n" },
  2: { 'src/filters.js': "export const filterByStatus = (alerts, status) => status === 'all' ? alerts : alerts.filter((a) => a.status === status);\\n" },
  3: { 'src/bulk-ack.js': "export const bulkAck = (alerts, ids) => { const set = new Set(ids); return alerts.map((a) => set.has(a.id) ? { ...a, status: 'ack' } : a); };\\n" },
  4: { 'src/api-client.js': "export const createApiClient = ({ fetch }) => ({ fetchAlerts: async () => { try { const res = await fetch('/alerts'); const data = await res.json(); return { ok: true, data }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } } });\\n" },
  5: null, // handled below (rewrites api-client with contract mapping)
  6: { 'src/bulk-ack.js': "export const bulkAck = (alerts, ids) => { const set = new Set(ids); return alerts.map((a) => set.has(a.id) && a.status !== 'ack' ? { ...a, status: 'ack' } : a); };\\n" },
};

if (k === 5) {
  write('src/api-client.js', [
    "export const createApiClient = ({ fetch, contract = 'v1' }) => ({",
    '  fetchAlerts: async () => {',
    '    try {',
    "      const res = await fetch('/alerts');",
    '      const payload = await res.json();',
    "      if (contract === 'v2') {",
    "        const items = Array.isArray(payload?.items) ? payload.items : [];",
    "        return { ok: true, data: items.map((i) => ({ id: i.alert_id, status: i.state })) };",
    '      }',
    '      return { ok: true, data: payload };',
    '    } catch (error) {',
    '      return { ok: false, error: error instanceof Error ? error.message : String(error) };',
    '    }',
    '  },',
    '});',
    '',
  ].join('\\n'));
} else {
  const files = STEP_FILES[k];
  if (!files) { console.error('unknown step ' + k); process.exit(2); }
  for (const [path, content] of Object.entries(files)) write(path, content);
}

// Regression re-check: all steps 1..k must still hold after this change.
execFileSync(process.execPath, ['probe.mjs', String(k)], { stdio: 'inherit' });
`;

const BASE_FILES: Record<string, string> = {
  'package.json': '{\n  "name": "beaver-monitor-fixture",\n  "version": "0.0.0",\n  "type": "module"\n}\n',
  'probe.mjs': PROBE,
  'bench-step.mjs': BENCH_STEP,
};

/** The six sequential steps of the Beaver Monitor evolution (spec scenario). */
export const BEAVER_STEPS: { id: number; task: string }[] = [
  { id: 1, task: 'Basic alerts table' },
  { id: 2, task: 'Status and service filters' },
  { id: 3, task: 'Bulk acknowledgement' },
  { id: 4, task: 'API client with error handling' },
  { id: 5, task: 'API contract migration with backward compatibility' },
  { id: 6, task: 'Regression fix without losing previous scenarios' },
];

export async function createBeaverFixture(): Promise<BeaverFixture> {
  const parent = await mkdtemp(join(tmpdir(), 'eil-beaver-'));
  const root = join(parent, 'repo');
  await mkdir(root, { recursive: true });
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'beaver-fixture@example.com');
  git('config', 'user.name', 'Beaver Fixture');
  for (const [rel, content] of Object.entries(BASE_FILES)) {
    const abs = join(root, rel);
    await mkdir(abs.split('/').slice(0, -1).join('/'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base: fixture harness (probe + step applier)');
  const fixture: BeaverFixture = {
    root,
    parent,
    git,
    commitAll(message: string) {
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
    },
    async applyStep(k: number) {
      execFileSync('node', [join(root, 'bench-step.mjs'), String(k)], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
    },
  };
  return fixture;
}

export async function destroyBeaverFixture(fixture: BeaverFixture): Promise<void> {
  await rm(fixture.parent, { recursive: true, force: true });
}
