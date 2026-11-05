import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, ContextLimitExceededError, findSourceFile } from './project.js';
import { getFileSymbols } from './symbols.js';
import { findSymbolReferences } from './references.js';
import { computeImpact } from './impact.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eil-context-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(abs.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function makeProject(): Promise<ReturnType<typeof createProject>> {
  await write('src/math.ts', [
    'export function format(value: string): string;',
    'export function format(value: number): string;',
    'export function format(value: string | number): string { return String(value); }',
    'export const ANSWER = 42;',
    'const internal = 1;',
    'export { internal as leaked };',
  ].join('\n'));
  await write('src/ui.tsx', 'import { format } from "./math";\nexport const view = format("x");\n');
  await write('src/reexport.ts', 'export { format } from "./math";\nexport * from "./math";\n');
  await write('src/dynamic.ts', [
    'const modules = { a: "./math" };',
    'export async function load(key: string) { return import(modules[key]); }',
    'export async function loadStatic() { return import("./math"); }',
  ].join('\n'));
  return createProject(root);
}

describe('symbols(file) — task 2.1', () => {
  it('lists declarations with kind, export status and bounded signatures', async () => {
    const project = await makeProject();
    const symbols = getFileSymbols(project, root, 'src/math.ts');
    const names = symbols.declarations.map((d) => d.name);
    expect(names).toContain('format');
    expect(names).toContain('ANSWER');
    expect(names).toContain('internal');
    const answer = symbols.declarations.find((d) => d.name === 'ANSWER');
    expect(answer?.kind).toBe('variable');
    expect(answer?.exported).toBe(true);
    const internal = symbols.declarations.find((d) => d.name === 'internal');
    expect(internal?.exported).toBe(false);
    // `internal` is exported through `export { internal as leaked }`.
    const leaked = symbols.declarations.find((d) => d.name === 'internal');
    // exportedNames contains the local name 'internal' via the export list entry mapping to 'leaked'
    // — ts-morph export symbols expose the exported alias; the local declaration stays marked not exported.
    expect(leaked?.exported).toBe(false);
    // Signatures are header-only: no function bodies.
    const format = symbols.declarations.find((d) => d.name === 'format');
    expect(format?.signature).not.toContain('return');
  });

  it('reports overload signatures as a group', async () => {
    const project = await makeProject();
    const symbols = getFileSymbols(project, root, 'src/math.ts');
    const overloads = symbols.declarations.filter((d) => d.name === 'format');
    expect(overloads.length).toBe(3);
    for (const record of overloads) {
      expect(record.overloadGroup).toBe(3);
      expect(record.kind).toBe('function');
    }
    expect(overloads[0]?.signature).toContain('value: string');
    expect(overloads[1]?.signature).toContain('value: number');
  });

  it('reports re-exports with their source modules', async () => {
    const project = await makeProject();
    const symbols = getFileSymbols(project, root, 'src/reexport.ts');
    const named = symbols.reexports.find((r) => r.name === 'format');
    expect(named?.source).toBe('./math');
    const star = symbols.reexports.find((r) => r.name === '*');
    expect(star?.source).toBe('./math');
  });

  it('throws a bounded limit error for missing files', async () => {
    const project = await makeProject();
    expect(() => getFileSymbols(project, root, 'src/missing.ts')).toThrow(/not found/);
  });
});

describe('references(symbol) — task 2.2', () => {
  it('returns exact coordinates of declaration and references', async () => {
    await write('src/lib.ts', 'export function target(): number { return 1; }\n');
    await write('src/one.ts', 'import { target } from "./lib";\nexport const a = target();\n');
    await write('src/two.ts', 'import { target } from "./lib";\nexport const b = target() + target();\n');
    const project = createProject(root);
    const refs = findSymbolReferences(project, root, 'src/lib.ts', 'target');
    expect(refs.declaration).not.toBeNull();
    expect(refs.declaration?.file).toBe('src/lib.ts');
    expect(refs.declaration?.kind).toBe('declaration');
    expect(refs.declaration?.column).toBeGreaterThan(0);
    // two.ts: import specifier + two calls = 3 references; one.ts: import + 1 call.
    const files = refs.references.map((r) => r.file).sort();
    expect(files).toContain('src/one.ts');
    expect(files).toContain('src/two.ts');
    expect(refs.references.filter((r) => r.file === 'src/two.ts')).toHaveLength(3);
    expect(refs.references.filter((r) => r.file === 'src/one.ts')).toHaveLength(2);
    // Import-specifier references are included (a rename must touch them).
    const twoRefs = refs.references.filter((r) => r.file === 'src/two.ts');
    expect(twoRefs.some((r) => r.lineText.startsWith('import'))).toBe(true);
    for (const ref of [...refs.references, refs.declaration as NonNullable<typeof refs.declaration>]) {
      expect(ref.line).toBeGreaterThanOrEqual(1);
      expect(ref.endLine).toBeGreaterThanOrEqual(ref.line);
      expect(ref.endColumn).toBeGreaterThan(ref.column);
      expect(ref.lineText.length).toBeGreaterThan(0);
    }
  });

  it('returns an empty result for unknown symbols without crashing', async () => {
    await write('src/quiet.ts', 'export const present = 1;\n');
    const project = createProject(root);
    const refs = findSymbolReferences(project, root, 'src/quiet.ts', 'absentSymbol');
    expect(refs.declaration).toBeNull();
    expect(refs.references).toHaveLength(0);
    expect(refs.truncated).toBe(false);
  });
});

describe('impact(diff) — task 2.3', () => {
  it('computes transitive reverse dependencies and affected tests', async () => {
    await write('src/core.ts', 'export const core = 1;\n');
    await write('src/mid.ts', 'import { core } from "./core";\nexport const mid = core;\n');
    await write('src/app.ts', 'import { mid } from "./mid";\nexport const app = mid;\n');
    await write('src/core.test.ts', 'import { core } from "./core";\nimport { test } from "node:test";\ntest("x", () => {});\n');
    await write('src/unrelated.ts', 'export const u = 1;\n');
    const project = createProject(root);
    const impact = computeImpact(project, root, ['src/core.ts']);
    expect(impact.changedFiles).toEqual(['src/core.ts']);
    expect(impact.affectedFiles).toEqual(expect.arrayContaining(['src/mid.ts', 'src/app.ts', 'src/core.test.ts']));
    expect(impact.affectedFiles).not.toContain('src/unrelated.ts');
    expect(impact.affectedTests).toEqual(['src/core.test.ts']);
    expect(impact.completeness).toBe('static-import-analysis');
  });

  it('flags non-literal dynamic imports as potentially incomplete, resolves literal ones', async () => {
    const project = await makeProject();
    const impact = computeImpact(project, root, ['src/math.ts']);
    expect(impact.potentiallyIncomplete).toBe(true);
    expect(impact.notes.join(' ')).toMatch(/non-literal dynamic import/i);
    // dynamic.ts imports ./math via a literal dynamic import AND the non-literal one:
    expect(impact.affectedFiles).toContain('src/dynamic.ts');
    // ui.tsx and reexport.ts import statically.
    expect(impact.affectedFiles).toContain('src/ui.tsx');
    expect(impact.affectedFiles).toContain('src/reexport.ts');
  });

  it('never claims completeness even when nothing is dynamic', async () => {
    await write('src/solo.ts', 'export const s = 1;\n');
    const project = createProject(root);
    const impact = computeImpact(project, root, ['src/solo.ts']);
    expect(impact.completeness).toBe('static-import-analysis');
    expect(impact.potentiallyIncomplete).toBe(false);
    expect(impact.affectedFiles).toHaveLength(0);
  });

  it('findSourceFile resolves repo-relative paths', async () => {
    const project = await makeProject();
    expect(findSourceFile(project, root, 'src/math.ts')).toBeDefined();
    expect(findSourceFile(project, root, 'src/nope.ts')).toBeUndefined();
  });
});

describe('project limits', () => {
  it('throws ContextLimitExceededError on an empty repository', () => {
    expect(() => createProject(root)).toThrow(ContextLimitExceededError);
  });
});
