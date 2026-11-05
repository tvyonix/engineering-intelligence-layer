import { describe, expect, it } from 'vitest';
import { normalizePath, parseEslintJsonOutput, parseTscOutput } from './diagnostics.js';
import { extractRelativeSpecifiers, findCycles, cycleFingerprint, type ImportEdge } from './import-graph.js';
import { isExecutionPermitted } from './execution-policy.js';
import type { ResolvedPolicy } from '../contracts/policy.js';

describe('diagnostics parsers', () => {
  it('parses tsc --pretty false diagnostics', () => {
    const output = [
      'src/a.ts(12,5): error TS2322: Type \'number\' is not assignable to type \'string\'.',
      '',
      'Found 1 error in src/a.ts:12',
    ].join('\n');
    const diags = parseTscOutput(output);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toEqual({
      rule: 'tsc:TS2322',
      path: 'src/a.ts',
      detail: '12:5: Type \'number\' is not assignable to type \'string\'.',
    });
  });

  it('ignores non-diagnostic lines and garbage without crashing', () => {
    const output = [
      'random output',
      'Error: something completely different',
      'src/broken.ts(1,1): error TS1005: \';\' expected.',
      '┌── weird unicode ─┐',
    ].join('\n');
    const diags = parseTscOutput(output);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.path).toBe('src/broken.ts');
  });

  it('parses eslint --format json output with and without rule ids, making paths relative', () => {
    const output = JSON.stringify([
      {
        filePath: '/abs/repo/src/a.js',
        messages: [{ ruleId: 'no-console', severity: 2, line: 1, column: 2, message: 'Unexpected console statement.' }],
      },
      {
        filePath: '/abs/repo/src/b.js',
        messages: [
          { ruleId: null, severity: 2, line: 3, column: 1, message: 'Parsing error: Unexpected token' },
          { ruleId: 'no-unused-vars', severity: 1, line: 4, column: 5, message: "'x' is assigned a value but never used." },
        ],
      },
    ]);
    const diags = parseEslintJsonOutput(output, '/abs/repo');
    expect(diags).toHaveLength(3);
    expect(diags[0]).toMatchObject({ rule: 'eslint:no-console', path: 'src/a.js', detail: '1:2: Unexpected console statement.' });
    expect(diags[1]).toMatchObject({ rule: 'eslint:unknown', path: 'src/b.js' });
    expect(diags[2]).toMatchObject({ rule: 'eslint:no-unused-vars', path: 'src/b.js' });
  });

  it('eslint parser yields no diagnostics for garbage without crashing', () => {
    expect(parseEslintJsonOutput('not json at all', '/abs/repo')).toHaveLength(0);
    expect(parseEslintJsonOutput('{"a":1}', '/abs/repo')).toHaveLength(0);
  });

  it('normalizePath strips ./ and makes absolute paths relative to scanRoot', () => {
    expect(normalizePath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizePath('/abs/repo/src/a.ts', '/abs/repo')).toBe('src/a.ts');
    expect(normalizePath('/other/repo/src/a.ts', '/abs/repo')).toBe('/other/repo/src/a.ts');
    expect(normalizePath('src\\a.ts')).toBe('src/a.ts');
  });
});

describe('import graph extraction', () => {
  it('extracts static, re-export and dynamic relative imports; ignores bare specifiers', () => {
    const source = [
      "import { x } from './x';",
      "import y from '../lib/y';",
      "export * from './z';",
      "export { w } from './w';",
      "const m = import('./dyn');",
      "const n = require('./req');",
      "import fs from 'node:fs';",
      "import { zod } from 'zod';",
    ].join('\n');
    const specs = extractRelativeSpecifiers(source);
    expect(specs.sort()).toEqual(['../lib/y', './dyn', './req', './w', './x', './z']);
  });

  it('finds SCC cycles and self-loops', () => {
    const edges: ImportEdge[] = [
      { from: 'src/a.ts', to: 'src/b.ts' },
      { from: 'src/b.ts', to: 'src/a.ts' },
      { from: 'src/c.ts', to: 'src/d.ts' },
      { from: 'src/d.ts', to: 'src/e.ts' },
      { from: 'src/loop.ts', to: 'src/loop.ts' },
    ];
    const cycles = findCycles(edges);
    const prints = cycles.map(cycleFingerprint).sort();
    expect(prints).toContain('src/a.ts::src/b.ts');
    expect(prints).toContain('src/loop.ts');
    expect(prints).not.toContain('src/c.ts::src/d.ts');
  });

  it('fingerprint is order-independent', () => {
    expect(cycleFingerprint(['src/b.ts', 'src/a.ts'])).toBe(cycleFingerprint(['src/a.ts', 'src/b.ts']));
  });
});

describe('execution policy (default deny)', () => {
  const root = '/repo/realpath';

  it('denies when no execution section exists', () => {
    const policy: ResolvedPolicy = { source: 'default', quality: { required: ['tests'] } };
    const result = isExecutionPermitted(policy, root);
    expect(result.permitted).toBe(false);
    expect(result.reason).toContain('execution_not_permitted');
  });

  it('denies when the repo is not in vettedRepos', () => {
    const policy: ResolvedPolicy = {
      source: 'file',
      quality: { required: ['tests'] },
      execution: { vettedRepos: ['/other/repo'] },
    };
    expect(isExecutionPermitted(policy, root).permitted).toBe(false);
  });

  it('permits only vetted repos', () => {
    const policy: ResolvedPolicy = {
      source: 'file',
      quality: { required: ['tests'] },
      execution: { vettedRepos: [root] },
    };
    expect(isExecutionPermitted(policy, root).permitted).toBe(true);
    expect(isExecutionPermitted(policy, '/not/vetted').permitted).toBe(false);
  });
});
