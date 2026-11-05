import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix, resolve } from 'node:path';
import ts from 'typescript';

/**
 * Public API surface extraction for TS packages — a reproducible declaration
 * signature check equivalent in spirit to API Extractor (design.md §8), built
 * on the TypeScript compiler API that ships with EIL (no new dependency).
 *
 * The fingerprint is deterministic given the same source tree: exports of the
 * package entry, sorted by name, with kind + fully-qualified type text
 * (interface/class/enum members included, so member changes are detected).
 */

export interface ApiSymbolRecord {
  name: string;
  kind: string;
  type: string;
}

export interface ApiExtractionSuccess {
  ok: true;
  records: ApiSymbolRecord[];
}

export interface ApiExtractionFailure {
  ok: false;
  reason: string;
}

export type ApiExtraction = ApiExtractionSuccess | ApiExtractionFailure;

/** Resolves the package's TS entry point: package.json types/typings, then index/src conventions. */
export function resolveTsEntry(packageDir: string): string | null {
  const manifestPath = join(packageDir, 'package.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { types?: string; typings?: string };
      for (const field of [manifest.types, manifest.typings]) {
        if (typeof field === 'string' && field.length > 0) {
          const candidate = resolve(join(packageDir, field));
          if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate;
        }
      }
    } catch {
      // malformed manifest: fall through to conventions
    }
  }
  for (const candidate of ['index.ts', 'src/index.ts', 'index.tsx', 'src/index.tsx']) {
    const absolute = join(packageDir, candidate);
    if (existsSync(absolute)) return absolute;
  }
  return null;
}

function kindOfSymbol(flags: ts.SymbolFlags): string {
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Variable) return 'variable';
  return 'symbol';
}

const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType | ts.TypeFormatFlags.InTypeAlias;

function describeMembers(checker: ts.TypeChecker, declared: ts.Type): string | null {
  const members = checker.getPropertiesOfType(declared);
  if (members.length === 0) return null;
  const parts: string[] = [];
  for (const member of members) {
    let memberType = 'unknown';
    try {
      const firstDecl = member.declarations?.[0];
      memberType =
        firstDecl !== undefined
          ? checker.typeToString(checker.getTypeOfSymbolAtLocation(member, firstDecl), undefined, TYPE_FORMAT_FLAGS)
          : checker.typeToString(checker.getDeclaredTypeOfSymbol(member), undefined, TYPE_FORMAT_FLAGS);
    } catch {
      memberType = 'unresolvable';
    }
    parts.push(`${member.name}: ${memberType}`);
  }
  return parts.sort().join('; ');
}

/** Extracts the public API records of a package entry file. */
export function extractPublicApi(entryPath: string): ApiExtraction {
  const absolute = resolve(entryPath);
  if (!existsSync(absolute)) return { ok: false, reason: `entry file not found: ${entryPath}` };
  try {
    const program = ts.createProgram([absolute], {
      noEmit: true,
      skipLibCheck: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    });
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(absolute);
    if (sourceFile === undefined) return { ok: false, reason: `entry not part of program: ${entryPath}` };

    const fileSymbol = checker.getSymbolAtLocation(sourceFile);
    const exports = fileSymbol !== undefined ? checker.getExportsOfModule(fileSymbol) : [];

    const byName = new Map<string, ts.Symbol>();
    for (const exported of exports) {
      const resolved = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
      byName.set(exported.getName(), resolved);
    }

    const records: ApiSymbolRecord[] = [];
    for (const [name, symbol] of [...byName.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const kind = kindOfSymbol(symbol.flags);
      let type: string;
      try {
        const declared = checker.getDeclaredTypeOfSymbol(symbol);
        if (kind === 'interface' || kind === 'class' || kind === 'enum') {
          const members = describeMembers(checker, declared);
          type = members !== null ? `${checker.typeToString(declared, undefined, TYPE_FORMAT_FLAGS)} { ${members} }` : checker.typeToString(declared, undefined, TYPE_FORMAT_FLAGS);
        } else {
          const firstDecl = symbol.declarations?.[0];
          type =
            firstDecl !== undefined
              ? checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, firstDecl), undefined, TYPE_FORMAT_FLAGS)
              : checker.typeToString(declared, undefined, TYPE_FORMAT_FLAGS);
        }
      } catch (error) {
        type = `unresolvable: ${error instanceof Error ? error.message : String(error)}`;
      }
      records.push({ name, kind, type });
    }
    return { ok: true, records };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `typescript extraction failed: ${message}` };
  }
}

export function apiRecordFingerprint(record: ApiSymbolRecord): string {
  return `${record.name}::${record.kind}::${record.type}`;
}

export function apiRecordsToMap(records: ApiSymbolRecord[]): Map<string, ApiSymbolRecord> {
  return new Map(records.map((r) => [r.name, r]));
}

export interface ApiSurfaceChange {
  removed: ApiSymbolRecord[];
  changed: { name: string; before: string; after: string }[];
  added: ApiSymbolRecord[];
}

/**
 * Compares baseline and current API surfaces. Removed exports and changed
 * signatures are breaking; added exports are not (recorded in evidence).
 */
export function compareApiSurface(baseline: ApiSymbolRecord[], current: ApiSymbolRecord[]): ApiSurfaceChange {
  const before = apiRecordsToMap(baseline);
  const after = apiRecordsToMap(current);
  const result: ApiSurfaceChange = { removed: [], changed: [], added: [] };
  for (const [name, record] of before) {
    const next = after.get(name);
    if (next === undefined) {
      result.removed.push(record);
    } else if (apiRecordFingerprint(next) !== apiRecordFingerprint(record)) {
      result.changed.push({ name, before: record.type, after: next.type });
    }
  }
  for (const [name, record] of after) {
    if (!before.has(name)) result.added.push(record);
  }
  return result;
}

/** Walks a changed repo-relative path up to the nearest directory with package.json. */
export function findPackageRootFor(repoRootReal: string, repoRelativePath: string): string | null {
  const segments = repoRelativePath.split('/');
  segments.pop(); // drop the file itself
  while (segments.length > 0) {
    const dir = join(repoRootReal, ...segments);
    if (existsSync(join(dir, 'package.json'))) return dir;
    segments.pop();
  }
  if (existsSync(join(repoRootReal, 'package.json'))) return repoRootReal;
  return null;
}

/** Formats a package dir as a repo-relative POSIX path for evidence. */
export function packageDirToRelative(repoRootReal: string, packageDir: string): string {
  const rel = posix.relative(repoRootReal.replace(/\\/g, '/'), packageDir.replace(/\\/g, '/'));
  return rel.length === 0 ? '.' : rel;
}

export function isWithinRoot(rootReal: string, candidate: string): boolean {
  const root = rootReal.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = candidate.replace(/\\/g, '/');
  return isAbsolute(path) && (path === root || path.startsWith(`${root}/`));
}
