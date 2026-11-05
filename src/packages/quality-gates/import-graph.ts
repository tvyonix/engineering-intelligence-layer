import { readFile, readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

export interface ImportEdge {
  from: string;
  to: string;
}

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.eil']);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EDGES = 200_000;

export class GraphLimitExceededError extends Error {}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir: skip, file reads below fail closed individually
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = posix.extname(entry.name.replace(/\\/g, '/'));
      if (!SCANNED_EXTENSIONS.has(ext)) continue;
      files.push(absolute);
      if (files.length > MAX_FILES) {
        throw new GraphLimitExceededError(`repository exceeds ${MAX_FILES} scannable source files`);
      }
    }
  }
  return files;
}

const STATIC_IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;

/** Extracts all module specifiers (relative and bare): static, side-effect, dynamic, require. */
export function extractAllModuleSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  for (const re of [STATIC_IMPORT_RE, DYNAMIC_RE, SIDE_EFFECT_IMPORT_RE]) {
    re.lastIndex = 0;
    let match = re.exec(source);
    while (match !== null) {
      const spec = match[1];
      if (spec !== undefined) specs.add(spec);
      match = re.exec(source);
    }
  }
  return [...specs];
}

/** Extracts repo-relative module specifiers that are relative imports. */
export function extractRelativeSpecifiers(source: string): string[] {
  return extractAllModuleSpecifiers(source).filter((spec) => spec.startsWith('./') || spec.startsWith('../'));
}

function resolveRelative(fromFile: string, spec: string, known: Set<string>): string | null {
  const baseDir = posix.dirname(fromFile.replace(/\\/g, '/'));
  const withoutExt = posix.normalize(posix.join(baseDir, spec));
  const candidates = [
    withoutExt,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => `${withoutExt}${ext}`),
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => `${withoutExt}/index${ext}`),
  ];
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Resolves a relative specifier against an importing file within a known file set (repo-relative POSIX). */
export function resolveRelativeInKnownSet(fromFile: string, spec: string, known: Set<string>): string | null {
  return resolveRelative(fromFile, spec, known);
}

export interface ImportGraph {
  edges: ImportEdge[];
  files: string[];
}

/**
 * Builds a relative-import graph over the source tree at `root`.
 * Deliberately lightweight (regex extraction): covers static and dynamic
 * relative imports but not tsconfig path aliases, module resolution
 * quirks or `export *` re-export chains beyond the `from` clause. The
 * gate documents this limitation; full AST analysis arrives with ts-morph
 * context tools (Phase 2).
 */
export async function buildImportGraph(root: string): Promise<ImportGraph> {
  const absoluteFiles = await listFiles(root);
  const rootPosix = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const files = absoluteFiles.map((f) => f.replace(/\\/g, '/').slice(rootPosix.length + 1));
  const known = new Set(files);
  const edges: ImportEdge[] = [];
  for (let i = 0; i < absoluteFiles.length; i += 1) {
    const abs = absoluteFiles[i] as string;
    let stats;
    try {
      stats = await stat(abs);
    } catch {
      continue;
    }
    if (stats.size > MAX_FILE_BYTES) continue;
    let source: string;
    try {
      source = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const from = files[i] as string;
    for (const spec of extractRelativeSpecifiers(source)) {
      const to = resolveRelative(from, spec, known);
      if (to !== null && to !== from) {
        edges.push({ from, to });
        if (edges.length > MAX_EDGES) {
          throw new GraphLimitExceededError(`repository exceeds ${MAX_EDGES} import edges`);
        }
      }
    }
  }
  return { edges, files };
}

/**
 * Finds import cycles via Tarjan SCC. Returns sorted member lists of SCCs
 * larger than one node, plus self-loops. Fingerprints (sorted join) drive
 * new-vs-inherited comparison.
 */
export function findCycles(edges: ImportEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const strongConnect = (node: string) => {
    indices.set(node, index);
    lowlink.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlink.set(node, Math.min(lowlink.get(node) as number, lowlink.get(next) as number));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node) as number, indices.get(next) as number));
      }
    }
    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let popped: string;
      do {
        popped = stack.pop() as string;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      if (component.length > 1) {
        cycles.push(component.sort());
      }
    }
  };

  for (const node of adjacency.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }
  // Self-loops (a file importing itself) are also cycles.
  for (const edge of edges) {
    if (edge.from === edge.to) cycles.push([edge.from]);
  }
  return cycles;
}

export function cycleFingerprint(members: string[]): string {
  return [...members].sort().join('::');
}
