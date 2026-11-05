import { SyntaxKind, type Project } from 'ts-morph';
import { findSourceFile } from './project.js';

export interface SymbolRecord {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'reexport';
  exported: boolean;
  /** Bounded declaration header (body stripped). One record per overload signature. */
  signature: string;
  line: number;
  /** Total signatures sharing this name when the symbol has overloads. */
  overloadGroup?: number;
}

export interface ReexportRecord {
  name: string;
  source: string;
}

export interface FileSymbols {
  file: string;
  declarations: SymbolRecord[];
  reexports: ReexportRecord[];
  /** true when the output was capped and is therefore incomplete. */
  truncated: boolean;
}

export const MAX_SYMBOLS = 100;
const MAX_SIGNATURE_CHARS = 400;

function headerOf(text: string): string {
  const brace = text.indexOf('{');
  const header = brace > 0 ? text.slice(0, brace).trimEnd() : text.trimEnd();
  return header.length > MAX_SIGNATURE_CHARS
    ? `${header.slice(0, MAX_SIGNATURE_CHARS)}…`
    : header.replace(/\s+/g, ' ');
}

/**
 * Task 2.1: `symbols(file)` — named top-level declarations with export
 * status, overload signatures and re-exports, with bounded output.
 * Signatures are header-only: no implementation bodies are returned.
 */
export function getFileSymbols(project: Project, repoRoot: string, relativePath: string): FileSymbols {
  const file = findSourceFile(project, repoRoot, relativePath);
  if (file === undefined) {
    throw new Error(`source file not found in project: ${relativePath}`);
  }
  // Names exported via `export { x }` lists (without inline `export` keyword).
  const exportedNames = new Set(file.getExportSymbols().map((s) => s.getName()));

  const declarations: SymbolRecord[] = [];
  const reexports: ReexportRecord[] = [];
  let truncated = false;

  // Overload groups: count same-name function declarations first.
  const overloadCounts = new Map<string, number>();
  for (const statement of file.getStatements()) {
    if (statement.getKind() === SyntaxKind.FunctionDeclaration) {
      const name = statement.asKindOrThrow(SyntaxKind.FunctionDeclaration).getName();
      if (name !== undefined) overloadCounts.set(name, (overloadCounts.get(name) ?? 0) + 1);
    }
  }

  for (const statement of file.getStatements()) {
    if (declarations.length >= MAX_SYMBOLS && reexports.length >= MAX_SYMBOLS) {
      truncated = true;
      break;
    }
    if (statement.getKind() === SyntaxKind.ExportDeclaration) {
      const exportDecl = statement.asKindOrThrow(SyntaxKind.ExportDeclaration);
      const source = exportDecl.getModuleSpecifier()?.getLiteralText();
      if (source !== undefined) {
        const named = exportDecl.getNamedExports();
        if (named.length > 0) {
          for (const namedExport of named) {
            reexports.push({ name: namedExport.getName(), source });
          }
        } else {
          reexports.push({ name: '*', source });
        }
        continue;
      }
      // local `export { x }`: mark names as exported
      for (const namedExport of exportDecl.getNamedExports()) {
        exportedNames.add(namedExport.getName());
      }
      continue;
    }
    const kind = mapKind(statement.getKind());
    if (kind === null) continue;

    if (statement.getKind() === SyntaxKind.VariableStatement) {
      const variableStatement = statement.asKindOrThrow(SyntaxKind.VariableStatement);
      const exported = variableStatement.isExported();
      for (const variable of variableStatement.getDeclarationList().getDeclarations()) {
        const nameNode = variable.getNameNode();
        const name = nameNode.getKind() === SyntaxKind.Identifier ? nameNode.getText() : `<${nameNode.getKindName()}>`;
        if (declarations.length >= MAX_SYMBOLS) {
          truncated = true;
          break;
        }
        declarations.push({
          name,
          kind: 'variable',
          exported: exported || exportedNames.has(name),
          signature: headerOf(variable.getText()),
          line: variable.getStartLineNumber(),
        });
      }
      continue;
    }

    const named =
      statement.asKind(SyntaxKind.FunctionDeclaration) ??
      statement.asKind(SyntaxKind.ClassDeclaration) ??
      statement.asKind(SyntaxKind.InterfaceDeclaration) ??
      statement.asKind(SyntaxKind.EnumDeclaration) ??
      statement.asKind(SyntaxKind.TypeAliasDeclaration);
    if (named === null || named === undefined) continue;
    const name = named.getName();
    if (name === undefined) continue;
    const exported = named.isExported() || exportedNames.has(name);
    if (declarations.length >= MAX_SYMBOLS) {
      truncated = true;
      break;
    }
    const overloadGroup = overloadCounts.get(name);
    declarations.push({
      name,
      kind,
      exported,
      signature: headerOf(named.getText()),
      line: named.getStartLineNumber(),
      ...(overloadGroup !== undefined && overloadGroup > 1 ? { overloadGroup } : {}),
    });
  }

  return {
    file: relativePath,
    declarations,
    reexports: reexports.slice(0, MAX_SYMBOLS),
    truncated: truncated || reexports.length > MAX_SYMBOLS,
  };
}

function mapKind(kind: SyntaxKind): SymbolRecord['kind'] | null {
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
      return 'function';
    case SyntaxKind.ClassDeclaration:
      return 'class';
    case SyntaxKind.InterfaceDeclaration:
      return 'interface';
    case SyntaxKind.EnumDeclaration:
      return 'enum';
    case SyntaxKind.TypeAliasDeclaration:
      return 'type';
    case SyntaxKind.VariableStatement:
      return 'variable';
    default:
      return null;
  }
}
