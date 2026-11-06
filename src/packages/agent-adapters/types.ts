import type { TaskRisk } from '../policy-engine/risk.js';

/**
 * Engine adapter contract (design.md §3, engine-adapter spec). EIL never
 * builds an agent loop: an engine adapter wraps ONE external engine (the
 * first implementation is Pi, task 3.4). This module defines the contract
 * plus a deterministic scripted adapter used for pipeline tests and the
 * benchmark harness — it executes an operator-supplied command and never
 * contacts a model.
 *
 * The adapter interface is stable so the Pi adapter can replace the scripted
 * one after the security review (1.7) and the data-transfer agreement:
 * callers depend only on EngineRunner.
 */

export interface EngineCapabilities {
  models: string[];
  supportsTokenUsage: boolean;
  supportsTools: boolean;
}

export interface EngineExecuteInput {
  /** Isolated workspace (fresh clone) the engine may modify. */
  workspaceDir: string;
  taskDescription: string;
  attemptNumber: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type AttemptStatus = 'complete' | 'failed' | 'aborted';

export interface AttemptResult {
  engine: string;
  model: string;
  startedAt: string;
  completedAt: string;
  status: AttemptStatus;
  /**
   * Usage is present ONLY when the engine reports real token counts; cost
   * fields stay absent otherwise (never fabricated — ledger stores
   * cost_kind 'unknown').
   */
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  artifacts: { logPath?: string; logContent?: string };
  /** Deterministic failure identifiers consumed by the cascade planner. */
  failureSignatures: string[];
}

export interface EngineRunner {
  readonly id: string;
  readonly model: string;
  capabilities(): EngineCapabilities;
  execute(input: EngineExecuteInput): Promise<AttemptResult>;
}

/** Failure signature taxonomy (consumed by policy-engine/cascade.ts). */
export const FAILURE_SIGNATURES = {
  commandTimeout: 'command:timeout',
  outputCap: 'command:output-cap',
  providerUnavailable: 'engine:provider-unavailable',
  exit: (code: number) => `engine:exit-${code}`,
} as const;

/** Risk level for cascade routing; classifier output feeds the planner. */
export type { TaskRisk };
