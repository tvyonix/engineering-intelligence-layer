import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import picomatch from 'picomatch';
import type { Violation } from '../policy-engine/violations.js';
import { canonicalizeRepoRelativePath } from '../policy-engine/paths.js';
import { extractAllModuleSpecifiers } from './import-graph.js';
import type { Gate, GateContext, GateOutcome } from './types.js';

export const DS_CONFORMANCE_GATE_ID = 'ds-conformance';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_RAW_COLOR_REPORTS_PER_FILE = 3;

export interface JsxUsage {
  component: string;
  inner: string;
}

/**
 * Extracts JSX component usages with a bounded scanner: for each
 * `<Component` occurrence, captures the tag interior up to the matching
 * `>` at depth 0 (tracking {}, () and quotes). Heuristic on purpose —
 * AST analysis arrives with ts-morph in Phase 2 — but deterministic and
 * adequate for configurable DS rules with fixtures.
 */
export function findJsxUsages(source: string): JsxUsage[] {
  const usages: JsxUsage[] = [];
  const opening = /<([A-Z][A-Za-z0-9_]*)/g;
  let match = opening.exec(source);
  while (match !== null) {
    const component = match[1] as string;
    let index = opening.lastIndex;
    const start = index;
    let depth = 0;
    let quote: string | null = null;
    let closed = false;
    while (index < source.length && index - start < 20_000) {
      const ch = source[index] as string;
      if (quote !== null) {
        if (ch === '\\') {
          index += 2;
          continue;
        }
        if (ch === quote) quote = null;
        index += 1;
        continue;
      }
      if (ch === '{' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '>' && depth === 0) {
        closed = true;
        index += 1;
        break;
      }
      index += 1;
    }
    if (closed) {
      // Generic invocation `Array<Foo>(...)` is not JSX: a call opening
      // parenthesis directly after the closing angle bracket disqualifies it.
      const afterClose = source.slice(index).trimStart();
      if (!afterClose.startsWith('(')) {
        usages.push({ component, inner: source.slice(start, index - 1) });
      }
    }
    match = opening.exec(source);
  }
  return usages;
}

/** Explicit attribute names in a tag interior (attr=...); excludes spreads. */
export function jsxAttributes(inner: string): string[] {
  const attrs: string[] = [];
  const attrRe = /(?<![\w$-])([A-Za-z_][A-Za-z0-9_-]*)\s*=/g;
  let m = attrRe.exec(inner);
  while (m !== null) {
    attrs.push(m[1] as string);
    m = attrRe.exec(inner);
  }
  return attrs;
}

/** Shorthand (boolean) JSX attributes: bare identifiers in tag position. */
export function jsxShorthandAttributes(inner: string): string[] {
  const attrs: string[] = [];
  const shortRe = /(?:^|[\s{])([a-z][A-Za-z0-9_-]*)(?=[\s/>}]|$)/g;
  let m = shortRe.exec(inner);
  while (m !== null) {
    attrs.push(m[1] as string);
    m = shortRe.exec(inner);
  }
  return attrs;
}

const RAW_COLOR_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

/**
 * Gate `ds-conformance` (opt-in via policy.ds): applies configurable
 * Beaver-UI-style design-system rules to changed TS/JSX files (design.md
 * §12: lint/AST patterns, no UI schema runtime).
 *
 * Rules (all configured by the operator):
 * - `forbiddenComponents`: JSX components that must not be used;
 * - `forbiddenProps`: per-component props (explicit `prop=` and shorthand);
 * - `componentImports` + `allowedImports`: DS module imports must come from
 *   the allowed subset;
 * - `forbidRawColors`: raw hex colors are violations (token discipline).
 *
 * Violations carry the file and the violated policy contract. No `ds`
 * section → `not_applicable` (the gate never silently blocks repositories
 * without a configured DS registry).
 */
export function dsConformanceGate(): Gate {
  return {
    id: DS_CONFORMANCE_GATE_ID,
    async run(ctx: GateContext): Promise<GateOutcome> {
      const ds = ctx.policy.ds;
      if (ds === undefined) {
        return { status: 'not_applicable', reason: 'opt-in gate: no design-system policy is configured' };
      }

      const entries: { path: string; origPath?: string; status: string }[] = [
        ...ctx.diff.changed.map((c) => ({ path: c.path, origPath: c.origPath, status: c.status })),
        ...ctx.diff.untracked.map((u) => ({ path: u, origPath: undefined, status: 'A' })),
      ];
      const files: { path: string; content: string }[] = [];
      for (const entry of entries) {
        for (const raw of [entry.path, entry.origPath]) {
          if (raw === undefined) continue;
          const canonical = canonicalizeRepoRelativePath(raw);
          if (canonical.kind !== 'valid') continue;
          if (!SOURCE_EXTENSIONS.has(extname(canonical.path))) continue;
          if (entry.status === 'D') continue; // deleted files have no content to check
          if (files.some((f) => f.path === canonical.path)) continue;
          const absolute = join(ctx.repoDir, canonical.path);
          try {
            const stats = await stat(absolute);
            if (stats.size > MAX_FILE_BYTES) continue;
            const content = await readFile(absolute, 'utf8');
            files.push({ path: canonical.path, content });
          } catch {
            continue; // unreadable (e.g. deletion pending): nothing to check
          }
        }
      }

      const violations: Violation[] = [];

      // 1. Forbidden components.
      if (ds.forbiddenComponents !== undefined && ds.forbiddenComponents.length > 0) {
        const forbidden = new Set(ds.forbiddenComponents);
        for (const file of files) {
          if (!/\.(tsx|jsx)$/.test(file.path)) continue;
          for (const usage of findJsxUsages(file.content)) {
            if (forbidden.has(usage.component)) {
              violations.push({
                rule: 'ds-component-forbidden',
                path: file.path,
                detail: `component '<${usage.component}>' is forbidden by DS policy '${ds.registry}'`,
                classification: 'new',
              });
            }
          }
        }
      }

      // 2. Forbidden props per component.
      if (ds.forbiddenProps !== undefined) {
        const entries = Object.entries(ds.forbiddenProps);
        if (entries.length > 0) {
          for (const file of files) {
            if (!/\.(tsx|jsx)$/.test(file.path)) continue;
            for (const usage of findJsxUsages(file.content)) {
              const forbiddenProps = ds.forbiddenProps[usage.component];
              if (forbiddenProps === undefined || forbiddenProps.length === 0) continue;
              const attrs = new Set([...jsxAttributes(usage.inner), ...jsxShorthandAttributes(usage.inner)]);
              for (const attr of attrs) {
                if (forbiddenProps.includes(attr)) {
                  violations.push({
                    rule: 'ds-prop-forbidden',
                    path: file.path,
                    detail: `<${usage.component} ${attr}…>: prop '${attr}' is forbidden by DS policy '${ds.registry}'`,
                    classification: 'new',
                  });
                }
              }
            }
          }
        }
      }

      // 3. DS module imports must come from the allowed subset.
      if (ds.componentImports !== undefined && ds.componentImports.length > 0 && ds.allowedImports !== undefined) {
        const isComponentImport = (spec: string) => picomatch.isMatch(spec, ds.componentImports as string[], { dot: true });
        const isAllowed = (spec: string) => picomatch.isMatch(spec, ds.allowedImports as string[], { dot: true });
        for (const file of files) {
          for (const spec of extractAllModuleSpecifiers(file.content)) {
            if (isComponentImport(spec) && !isAllowed(spec)) {
              violations.push({
                rule: 'ds-import-not-allowed',
                path: file.path,
                detail: `import '${spec}' matches DS component modules [${ds.componentImports.join(', ')}] but is not in allowedImports [${ds.allowedImports.join(', ')}]`,
                classification: 'new',
              });
            }
          }
        }
      }

      // 4. Raw colors.
      if (ds.forbidRawColors === true) {
        for (const file of files) {
          const matches = [...file.content.matchAll(RAW_COLOR_RE)].slice(0, MAX_RAW_COLOR_REPORTS_PER_FILE);
          for (const colorMatch of matches) {
            violations.push({
              rule: 'ds-raw-color',
              path: file.path,
              detail: `raw color literal '${colorMatch[0]}' — use design tokens per DS policy '${ds.registry}'`,
              classification: 'new',
            });
          }
        }
      }

      const newViolations = violations.filter((v) => v.classification === 'new');
      const status = newViolations.length > 0 ? 'fail' : 'pass';
      const reason =
        newViolations.length > 0
          ? `${newViolations.length} DS violation(s): ${newViolations.slice(0, 5).map((v) => `${v.rule}@${v.path}`).join('; ')}${newViolations.length > 5 ? '; …' : ''}`
          : `changed files conform to DS policy '${ds.registry}' (${files.length} file(s) checked)`;

      return {
        status,
        reason,
        violations,
        artifacts: [{ fileName: 'ds-conformance.json', content: `${JSON.stringify({ violations }, null, 2)}\n` }],
      };
    },
  };
}
