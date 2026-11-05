import type { TaskContract } from '../contracts/task-contract.js';
import type { EvidenceBundle } from './bundle.js';

function esc(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * Task 2.6: Task Record — the human-readable record of what happened to a
 * task, stored in the evidence folder. It separates machine gate status
 * from human acceptance (always absent/pending in check mode) and states
 * cost veracity honestly (check mode makes no model API calls, so cost is
 * unknown, never zero).
 */
export function renderTaskRecordMarkdown(contract: TaskContract, bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`# Task Record — ${contract.id}`);
  lines.push('');
  lines.push(`- **Task:** ${contract.id} — ${contract.description}`);
  lines.push(`- **Contract:** \`${bundle.contractHash}\` (version ${contract.version})`);
  lines.push(`- **Base commit:** \`${bundle.baseCommit.slice(0, 12)}\` (input \`${bundle.baseCommitInput}\`, source: ${bundle.baseCommitSource})`);
  lines.push(`- **Head commit:** \`${bundle.headCommit.slice(0, 12)}\``);
  lines.push(`- **Run:** ${bundle.mode}, generated ${bundle.generatedAt} by EIL ${bundle.eilVersion}`);
  lines.push(`- **Verdict:** \`${bundle.verdict}\` (exit code ${bundle.exitCode})`);
  if (bundle.risk !== undefined) {
    lines.push(`- **Risk (deterministic):** \`${bundle.risk}\``);
    for (const reason of bundle.riskReasons ?? []) {
      lines.push(`  - ${reason}`);
    }
  }
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push(`- allow: ${contract.scope.allow.map((p) => `\`${p}\``).join(', ')}`);
  lines.push(`- protect: ${contract.scope.protect.length > 0 ? contract.scope.protect.map((p) => `\`${p}\``).join(', ') : '—'}`);
  lines.push(`- maxAttempts: ${contract.policy.maxAttempts}; noNewDependencies: ${contract.policy.noNewDependencies}${contract.policy.maxUsd !== undefined ? `; maxUsd: ${contract.policy.maxUsd}` : ''}`);
  if (contract.riskHints !== undefined && contract.riskHints.length > 0) {
    lines.push(`- risk hints: ${contract.riskHints.map((h) => `\`${h}\``).join(', ')}`);
  }
  lines.push('');
  lines.push('## Acceptance criteria');
  lines.push('');
  lines.push('| Criterion | Description | Verification command | Status |');
  lines.push('|-----------|-------------|----------------------|--------|');
  for (const item of contract.acceptance) {
    lines.push(
      `| ${esc(item.id)} | ${esc(item.description)} | ${item.command !== undefined ? `\`${esc(item.command)}\`` : '—'} | recorded, not executed in check mode |`,
    );
  }
  lines.push('');
  lines.push('## Gate results');
  lines.push('');
  lines.push('| Gate | Status | Mandatory | Duration | Reason |');
  lines.push('|------|--------|-----------|----------|--------|');
  for (const gate of bundle.gateResults) {
    lines.push(`| ${gate.id} | \`${gate.status}\` | ${gate.mandatory ? 'yes' : 'no'} | ${gate.durationMs} ms | ${esc(gate.reason ?? '')} |`);
  }
  lines.push('');
  if (bundle.policyViolations.length > 0) {
    lines.push(`## Violations (${bundle.policyViolations.length})`);
    lines.push('');
    for (const violation of bundle.policyViolations) {
      lines.push(`- \`${violation.rule}\` — \`${violation.path}\` [${violation.classification}] — ${violation.detail}`);
    }
    lines.push('');
  }
  if (bundle.baselineContext.length > 0) {
    lines.push(`## Baseline context (${bundle.baselineContext.length})`);
    lines.push('');
    for (const violation of bundle.baselineContext) {
      lines.push(`- \`${violation.rule}\` — \`${violation.path}\` — ${violation.detail}`);
    }
    lines.push('');
  }
  lines.push('## Human acceptance');
  lines.push('');
  lines.push('- **Status:** not accepted (no human review recorded).');
  lines.push('- Machine gate status and human acceptance are separate facts (task-contract spec): all gates passing never implies acceptance.');
  lines.push('- To record acceptance, add a review entry to the ledger for this task with reviewer, decision, requested changes and time spent (ledger `reviews` table).');
  lines.push('');
  lines.push('## Cost');
  lines.push('');
  lines.push('- **Model API cost: unknown** (check mode performs no model API calls; no usage was measured, and EIL never reports unknown spend as $0).');
  lines.push('- Attempts recorded in the ledger carry `cost_kind` ∈ {billed, estimated, unknown}; only billed/estimated rows carry an amount.');
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- Evidence bundle: \`evidence.json\``);
  lines.push(`- Summary: \`summary.md\``);
  lines.push(`- Full logs: \`${bundle.fullLogsDirectory}\``);
  if (bundle.diffPath !== null) lines.push(`- Diff: \`${bundle.diffPath}\``);
  lines.push('');
  return lines.join('\n');
}
