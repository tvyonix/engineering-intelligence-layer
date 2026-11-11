import { z } from 'zod';

/**
 * Benchmark manifest (task 5.2, examples/benchmark.yaml). A/B/C variants run
 * against the SAME repository state, base commit, task list and criteria —
 * pairing is validated by the runner, and incomparable configurations are
 * recorded as such instead of being silently compared (evolution-benchmark
 * spec: results must not be declared causal for incomparable configs).
 */
export const benchmarkManifestSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, 'name must match ^[a-z0-9][a-z0-9._-]{2,63}$'),
    /** Informational fixture label; the runner takes the repository via --repo. */
    repoFixture: z.string().min(1),
    seed: z.number().int().min(0).optional(),
    variants: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
            agent: z.string().min(1),
            model: z.string().min(1),
            engineeringGates: z.boolean(),
            adaptiveRouting: z.boolean(),
            /**
             * Optional operator-supplied command executed in the isolated
             * workspace per step ("engine stand-in" for benchmarks without
             * an integrated agent runner). Subject to the execution policy:
             * host execution applies only to vetted repositories.
             */
            command: z.string().min(1).optional(),
            /** Default per-step task contract path (relative to the manifest). */
            taskFile: z.string().min(1).optional(),
            /** Default policy path for eil check after each step. */
            policyFile: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    steps: z
      .array(
        z
          .object({
            id: z.number().int().min(1),
            task: z.string().min(1),
            /** Per-step overrides of the variant defaults. */
            taskFile: z.string().min(1).optional(),
            policyFile: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    metrics: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type BenchmarkManifest = z.infer<typeof benchmarkManifestSchema>;

export interface ParsedManifestOk {
  ok: true;
  manifest: BenchmarkManifest;
}

export interface ParsedManifestFailure {
  ok: false;
  issues: string[];
}

export type ParsedManifest = ParsedManifestOk | ParsedManifestFailure;

export function parseBenchmarkManifest(input: unknown): ParsedManifest {
  const parsed = benchmarkManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      }),
    };
  }
  const manifest = parsed.data;
  const issues: string[] = [];

  const variantIds = new Set(manifest.variants.map((v) => v.id));
  if (variantIds.size !== manifest.variants.length) {
    issues.push('variant ids must be unique');
  }
  const stepIds = manifest.steps.map((s) => s.id);
  if (new Set(stepIds).size !== stepIds.length) {
    issues.push('step ids must be unique');
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, manifest };
}

/**
 * The declared experimental axes (design.md §11: engine, base model, task,
 * base commit, acceptance and runtime resources are held constant; only the
 * routing/treatment axes vary). Two variants are comparable when they use
 * the same execution command — differing commands mean different engines,
 * which the spec forbids treating as causal.
 */
export function variantFingerprint(variant: BenchmarkManifest['variants'][number]): Record<string, unknown> {
  return {
    agent: variant.agent,
    model: variant.model,
    command: variant.command ?? null,
    taskFile: variant.taskFile ?? null,
    policyFile: variant.policyFile ?? null,
  };
}

export interface ComparabilityReport {
  /** true when all variants share the execution configuration (commands, task/policy sources). */
  comparable: boolean;
  reasons: string[];
  fingerprints: Record<string, Record<string, unknown>>;
}

export function analyzeComparability(manifest: BenchmarkManifest): ComparabilityReport {
  const fingerprints: Record<string, Record<string, unknown>> = {};
  const reasons: string[] = [];
  const serialized = new Map<string, string[]>();
  for (const variant of manifest.variants) {
    const fingerprint = variantFingerprint(variant);
    fingerprints[variant.id] = fingerprint;
    const key = JSON.stringify(fingerprint);
    const holders = serialized.get(key) ?? [];
    holders.push(variant.id);
    serialized.set(key, holders);
  }
  if (serialized.size > 1) {
    const groups = [...serialized.values()].map((ids) => ids.sort().join('+'));
    reasons.push(`variants differ in execution configuration (commands/task/policy sources): ${groups.join(' vs ')} — results are NOT causal across these groups`);
  }
  if (manifest.variants.length < 2) {
    reasons.push('fewer than two variants: nothing to compare (run is recorded, not compared)');
  }
  return {
    comparable: serialized.size === 1 && manifest.variants.length >= 2,
    reasons,
    fingerprints,
  };
}
