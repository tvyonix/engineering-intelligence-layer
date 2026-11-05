import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { EvidenceWriter } from '../quality-gates/types.js';
import type { CheckVerdict } from '../quality-gates/run-gates.js';
import type { Violation } from '../policy-engine/violations.js';

export const gateResultSchema = z
  .object({
    id: z.string(),
    status: z.enum(['pass', 'fail', 'error', 'not_applicable']),
    mandatory: z.boolean(),
    durationMs: z.number().nonnegative(),
    reason: z.string().optional(),
    evidencePath: z.string().optional(),
  })
  .strict();

export const violationSchema = z
  .object({
    rule: z.string(),
    path: z.string(),
    detail: z.string(),
    classification: z.enum(['new', 'inherited', 'baseline_context']),
  })
  .strict();

/**
 * Evidence bundle for check mode (delivery-evidence spec). Cost fields stay
 * absent: check mode runs no model API calls, and EIL never fabricates $0.00
 * for unknown spend (design.md §10). `humanAccepted` is never set here —
 * acceptance is a separate human event, not a gate result.
 */
export const evidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    eilVersion: z.string(),
    mode: z.literal('check-only'),
    taskId: z.string(),
    contractHash: z.string(),
    baseCommitInput: z.string(),
    baseCommit: z.string(),
    baseCommitSource: z.enum(['task', 'cli-override']),
    headCommit: z.string(),
    worktreeDirty: z.boolean(),
    untrackedFiles: z.number().int().nonnegative(),
    gateResults: z.array(gateResultSchema),
    policyViolations: z.array(violationSchema),
    baselineContext: z.array(violationSchema),
    verdict: z.enum(['blocked', 'error', 'needs_review']),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    diffPath: z.string().nullable(),
    fullLogsDirectory: z.string(),
    /** Acceptance commands are recorded, never executed in check mode. */
    acceptanceCommandsExecuted: z.literal(false),
    humanAccepted: z.boolean().optional(),
    estimatedUsd: z.number().optional(),
  })
  .strict();

export type GateResultRecord = z.infer<typeof gateResultSchema>;
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export interface EvidencePaths {
  bundle: string;
  summary: string;
  logsDirectory: string;
}

export class FsEvidenceWriter implements EvidenceWriter {
  constructor(private readonly bundleDir: string) {}

  async write(gateId: string, fileName: string, content: string): Promise<string> {
    const logsDir = join(this.bundleDir, 'logs');
    await mkdir(logsDir, { recursive: true });
    const relative = join('logs', `${gateId}--${fileName}`);
    await writeFile(join(this.bundleDir, relative), content, 'utf8');
    return relative;
  }

  logsDirectory(): string {
    return join(this.bundleDir, 'logs');
  }
}

export function buildEvidenceBundle(params: {
  generatedAt: string;
  eilVersion: string;
  taskId: string;
  contractHash: string;
  baseCommitInput: string;
  baseCommit: string;
  baseCommitSource: 'task' | 'cli-override';
  headCommit: string;
  diff: { worktreeDirty: boolean; untracked: string[] };
  gateResults: GateResultRecord[];
  violations: Violation[];
  baselineContext: Violation[];
  verdict: CheckVerdict;
  exitCode: 0 | 1 | 2;
  diffPath: string | null;
  fullLogsDirectory: string;
}): EvidenceBundle {
  return evidenceBundleSchema.parse({
    schemaVersion: 1,
    generatedAt: params.generatedAt,
    eilVersion: params.eilVersion,
    mode: 'check-only',
    taskId: params.taskId,
    contractHash: params.contractHash,
    baseCommitInput: params.baseCommitInput,
    baseCommit: params.baseCommit,
    baseCommitSource: params.baseCommitSource,
    headCommit: params.headCommit,
    worktreeDirty: params.diff.worktreeDirty,
    untrackedFiles: params.diff.untracked.length,
    gateResults: params.gateResults,
    policyViolations: params.violations,
    baselineContext: params.baselineContext,
    verdict: params.verdict,
    exitCode: params.exitCode,
    diffPath: params.diffPath,
    fullLogsDirectory: params.fullLogsDirectory,
    acceptanceCommandsExecuted: false,
  });
}

const STATUS_GLYPH: Record<string, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  error: 'ERROR',
  not_applicable: 'N/A ',
};

/** Human-readable summary for review (delivery-evidence spec). */
export function renderSummaryMarkdown(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`# EIL check — ${bundle.taskId}`);
  lines.push('');
  lines.push(`- **Verdict:** \`${bundle.verdict}\` (exit code ${bundle.exitCode})`);
  lines.push(`- **Mode:** ${bundle.mode} (no agent, no model API calls)`);
  lines.push(`- **Contract:** ${bundle.contractHash}`);
  lines.push(`- **Base commit:** \`${bundle.baseCommit.slice(0, 12)}\` (from ${bundle.baseCommitSource})`);
  lines.push(`- **Head commit:** \`${bundle.headCommit.slice(0, 12)}\``);
  lines.push(`- **Worktree dirty:** ${bundle.worktreeDirty ? 'yes' : 'no'}; untracked files: ${bundle.untrackedFiles}`);
  lines.push(`- **Generated at:** ${bundle.generatedAt} by EIL ${bundle.eilVersion}`);
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  lines.push('| Gate | Status | Mandatory | Duration | Reason |');
  lines.push('|------|--------|-----------|----------|--------|');
  for (const gate of bundle.gateResults) {
    const reason = gate.reason ?? '';
    lines.push(
      `| ${gate.id} | ${STATUS_GLYPH[gate.status] ?? gate.status} | ${gate.mandatory ? 'yes' : 'no'} | ${gate.durationMs} ms | ${reason.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  if (bundle.policyViolations.length > 0) {
    lines.push(`## Policy violations (${bundle.policyViolations.length})`);
    lines.push('');
    for (const violation of bundle.policyViolations) {
      lines.push(`- \`${violation.rule}\` — \`${violation.path}\` — ${violation.detail} [${violation.classification}]`);
    }
    lines.push('');
  }
  if (bundle.baselineContext.length > 0) {
    lines.push(`## Baseline context (${bundle.baselineContext.length})`);
    lines.push('');
    lines.push('Protected paths already modified by the base commit itself. Attribution evidence only — not a pass condition.');
    lines.push('');
    for (const violation of bundle.baselineContext) {
      lines.push(`- \`${violation.rule}\` — \`${violation.path}\` — ${violation.detail}`);
    }
    lines.push('');
  }
  lines.push('## What this means');
  lines.push('');
  if (bundle.verdict === 'blocked') {
    lines.push('A mandatory gate failed. The change cannot be accepted regardless of any model or reviewer opinion of the code itself. Fix the listed violations.');
  } else if (bundle.verdict === 'error') {
    lines.push('The check is incomplete: at least one mandatory gate errored or is not implemented in this EIL build. EIL fails closed — incomplete verification never counts as success.');
  } else {
    lines.push('All mandatory gates passed. This is not acceptance: human review is required before any merge. EIL never merges.');
  }
  lines.push('');
  lines.push(`Full logs: \`${bundle.fullLogsDirectory}\``);
  if (bundle.diffPath !== null) {
    lines.push(`Diff: \`${bundle.diffPath}\``);
  }
  lines.push('');
  return lines.join('\n');
}

export async function writeEvidenceBundle(
  bundleDir: string,
  bundle: EvidenceBundle,
  summaryMarkdown: string,
  extraLogs: { fileName: string; content: string }[],
): Promise<EvidencePaths> {
  await mkdir(join(bundleDir, 'logs'), { recursive: true });
  const bundlePath = join(bundleDir, 'evidence.json');
  const summaryPath = join(bundleDir, 'summary.md');
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  await writeFile(summaryPath, summaryMarkdown, 'utf8');
  for (const log of extraLogs) {
    await writeFile(join(bundleDir, 'logs', log.fileName), log.content, 'utf8');
  }
  return { bundle: bundlePath, summary: summaryPath, logsDirectory: join(bundleDir, 'logs') };
}
