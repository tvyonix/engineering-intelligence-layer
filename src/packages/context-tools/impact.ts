import { SyntaxKind, type Project } from 'ts-morph';
import { resolveRelativeInKnownSet } from '../quality-gates/import-graph.js';

export interface ImpactReport {
  /** Repo-relative POSIX paths of the change under analysis. */
  changedFiles: string[];
  /** Files transitively importing changed files (excluding the changed ones). */
  affectedFiles: string[];
  /** Affected files that look like tests (tests/ dirs, *.test.*, *.spec.*). */
  affectedTests: string[];
  /**
   * 'static-import-analysis': the result covers static imports/exports and
   * literal dynamic imports only. Never claim completeness.
   */
  completeness: 'static-import-analysis';
  potentiallyIncomplete: boolean;
  notes: string[];
  truncated: boolean;
}

export const MAX_AFFECTED = 200;
const MAX_DYNAMIC_NONLITERAL_REPORTED = 50;

const TEST_PATTERN = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;

function toRelative(repoRoot: string, filePath: string): string {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

/**
 * Task 2.3: `impact(diff)` — reverse dependency analysis over static
 * imports/exports and literal dynamic imports. Returns *potentially
 * affected* files and tests; it SHALL NOT claim completeness: non-literal
 * dynamic imports (specifiers built at runtime), reflection and re-export
 * side effects are outside this analysis and are reported explicitly.
 */
export function computeImpact(project: Project, repoRoot: string, changedRelativePaths: string[]): ImpactReport {
  const sourceFiles = project.getSourceFiles();
  const known = new Set(
    sourceFiles.map((f) => toRelative(repoRoot, f.getFilePath())),
  );

  // Build reverse import graph: target (imported file) -> importers.
  const reverse = new Map<string, Set<string>>();
  const addEdge = (fromRel: string, toAbs: string | undefined) => {
    if (toAbs === undefined) return;
    const toRel = toRelative(repoRoot, toAbs);
    if (!known.has(toRel) || toRel === fromRel) return;
    const importers = reverse.get(toRel) ?? new Set<string>();
    importers.add(fromRel);
    reverse.set(toRel, importers);
  };

  let nonLiteralDynamic = 0;
  for (const sourceFile of sourceFiles) {
    const fromRel = toRelative(repoRoot, sourceFile.getFilePath());
    for (const importDecl of sourceFile.getImportDeclarations()) {
      addEdge(fromRel, importDecl.getModuleSpecifierSourceFile()?.getFilePath());
    }
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      addEdge(fromRel, exportDecl.getModuleSpecifierSourceFile()?.getFilePath());
    }
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expressionText = call.getExpression().getText();
      if (expressionText !== 'import' && expressionText !== 'require') continue;
      const argument = call.getArguments()[0];
      if (argument === undefined) continue;
      if (argument.getKind() === SyntaxKind.StringLiteral) {
        const spec = argument.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const resolved = resolveRelativeInKnownSet(fromRel, spec, known);
          if (resolved !== null) {
            const importers = reverse.get(resolved) ?? new Set<string>();
            importers.add(fromRel);
            reverse.set(resolved, importers);
          }
        }
      } else {
        nonLiteralDynamic += 1;
      }
    }
  }

  const changed = [...new Set(changedRelativePaths)].filter((p) => known.has(p));
  const changedSet = new Set(changed);

  // BFS over reverse edges: everything that transitively imports a changed file.
  const affected = new Set<string>();
  const queue = [...changed];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const importer of reverse.get(current) ?? []) {
      if (changedSet.has(importer) || affected.has(importer)) continue;
      affected.add(importer);
      queue.push(importer);
      if (affected.size >= MAX_AFFECTED) {
        // Stop expanding; the report is explicitly truncated.
        queue.length = 0;
        break;
      }
    }
  }
  const affectedList = [...affected].sort();
  const truncated = affected.size >= MAX_AFFECTED;

  const affectedTests = [...changed, ...affectedList].filter((p) => TEST_PATTERN.test(p)).sort();

  const notes: string[] = [];
  let potentiallyIncomplete = false;
  if (nonLiteralDynamic > 0) {
    potentiallyIncomplete = true;
    notes.push(
      `${Math.min(nonLiteralDynamic, MAX_DYNAMIC_NONLITERAL_REPORTED)} non-literal dynamic import(s) detected` +
        `${nonLiteralDynamic > MAX_DYNAMIC_NONLITERAL_REPORTED ? ' (reported count capped)' : ''}; ` +
        'impact analysis covers static imports/exports and literal dynamic imports only — runtime-built specifiers, reflection and re-export side effects are not tracked',
    );
  }
  if (truncated) {
    potentiallyIncomplete = true;
    notes.push(`affected set reached the ${MAX_AFFECTED}-file cap; the list is incomplete`);
  }

  return {
    changedFiles: [...changedSet].sort(),
    affectedFiles: affectedList,
    affectedTests,
    completeness: 'static-import-analysis',
    potentiallyIncomplete,
    notes,
    truncated,
  };
}
