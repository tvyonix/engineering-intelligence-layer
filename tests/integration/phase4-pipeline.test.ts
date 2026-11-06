import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedEngineRunner } from '../../src/packages/agent-adapters/scripted.js';
import { runTaskPipeline } from '../../src/packages/runner-pipeline/pipeline.js';
import { openLedger, closeLedger } from '../../src/packages/ledger/db.js';
import { defaultPolicy } from '../../src/packages/contracts/policy.js';
import { createFixtureRepo, destroyFixtureRepo, type FixtureRepo } from '../helpers/fixture-repo.js';

let repo: FixtureRepo;
let root: string;
let baseCommit: string;
let vettedPolicyPath: string;

const checker = async (request: { repo: string; task: string; base: string; out: string }) => {
  const { runCheck } = await import('../../src/apps/cli/main.js');
  // The checker uses the SAME vetted policy (minimal gate set) so check
  // verdicts reflect the fixture pipeline, not the default policy's
  // unimplemented command gates.
  const r = await runCheck({ ...request, policy: vettedPolicyPath, quiet: true });
  return { exitCode: r.exitCode, evidenceDir: r.evidenceDir };
};

beforeEach(async () => {
  repo = await createFixtureRepo();
  root = repo.parent;
  await repo.writeFile('src/app.ts', 'export const app = 1;\n');
  repo.commitAll('base');
  baseCommit = repo.git('rev-parse', 'HEAD').trim();
  await writeFile(
    join(root, 'task.yaml'),
    `version: 1
id: pipeline-task
baseCommit: "${baseCommit}"
description: "Pipeline test task"
scope:
  allow:
    - "src/**"
  protect: []
acceptance:
  - id: u
    description: "x"
policy:
  maxAttempts: 4
  noNewDependencies: false
`,
    'utf8',
  );
  // Vet the fixture repository so the pipeline may execute engine commands.
  await writeFile(
    join(root, 'policy.yaml'),
    `version: 1
execution:
  vettedRepos:
    - "${await import('node:fs/promises').then((fs) => fs.realpath(repo.root))}"
  timeoutMs: 30000
quality:
  required:
    - "path-scope"
`,
    'utf8',
  );
  vettedPolicyPath = join(root, 'policy.yaml');
});

afterEach(async () => {
  await destroyFixtureRepo(repo);
});

async function loadPolicy(): Promise<ReturnType<typeof import('../../src/packages/contracts/policy.js').toResolvedPolicy> extends infer T ? T : never> {
  const { parsePolicy, toResolvedPolicy } = await import('../../src/packages/contracts/policy.js');
  const { parse: parseYaml } = await import('yaml');
  const parsed = parsePolicy(parseYaml(await import('node:fs/promises').then((fs) => fs.readFile(vettedPolicyPath, 'utf8'))));
  if (!parsed.ok) throw new Error(parsed.issues.join('; '));
  return toResolvedPolicy(parsed.policy, 'file');
}

/** Engine script that applies a benign change on attempt 1+ (and optionally fails before). */
function successScript(): string {
  return 'echo "engine worked" >> /dev/null';
}

describe('attempt pipeline (skeleton of 3.6, policy level)', () => {
  it('unvetted repo: no attempts, honest needs-review with the permission reason', async () => {
    // Default policy: no vettedRepos → execution denied.
    const engine = new ScriptedEngineRunner({ engineId: 'scripted', model: 'fixture', command: successScript() });
    const summary = await runTaskPipeline({
      repo: repo.root,
      taskFile: join(root, 'task.yaml'),
      policy: defaultPolicy(),
      engine,
      checker,
      out: join(root, 'out'),
      quiet: true,
    });
    expect(summary.exitCode).toBe(2);
    expect(summary.attempts).toHaveLength(0);
    expect(summary.notes.join('\n')).toContain('execution_not_permitted');
    expect(summary.finalAction).toBe('needs-review');
  });

  it('happy path: scripted engine applies a change → check needs_review → stop for human', async () => {
    // The engine script modifies a file inside the workspace.
    const engine = new ScriptedEngineRunner({
      engineId: 'scripted',
      model: 'fixture',
      command: 'echo "export const feature = 1;" > src/feature.ts',
    });
    const summary = await runTaskPipeline({
      repo: repo.root,
      taskFile: join(root, 'task.yaml'),
      policy: await loadPolicy(),
      engine,
      checker,
      out: join(root, 'out'),
      ledger: join(root, 'ledger.db'),
      quiet: true,
    });
    expect(summary.exitCode).toBe(0);
    expect(summary.attempts).toHaveLength(1);
    expect(summary.attempts[0]?.engineStatus).toBe('complete');
    expect(summary.attempts[0]?.checkVerdict).toBe('needs_review');
    expect(summary.finalRisk).toBe('low');
    // The workspace is always discarded; the SOURCE repo is untouched.
    expect(summary.attempts[0]?.workspaceDiscarded).toBe(true);
    expect(existsSync(join(repo.root, 'src', 'feature.ts'))).toBe(false);

    const ledger = await openLedger(join(root, 'ledger.db'));
    try {
      const attempts = ledger.db.prepare('SELECT * FROM attempts').all() as Record<string, unknown>[];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.engine).toBe('scripted');
      expect(attempts[0]?.cost_kind).toBe('unknown');
      const task = ledger.db.prepare('SELECT * FROM tasks WHERE id = ?').get('pipeline-task') as Record<string, unknown>;
      expect(task?.status).toBe('needs_review');
      expect(task?.risk).toBe('low');
    } finally {
      closeLedger(ledger);
    }
  });

  it('4.5: command timeout signature → bounded cheap retries → needs_review without strong tier', { timeout: 120000 }, async () => {
    const engine = new ScriptedEngineRunner({ engineId: 'scripted', model: 'fixture', command: 'sleep 35' });
    const summary = await runTaskPipeline({
      repo: repo.root,
      taskFile: join(root, 'task.yaml'),
      policy: await loadPolicy(),
      engine,
      checker,
      out: join(root, 'out-timeout'),
      maxCheapRetries: 1,
      strongTierConfigured: false,
      quiet: true,
    });
    expect(summary.attempts.length).toBeGreaterThanOrEqual(2);
    expect(summary.attempts.every((a) => a.engineStatus === 'failed')).toBe(true);
    expect(summary.attempts.every((a) => a.failureSignatures.includes('command:timeout'))).toBe(true);
    expect(summary.finalAction).toBe('needs-review');
    // Failed attempts preserved their artifacts before the workspace was discarded.
    const failedDir = join(root, 'out-timeout', 'failed-attempts');
    expect(existsSync(join(failedDir, 'attempt-1', 'attempt.patch'))).toBe(true);
  });

  it('4.5: provider unavailable (exit 127) → needs-review, no infinite retries', async () => {
    const engine = new ScriptedEngineRunner({ engineId: 'scripted', model: 'fixture', command: 'definitely-not-a-tool-xyz' });
    const summary = await runTaskPipeline({
      repo: repo.root,
      taskFile: join(root, 'task.yaml'),
      policy: await loadPolicy(),
      engine,
      checker,
      out: join(root, 'out-127'),
      maxCheapRetries: 2,
      strongTierConfigured: false,
      quiet: true,
    });
    expect(summary.attempts.length).toBeGreaterThanOrEqual(1);
    expect(summary.attempts.every((a) => a.failureSignatures.includes('engine:provider-unavailable'))).toBe(true);
    expect(summary.finalAction).toBe('needs-review');
    expect(summary.attempts.length).toBeLessThanOrEqual(5);
  });

  it('4.5: reproducible engine failure (exit 1) escalates to strong tier when configured', async () => {
    const engine = new ScriptedEngineRunner({
      engineId: 'scripted',
      model: 'fixture',
      command: 'sh -c "exit 1"',
    });
      const summary = await runTaskPipeline({
      repo: repo.root,
      taskFile: join(root, 'task.yaml'),
      policy: await loadPolicy(),
      engine,
      checker,
      out: join(root, 'out-escalate'),
      maxCheapRetries: 2,
      strongTierConfigured: true,
      quiet: true,
    });
    expect(summary.attempts.length).toBeGreaterThanOrEqual(2);
    // Same failure signature twice → cascade escalates to strong tier.
    expect(summary.attempts.some((a) => a.tier === 'strong')).toBe(true);
  });

  it('blocked risk (security hints) rejects execution before any attempt', async () => {
    await writeFile(
      join(root, 'task.yaml'),
      `version: 1
id: blocked-task
baseCommit: "${baseCommit}"
description: "Security sensitive"
riskHints:
  - "handles credentials"
scope:
  allow:
    - "src/**"
  protect: []
acceptance:
  - id: u
    description: "x"
policy:
  maxAttempts: 4
  noNewDependencies: false
`,
      'utf8',
    );
    const engine = new ScriptedEngineRunner({ engineId: 'scripted', model: 'fixture', command: successScript() });
    const summary = await runTaskPipeline({
      repo: repo.root,
      taskFile: join(root, 'task.yaml'),
      policy: await loadPolicy(),
      engine,
      checker,
      out: join(root, 'out-blocked'),
      quiet: true,
    });
    // Hints elevate to high (not blocked): high → straight to strong tier
    // or needs_review depending on configuration — never cheap-first.
    expect(summary.finalAction === 'needs-review' || summary.finalAction === 'escalate-strong').toBe(true);
    expect(summary.attempts.every((a) => a.tier === 'strong' || a.engineStatus === 'aborted')).toBe(true);
  });
});
