import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evidenceBundleSchema, type EvidenceBundle } from './bundle.js';

const STATUS_GLYPH: Record<string, string> = {
  pass: '✅ pass',
  fail: '❌ fail',
  error: '⚠️ error',
  not_applicable: '➖ n/a',
};

/**
 * Task 5.1: human-readable PR summary rendered from an evidence bundle.
 * Self-contained for pasting into a PR description or CI comment:
 * no absolute host paths, bounded lists, verdict + risk + gates +
 * violations + explicit human-acceptance and cost statements.
 * EIL never merges — the report ends with the review hand-off.
 */
export function renderPrReport(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`## EIL check: ${bundle.taskId}`);
  lines.push('');
  lines.push(`**Verdict:** \`${bundle.verdict}\` · **Risk (deterministic):** \`${bundle.risk ?? 'unknown'}\` · **Contract:** \`${bundle.contractHash.slice(0, 19)}…\``);
  lines.push('');
  lines.push(`<details><summary>Gates (${bundle.gateResults.length})</summary>`);
  lines.push('');
  lines.push('| Gate | Status | Mandatory | Reason |');
  lines.push('|------|--------|-----------|--------|');
  for (const gate of bundle.gateResults) {
    const reason = (gate.reason ?? '').replace(/\|/g, '\\|').slice(0, 160);
    lines.push(`| ${gate.id} | ${STATUS_GLYPH[gate.status] ?? gate.status} | ${gate.mandatory ? 'yes' : 'no'} | ${reason} |`);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');

  if (bundle.policyViolations.length > 0) {
    lines.push(`### Violations (${bundle.policyViolations.length})`);
    lines.push('');
    for (const violation of bundle.policyViolations.slice(0, 20)) {
      lines.push(`- \`${violation.rule}\` — \`${violation.path}\` [${violation.classification}] — ${violation.detail}`);
    }
    if (bundle.policyViolations.length > 20) {
      lines.push(`- … and ${bundle.policyViolations.length - 20} more (full list in evidence bundle)`);
    }
    lines.push('');
  }
  if (bundle.baselineContext.length > 0) {
    lines.push(`<details><summary>Baseline context (${bundle.baselineContext.length}) — protected paths already touched by the base commit</summary>`);
    lines.push('');
    for (const violation of bundle.baselineContext.slice(0, 10)) {
      lines.push(`- \`${violation.path}\` — ${violation.detail}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if ((bundle.riskReasons ?? []).length > 0) {
    lines.push(`<details><summary>Risk assessment reasons</summary>`);
    lines.push('');
    for (const reason of bundle.riskReasons ?? []) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  lines.push('### Review notes');
  lines.push('');
  if (bundle.verdict === 'blocked') {
    lines.push('A mandatory gate failed — this change **cannot be accepted** regardless of reviewer opinion of the code itself. Fix the listed violations first.');
  } else if (bundle.verdict === 'error') {
    lines.push('The check is **incomplete** (mandatory gate errored/missing). EIL fails closed: incomplete verification is not a pass. Re-run after the environment issue is fixed.');
  } else {
    lines.push('All mandatory gates passed. **This is not acceptance** — human review is required.');
  }
  lines.push('');
  lines.push('- **Human acceptance:** none recorded. Gate status and acceptance are separate facts.');
  lines.push('- **Model API cost:** unknown (check mode makes no model calls; EIL never reports unknown spend as $0).');
  lines.push('- EIL never merges: acceptance and merge are explicit human actions.');
  lines.push('');
  return lines.join('\n');
}

export interface PrReportResult {
  bundle: EvidenceBundle;
  report: string;
}

/** Loads an evidence bundle from a directory and renders the PR report. */
export async function buildPrReport(evidenceDir: string): Promise<PrReportResult> {
  const raw = await readFile(join(evidenceDir, 'evidence.json'), 'utf8');
  const bundle = evidenceBundleSchema.parse(JSON.parse(raw));
  return { bundle, report: renderPrReport(bundle) };
}
