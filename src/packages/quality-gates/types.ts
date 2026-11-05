import type { TaskContract } from '../contracts/task-contract.js';
import type { ResolvedPolicy } from '../contracts/policy.js';
import type { Violation } from '../policy-engine/violations.js';
import type { DiffSummary } from '../diff-inspector/git.js';
export type GateState = 'pass' | 'fail' | 'error' | 'not_applicable';

export interface GateResult {
  id: string;
  status: GateState;
  /** Mandatory gate in state fail or error blocks acceptance (diff-quality spec: "Mandatory gates"). */
  mandatory: boolean;
  durationMs: number;
  reason?: string;
  /** Path to gate-specific evidence, relative to the evidence bundle directory. */
  evidencePath?: string;
}

export interface EvidenceWriter {
  /** Writes a gate evidence artifact and returns its bundle-relative path. */
  write(gateId: string, fileName: string, content: string): Promise<string>;
}

/**
 * Lazy, memoized provider of the base commit's tree snapshot (used by
 * content gates for new-vs-inherited classification). Returns a failure
 * reason when the snapshot cannot be produced — gates must fail closed on
 * that instead of guessing attribution.
 */
export type BaselineSnapshotProvider = () => Promise<{ ok: true; dir: string } | { ok: false; reason: string }>;

export interface GateContext {
  repoDir: string;
  /** realpath of the repository root — the containment boundary for path checks. */
  repoRealRoot: string;
  headCommit: string;
  baseCommit: string;
  baseCommitInput: string;
  baseCommitSource: 'task' | 'cli-override';
  contract: TaskContract;
  contractHash: string;
  policy: ResolvedPolicy;
  diff: DiffSummary;
  evidence: EvidenceWriter;
  baselineSnapshot?: BaselineSnapshotProvider;
}

export interface GateArtifact {
  fileName: string;
  content: string;
}

export interface GateOutcome {
  status: GateState;
  reason?: string;
  violations?: Violation[];
  /** Protected-path touches already present in the base commit; evidence, not forgiveness. */
  baselineContext?: Violation[];
  artifacts?: GateArtifact[];
}

export interface Gate {
  id: string;
  run(ctx: GateContext): Promise<GateOutcome>;
}
