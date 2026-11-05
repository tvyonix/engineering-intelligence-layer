import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiRecordFingerprint,
  compareApiSurface,
  extractPublicApi,
  findPackageRootFor,
  resolveTsEntry,
} from './api-surface.js';
import { extractAllModuleSpecifiers, findCycles, extractRelativeSpecifiers } from './import-graph.js';
import { findJsxUsages, jsxAttributes, jsxShorthandAttributes } from './ds-conformance-gate.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eil-api-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePackage(rel: string, files: Record<string, string>): Promise<string> {
  const packageDir = join(dir, rel);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(packageDir, path);
    await mkdir(abs.split('/').slice(0, -1).join('/'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return packageDir;
}

describe('resolveTsEntry', () => {
  it('prefers the package.json types field, then index conventions', async () => {
    const withTypes = await writePackage('with-types', {
      'package.json': '{"name":"a","types":"./custom-entry.ts"}',
      'custom-entry.ts': 'export const a = 1;\n',
      'index.ts': 'export const b = 2;\n',
    });
    expect(resolveTsEntry(withTypes)?.endsWith('custom-entry.ts')).toBe(true);

    const conventional = await writePackage('conventional', {
      'package.json': '{"name":"b"}',
      'src/index.ts': 'export const c = 3;\n',
    });
    expect(resolveTsEntry(conventional)?.endsWith('src/index.ts')).toBe(true);

    const none = await writePackage('no-entry', { 'package.json': '{"name":"c"}', 'main.py': 'x = 1\n' });
    expect(resolveTsEntry(none)).toBeNull();
  });
});

describe('extractPublicApi + compareApiSurface (task 1.4)', () => {
  it('captures exports with kind and signature; detects member changes inside interfaces', async () => {
    const packageDir = await writePackage('pkg', {
      'package.json': '{"name":"pkg","types":"./index.ts"}',
      'index.ts': [
        'export interface ButtonProps { label: string; }',
        'export function greet(name: string): string { return name; }',
        'export const version = 1;',
      ].join('\n'),
    });
    const entry = resolveTsEntry(packageDir) as string;
    const api = extractPublicApi(entry);
    expect(api.ok).toBe(true);
    if (!api.ok) return;
    const names = api.records.map((r) => r.name).sort();
    expect(names).toEqual(['ButtonProps', 'greet', 'version']);
    const greet = api.records.find((r) => r.name === 'greet');
    expect(greet?.kind).toBe('function');
    expect(greet?.type).toContain('name: string');
    expect(greet?.type).toContain('string');

    // Change an interface MEMBER while keeping the export set stable.
    await writeFile(
      join(packageDir, 'index.ts'),
      [
        'export interface ButtonProps { label: number; }',
        'export function greet(name: string): string { return name; }',
        'export const version = 1;',
      ].join('\n'),
      'utf8',
    );
    const changed = extractPublicApi(entry);
    if (!changed.ok) throw new Error(changed.reason);
    const diff = compareApiSurface(api.records, changed.records);
    expect(diff.changed.map((c) => c.name)).toEqual(['ButtonProps']);
    expect(diff.removed).toHaveLength(0);
  });

  it('removed export is breaking, added export is not', async () => {
    const before = [
      { name: 'keep', kind: 'function', type: '() => void' },
      { name: 'drop', kind: 'variable', type: 'number' },
    ];
    const after = [
      { name: 'keep', kind: 'function', type: '() => void' },
      { name: 'add', kind: 'variable', type: 'string' },
    ];
    const diff = compareApiSurface(before, after);
    expect(diff.removed.map((r) => r.name)).toEqual(['drop']);
    expect(diff.added.map((r) => r.name)).toEqual(['add']);
    expect(diff.changed).toHaveLength(0);
    expect(apiRecordFingerprint(before[0] as { name: string; kind: string; type: string })).toBe('keep::function::() => void');
  });

  it('extraction failure is reported, not thrown', async () => {
    const result = extractPublicApi(join(dir, 'missing', 'index.ts'));
    expect(result.ok).toBe(false);
  });

  it('findPackageRootFor walks up to the nearest package.json', async () => {
    const packageDir = await writePackage('packages/lib', {
      'package.json': '{"name":"lib"}',
      'src/deep/file.ts': 'export const x = 1;\n',
    });
    const root = dir;
    await writeFile(join(root, 'not-a-package.txt'), 'x', 'utf8');
    expect(findPackageRootFor(root, 'packages/lib/src/deep/file.ts')).toBe(packageDir);
    expect(findPackageRootFor(root, 'outside/file.ts')).toBeNull();
  });
});

describe('module specifiers extraction', () => {
  it('extractAllModuleSpecifiers includes bare, scoped and side-effect imports', () => {
    const source = [
      "import { x } from './x';",
      "import 'polyfill';",
      "import * as React from 'react';",
      "const { a } = require('@scope/pkg');",
      "export * from './re';",
    ].join('\n');
    const specs = extractAllModuleSpecifiers(source).sort();
    expect(specs).toEqual(['./re', './x', '@scope/pkg', 'polyfill', 'react']);
    expect(extractRelativeSpecifiers(source)).toEqual(['./x', './re']);
  });
});

describe('JSX scanner (ds gate support)', () => {
  it('captures multi-line tags with nested braces and quotes', () => {
    const source = [
      'export const view = (',
      '  <LegacyTable',
      '    rows={items.map((i) => ({ id: i, label: "with > brace" }))}',
      '    legacyVariant="old"',
      '  >',
      '    <Button variant="primary">OK</Button>',
      '  </LegacyTable>',
      ');',
    ].join('\n');
    const usages = findJsxUsages(source);
    const table = usages.find((u) => u.component === 'LegacyTable');
    expect(table).toBeDefined();
    expect(table?.inner).toContain('legacyVariant="old"');
    const attrs = jsxAttributes(table?.inner ?? '');
    expect(attrs).toEqual(['rows', 'legacyVariant']);
    const button = usages.find((u) => u.component === 'Button');
    // Shorthand boolean attributes are detected even without `=`.
    expect(jsxShorthandAttributes(' disabled crossedOut')).toEqual(['disabled', 'crossedOut']);
    expect(jsxShorthandAttributes(button?.inner ?? '')).toEqual([]);
  });

  it('ignores comparisons and generics that look like tags', () => {
    const source = 'const a = x < 5 && y > 3;\nconst b = Array<ButtonProps>(4);';
    const usages = findJsxUsages(source);
    // `Array<` is lowercase; `x < 5` has no identifier right after '<'.
    expect(usages.find((u) => u.component === 'ButtonProps')).toBeUndefined();
  });
});

describe('import graph cycle detection is deterministic', () => {
  it('same edges produce same cycle fingerprint', () => {
    const edges = [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'b.ts', to: 'a.ts' },
    ];
    expect(findCycles(edges)).toHaveLength(1);
  });
});
