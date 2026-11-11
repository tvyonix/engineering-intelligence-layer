import { z } from 'zod';

/**
 * Operator policy. This is privileged configuration, so unknown top-level
 * fields are rejected (fail closed on typos like `qualty`). The policy file
 * is the only source of executable gate commands and host-execution grants:
 * repository content can never grant itself execution.
 */
export const policySchema = z
  .object({
    version: z.literal(1),
    engines: z.unknown().optional(),
    models: z.unknown().optional(),
    routing: z.unknown().optional(),
    safety: z.unknown().optional(),
    /**
     * Opt-in design-system policy (task 1.5, Beaver-UI-style). Its presence
     * activates the `ds-conformance` gate; absence never blocks a repository
     * (diff-quality spec: design system rules apply only when explicitly
     * connected).
     */
    ds: z
      .object({
        registry: z.string().min(1),
        forbiddenComponents: z.array(z.string().min(1)).optional(),
        forbiddenProps: z.record(z.string(), z.array(z.string().min(1))).optional(),
        componentImports: z.array(z.string().min(1)).optional(),
        allowedImports: z.array(z.string().min(1)).optional(),
        forbidRawColors: z.boolean().optional(),
      })
      .strict()
      .optional(),
    quality: z
      .object({
        required: z.array(z.string().min(1)).min(1),
        /**
         * Authoritative gate commands, operator-controlled (never derived
         * from repository content). Keys are gate ids: types, lint, tests.
         */
        commands: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    /**
     * Host command execution is denied by default: until a sandbox runner is
     * approved (Linux VM/container), gate commands may only run inside
     * repositories explicitly vetted here by the operator.
     */
    execution: z
      .object({
        vettedRepos: z.array(z.string().min(1)),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
        maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
        /**
         * Operator-supplied engine command for `eil run` (task 3.6,
         * scripted stand-in until the Pi adapter): executed inside the
         * isolated workspace per attempt; `{attempt}` is substituted.
         * Source is privileged policy only — repository content can never
         * set it. Subject to the same vettedRepos gate as gate commands.
         */
        engineCommand: z.string().min(1).optional(),
        maxCheapRetries: z.number().int().min(0).max(10).optional(),
      })
      .strict()
      .optional(),
    /**
     * Dependency changes are approved by listing the manifest/lockfile paths
     * here. Editing this policy file IS the approval event (operator-owned).
     */
    dependencies: z
      .object({
        approvedFiles: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
    /**
     * Privileged allowlist for the eil-allow-secret-fixture marker: the
     * marker suppresses a finding ONLY in files matching these globs
     * (1.7 hardening — diff authors cannot self-allow secrets).
     */
    allowSecretFixtureMarkers: z.array(z.string().min(1)).optional(),
    /**
     * Operator-declared build artifacts whose exclusion (.gitignore) is
     * INTENTIONAL (node_modules, dist, evidence dirs). Everything else
     * hidden by an exclude mechanism stays a hidden-change violation.
     * Default: empty — every hidden path is reported.
     */
    workspaceIntegrity: z
      .object({
        ignoreHidden: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
    /** Import boundary rules for the `import-boundaries` gate. */
    boundaries: z
      .object({
        forbiddenImports: z
          .array(
            z
              .object({
                from: z.string().min(1),
                disallow: z.array(z.string().min(1)).min(1),
              })
              .strict(),
          )
          .optional(),
        forbidNewCycles: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;

export interface ResolvedPolicy {
  source: 'file' | 'default';
  quality: { required: string[]; commands?: Record<string, string> };
  ds?: {
    registry: string;
    forbiddenComponents?: string[];
    forbiddenProps?: Record<string, string[]>;
    componentImports?: string[];
    allowedImports?: string[];
    forbidRawColors?: boolean;
  };
  execution?: {
    vettedRepos: string[];
    timeoutMs?: number;
    maxOutputBytes?: number;
    engineCommand?: string;
    maxCheapRetries?: number;
  };
  allowSecretFixtureMarkers?: string[];
  workspaceIntegrity?: { ignoreHidden: string[] };
  dependencies?: { approvedFiles: string[] };
  boundaries?: {
    forbiddenImports?: { from: string; disallow: string[] }[];
    forbidNewCycles?: boolean;
  };
}

export const DEFAULT_REQUIRED_GATES: readonly string[] = ['path-scope', 'dependency-policy', 'secrets-scan', 'types', 'lint', 'tests'];

export function defaultPolicy(): ResolvedPolicy {
  return { source: 'default', quality: { required: [...DEFAULT_REQUIRED_GATES] } };
}

export interface ParsedPolicy {
  ok: true;
  policy: Policy;
}

export interface RejectedPolicy {
  ok: false;
  issues: string[];
}

export type ParsePolicyResult = ParsedPolicy | RejectedPolicy;

export function parsePolicy(input: unknown): ParsePolicyResult {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    return { ok: false, issues };
  }
  return { ok: true, policy: parsed.data };
}

export function toResolvedPolicy(policy: Policy, source: 'file' | 'default'): ResolvedPolicy {
  const resolved: ResolvedPolicy = {
    source,
    quality: { required: [...policy.quality.required] },
  };
  if (policy.quality.commands !== undefined) {
    resolved.quality.commands = { ...policy.quality.commands };
  }
  if (policy.ds !== undefined) {
    resolved.ds = {
      registry: policy.ds.registry,
      forbiddenComponents: policy.ds.forbiddenComponents !== undefined ? [...policy.ds.forbiddenComponents] : undefined,
      forbiddenProps:
        policy.ds.forbiddenProps !== undefined
          ? Object.fromEntries(Object.entries(policy.ds.forbiddenProps).map(([k, v]) => [k, [...v]]))
          : undefined,
      componentImports: policy.ds.componentImports !== undefined ? [...policy.ds.componentImports] : undefined,
      allowedImports: policy.ds.allowedImports !== undefined ? [...policy.ds.allowedImports] : undefined,
      forbidRawColors: policy.ds.forbidRawColors,
    };
  }
  if (policy.execution !== undefined) {
    resolved.execution = {
      vettedRepos: [...policy.execution.vettedRepos],
      timeoutMs: policy.execution.timeoutMs,
      maxOutputBytes: policy.execution.maxOutputBytes,
      engineCommand: policy.execution.engineCommand,
      maxCheapRetries: policy.execution.maxCheapRetries,
    };
  }
  if (policy.allowSecretFixtureMarkers !== undefined) {
    resolved.allowSecretFixtureMarkers = [...policy.allowSecretFixtureMarkers];
  }
  if (policy.workspaceIntegrity !== undefined) {
    resolved.workspaceIntegrity = { ignoreHidden: [...policy.workspaceIntegrity.ignoreHidden] };
  }
  if (policy.dependencies !== undefined) {
    resolved.dependencies = { approvedFiles: [...policy.dependencies.approvedFiles] };
  }
  if (policy.boundaries !== undefined) {
    resolved.boundaries = {
      forbiddenImports: policy.boundaries.forbiddenImports?.map((r) => ({ from: r.from, disallow: [...r.disallow] })),
      forbidNewCycles: policy.boundaries.forbidNewCycles,
    };
  }
  return resolved;
}
