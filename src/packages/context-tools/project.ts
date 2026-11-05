import { Project, type SourceFile } from 'ts-morph';

export class ContextLimitExceededError extends Error {}

const SKIPPED_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.eil'];
export const MAX_PROJECT_FILES = 20_000;

/**
 * Creates a ts-morph project over the repository source tree (read-only).
 * No persistent graph is kept — the project lives for the duration of one
 * tool call (design.md: "без обязательного постоянного Code Graph").
 */
export function createProject(repoRoot: string): Project {
  const include = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].map((ext) => `${repoRoot}/**/*.${ext}`);
  const exclude = SKIPPED_DIRS.map((dir) => `!${repoRoot}/${dir}/**`);
  const project = new Project({
    compilerOptions: { allowJs: true },
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([...include, ...exclude]);
  const count = project.getSourceFiles().length;
  if (count > MAX_PROJECT_FILES) {
    throw new ContextLimitExceededError(`repository exceeds ${MAX_PROJECT_FILES} scannable source files (${count})`);
  }
  if (count === 0) {
    throw new ContextLimitExceededError('no source files found in repository');
  }
  return project;
}

/** Finds a source file by repo-relative POSIX path (or absolute path inside the repo). */
export function findSourceFile(project: Project, repoRoot: string, relativePath: string): SourceFile | undefined {
  const absolute = relativePath.startsWith('/')
    ? relativePath
    : `${repoRoot.replace(/\/+$/, '')}/${relativePath}`;
  const file = project.getSourceFile(absolute);
  if (file !== undefined) return file;
  // ts-morph may have normalized the path differently (case, symlinks).
  return project.getSourceFiles().find((f) => f.getFilePath().replace(/\\/g, '/').endsWith(relativePath));
}
