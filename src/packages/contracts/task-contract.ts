import { z } from 'zod';
import picomatch from 'picomatch';

export const TASK_CONTRACT_VERSION = 1 as const;

/**
 * A repo-root-relative glob pattern. Patterns are anchored at the repository
 * root, use forward slashes and may never traverse above the root: the runtime
 * scope gate treats the repository root as the containment boundary, so a
 * pattern that tries to escape it is a contract error, not a runtime warning.
 */
const globPattern = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !v.includes('\0'), 'pattern must not contain NUL bytes')
  .refine((v) => !v.includes('\\'), 'pattern must use forward slashes, not backslashes')
  .refine((v) => !v.startsWith('/'), 'pattern must be relative to the repository root (no leading "/")')
  .refine((v) => !v.split('/').includes('..'), 'pattern must not contain ".." segments (repo-root-relative only)');

const acceptanceItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    description: z.string().min(1),
    /**
     * Optional verification command. Phase 0 (`eil check`) records it in the
     * evidence bundle but never executes it: check mode runs no commands from
     * repository content.
     */
    command: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const taskContractSchema = z
  .object({
    version: z.literal(TASK_CONTRACT_VERSION),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, 'id must match ^[a-z0-9][a-z0-9._-]{2,63}$'),
    /** Git ref or SHA the change is evaluated against. Resolved against the target repository at check time. */
    baseCommit: z.string().min(1).max(128),
    description: z.string().min(1),
    scope: z
      .object({
        allow: z.array(globPattern).min(1),
        protect: z.array(globPattern),
      })
      .strict(),
    acceptance: z.array(acceptanceItemSchema).min(1),
    policy: z
      .object({
        maxUsd: z.number().positive().finite().optional(),
        maxAttempts: z.number().int().min(1).max(100),
        noNewDependencies: z.boolean(),
      })
      .strict(),
    riskHints: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type TaskContract = z.infer<typeof taskContractSchema>;

/**
 * Detects whether a wide (allow) glob pattern covers a narrow (protect)
 * pattern syntactically. Glob-set intersection is not decidable in general;
 * this is a best-effort conservative check:
 *   1. exact/equal patterns;
 *   2. directory-prefix containment after stripping trailing `*`/`**`
 *      segments (allow `src/**` covers protect `src/secrets/**`);
 *   3. literal protect pattern matched by the allow glob directly.
 *
 * Overlap is NOT a contract error (TL decision, 2026-11-05): the runtime
 * scope gate enforces `protect > allow` per changed file, so an allow
 * pattern that touches a protected area is safe and useful for ordinary
 * development scenarios (allow `src/**`, protect `src/index.ts`). Overlap
 * is surfaced as a contract warning instead, and the agent can never widen
 * protection by editing the task contract.
 */
export function globCovers(wide: string, narrow: string): boolean {
  if (wide === narrow) return true;
  const wideBase = globDirectoryBase(wide);
  const narrowBase = globDirectoryBase(narrow);
  if (wideBase === '') return true; // '**' / '*' cover everything
  if (narrowBase === '') return false; // narrow is a catch-all, wide cannot contain it
  if (narrowBase === wideBase || narrowBase.startsWith(`${wideBase}/`)) return true;
  if (!containsGlobMeta(narrow)) {
    // narrow is a literal path: let the matcher decide (e.g. allow 'src/*.ts', protect 'src/index.ts')
    return picomatch.isMatch(narrow, wide, { dot: true });
  }
  return false;
}

function containsGlobMeta(pattern: string): boolean {
  return /[*?[\]{}!]/.test(pattern.replace(/\\!/g, ''));
}

/** Strips trailing `*`/`**` glob segments; returns the fixed directory prefix ('' = catch-all). */
function globDirectoryBase(pattern: string): string {
  const segments = pattern.split('/');
  while (segments.length > 0) {
    const last = segments[segments.length - 1] as string | undefined;
    if (last === '*' || last === '**') {
      segments.pop();
      continue;
    }
    if (last !== undefined && last.includes('*')) break; // e.g. 'src/*.ts' — keep as is
    break;
  }
  return segments.join('/');
}

/**
 * Overlap between allow and protect is reported as warnings, not errors
 * (TL decision, 2026-11-05): runtime enforcement `protect > allow` makes
 * overlapping scopes safe. Warnings are recorded in check output so an
 * operator notices when an allow pattern subsumes protection.
 */
export function scopeOverlapWarnings(scope: TaskContract['scope']): string[] {
  const warnings: string[] = [];
  for (const allowPattern of scope.allow) {
    for (const protectPattern of scope.protect) {
      if (allowPattern === protectPattern) {
        warnings.push(
          `scope overlap: allow pattern '${allowPattern}' is identical to protect pattern '${protectPattern}'; runtime protection takes precedence`,
        );
        continue;
      }
      if (globCovers(allowPattern, protectPattern)) {
        warnings.push(
          `scope overlap: allow pattern '${allowPattern}' covers protected pattern '${protectPattern}'; runtime protection takes precedence`,
        );
      }
    }
  }
  return warnings;
}

export interface ParsedTaskContract {
  ok: true;
  contract: TaskContract;
  contractHash: string;
  /** Non-blocking observations (e.g. allow/protect overlap). Recorded in output. */
  warnings: string[];
}

export interface RejectedTaskContract {
  ok: false;
  issues: string[];
}

export type ParseTaskContractResult = ParsedTaskContract | RejectedTaskContract;

export function parseTaskContract(input: unknown, hashContract: (c: TaskContract) => string): ParseTaskContractResult {
  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    return { ok: false, issues };
  }
  const contract = parsed.data;
  return { ok: true, contract, contractHash: hashContract(contract), warnings: scopeOverlapWarnings(contract.scope) };
}
