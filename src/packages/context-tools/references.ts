import { SyntaxKind, type Project } from 'ts-morph';
import { findSourceFile } from './project.js';

export interface SymbolReference {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  kind: 'declaration' | 'reference';
  /** Trimmed source text of the containing line (bounded). */
  lineText: string;
}

export interface SymbolReferences {
  symbol: string;
  file: string;
  declaration: SymbolReference | null;
  references: SymbolReference[];
  /** true when the reference list was capped and is therefore incomplete. */
  truncated: boolean;
}

export const MAX_REFERENCES = 200;

interface RawReferenceEntry {
  fileName: string;
  textSpan: { start: number; length: number };
}

function toRelative(repoRoot: string, filePath: string): string {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function describe(project: Project, repoRoot: string, entry: RawReferenceEntry, queryFile: string, queryPos: number): SymbolReference | null {
  const sourceFile = project.getSourceFile(entry.fileName);
  if (sourceFile === undefined) return null;
  const lineInfo = sourceFile.getLineAndColumnAtPos(entry.textSpan.start);
  const endInfo = sourceFile.getLineAndColumnAtPos(entry.textSpan.start + entry.textSpan.length);
  const lineText = (sourceFile.getFullText().split('\n')[lineInfo.line - 1] ?? '').trim();
  const isDeclaration =
    entry.fileName.replace(/\\/g, '/') === queryFile.replace(/\\/g, '/') && entry.textSpan.start === queryPos;
  return {
    file: toRelative(repoRoot, entry.fileName),
    line: lineInfo.line,
    column: lineInfo.column,
    endLine: endInfo.line,
    endColumn: endInfo.column,
    kind: isDeclaration ? 'declaration' : 'reference',
    lineText: lineText.slice(0, 200),
  };
}

/**
 * Task 2.2: `references(symbol)` — exact coordinates (file, line, column,
 * end) of the declaration and all references found by the TypeScript
 * language service, with bounded output. Paths outside the repository root
 * stay absolute (they are still exact coordinates, just not repo-relative).
 */
export function findSymbolReferences(
  project: Project,
  repoRoot: string,
  relativePath: string,
  name: string,
): SymbolReferences {
  const file = findSourceFile(project, repoRoot, relativePath);
  if (file === undefined) {
    throw new Error(`source file not found in project: ${relativePath}`);
  }
  const identifiers = file.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => id.getText() === name);
  if (identifiers.length === 0) {
    return { symbol: name, file: relativePath, declaration: null, references: [], truncated: false };
  }
  // Prefer an identifier that is not a property access name (obj.name).
  const target =
    identifiers.find((id) => id.getParent()?.getKind() !== SyntaxKind.PropertyAccessExpression) ?? identifiers[0];
  if (target === undefined) {
    return { symbol: name, file: relativePath, declaration: null, references: [], truncated: false };
  }
  const position = target.getStart();
  const queryFilePath = file.getFilePath().replace(/\\/g, '/');

  const languageService = project.getLanguageService().compilerObject;
  const raw = languageService.findReferences(file.getFilePath(), position) ?? [];

  const references: SymbolReference[] = [];
  let declaration: SymbolReference | null = null;
  let truncated = false;
  outer: for (const referenced of raw) {
    for (const entry of referenced.references) {
      if (references.length >= MAX_REFERENCES && declaration !== null) {
        truncated = true;
        break outer;
      }
      const described = describe(project, repoRoot, entry, queryFilePath, position);
      if (described === null) continue;
      if (described.kind === 'declaration' && declaration === null) {
        declaration = described;
        continue;
      }
      references.push(described);
    }
  }

  return { symbol: name, file: relativePath, declaration, references, truncated };
}
