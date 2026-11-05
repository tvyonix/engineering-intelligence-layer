# Design: Engineering Intelligence Layer v0.2

## 1. Architectural decision

**EIL = agent-agnostic engineering policy and evaluation layer.** Агентный движок отвечает за поиск и изменение кода, EIL — за scope, constraints, verification, evidence и измерение качества/стоимости. В первой версии адаптируется только Pi; контракт допускает Codex SDK или Droid позже, но не маскирует функциональные различия между харнесами.

```text
Task/Issue → Task Contract → Risk Policy → Safe Workspace
                                          ↓
                (optional) Pi Runner / external agent
                                          ↓
                   Git diff → Diff Policy → Quality Gates
                                          ↓
                  Evidence Bundle + Review → SQLite Ledger
                                          ↓
                          A/B/C + Evolution Benchmark
```

Независимый режим `eil check --task task.yaml --repo /path` работает с любым diff без участия Pi.

## 2. Modules

```text
apps/cli/
packages/contracts/          # Zod schemas; stable serialized contracts
packages/policy-engine/      # deterministic task risk, immutable approvals
packages/context-tools/      # ts-morph + git; no persistent graph
packages/diff-inspector/     # changed paths, AST imports, public API, deps
packages/quality-gates/      # reliable subprocess invocations & parsers
packages/agent-adapters/pi/  # Pi SDK; no other adapter in MVP
packages/isolated-runner/    # separate worktree + stronger sandbox boundary
packages/evidence/           # normalized pass/fail/skip records
packages/ledger/             # SQLite task/attempt/check/review/event
packages/benchmarks/         # reproducible A/B/C and sequential evaluations
examples/
```

First skeleton SHOULD start as a modular monolith rather than many published npm packages; paths above denote *boundaries*, not a requirement for separate build artifacts.

## 3. Proposed interfaces (illustrative API contracts)

```ts
export type TaskRisk = 'low' | 'medium' | 'high' | 'blocked';
export type GateState = 'pass' | 'fail' | 'error' | 'not_applicable';
export type TaskStatus = 'pending' | 'executing' | 'evaluating' | 'needs_review' | 'accepted' | 'rejected';

export interface TaskContract {
  id: string;
  description: string;
  baseCommit: string;
  scope: { allow: string[]; protect: string[] };
  acceptance: { id: string; description: string; command?: string }[];
  policy: { maxUsd?: number; maxAttempts: number; noNewDependencies: boolean };
  riskHints?: string[];
}
export interface EngineRunner {
  readonly id: string;
  execute(task: TaskContract, workspace: WorkspaceHandle, signal: AbortSignal): Promise<AttemptResult>;
  capabilities(): Promise<{ models: string[]; supportsTokenUsage: boolean; supportsTools: boolean }>;
}
export interface AttemptResult {
  engine: string;
  model: string;
  startedAt: string;
  completedAt: string;
  status: 'complete' | 'failed' | 'aborted';
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; billedUsd?: number };
  artifacts: { diffPath?: string; logPath: string };
}
export interface GateResult {
  id: string;
  status: GateState;
  mandatory: boolean;
  durationMs: number;
  evidencePath?: string;
  reason?: string;
}
export interface EvidenceBundle {
  taskId: string;
  baseCommit: string;
  headCommit: string;
  gateResults: GateResult[];
  policyViolations: string[];
  diffPath: string;
  fullLogsDirectory: string;
  estimatedUsd?: number;
  humanAccepted?: boolean;
}
```

TypeScript/Zod validation SHALL reject unknown fields in privileged scopes where appropriate; tests SHALL verify serialization and round-trip. `usage` may be missing; never report zero if missing.

## 4. Task state machine

`pending → workspace_ready → executing → evaluating → needs_review → accepted/rejected`.

Any gate `error` or mandatory gate missing SHALL prohibit accepted state. `not_applicable` permitted only when gate activation rule proves it doesn't apply. Failed task MAY be retried on clean snapshot; the previous attempt's unreviewed modifications SHALL NOT silently carry over to the next tier. Escalation payload includes task, precise failures, attempted diff and relevant context, but no secrets. Human review is required before merge.

## 5. Risk policy

`blocked`: touching protected files without approval, known secrets exfiltration, prohibited destructive commands, missing external-provider data agreement.
`high`: authn/authz, cryptography, secret handling, privileged CI, release, DB migrations, broad public API change, cross-module core architecture.
`medium`: cross-module feature, API extension with compatibility proof, data-model updates in non-production context.
`low`: local UI/bounded bug fix and contained refactoring.

Risk is monotonic under newly detected evidence: a gate may elevate risk; the model cannot lower a hard-coded risk. No probabilistic decision model may override `blocked` or mandatory review.

## 6. Cascade policy

- Cheap tier (preferred GLM-5.3-Flash) for low/medium after task and risk validation.
- Strong tier (configured externally; may be Claude or Codex) for high-risk and reproducible failure after bounded retry. Lack of strong tier yields `needs_review`, not fabricated success.
- A cascade switch SHALL start a clean engine session and preserve audit history.
- Tool permission and test policy remain identical across tiers.
- Prices and rate limits are versioned, provider-specific, and may not be taken as measured model quality.

**Implementation roles:** Flash can implement the bulk of this repository. Tier-1 is recommended for up-front trust boundary review, independent review of isolation/secret management, and analysis when repeated failures resist deterministic feedback. This is a recommended workflow, not a hard dependency in the runtime.

## 7. Scope and context

- `symbols(file)` uses ts-morph for named declarations and exported signatures.
- `references(symbol)` returns symbol references with bounded ranges.
- `impact(diff)` analyzes changed imports and reverse relationships using ts-morph + git, returns *potentially affected* files/tests; it SHALL NOT falsely claim completeness for dynamic imports/reflection.
- Paths are canonicalized and checked against workspace roots before access.
- Repository text, AGENTS.md, comments and external docs are **untrusted** unless approved as policy source from protected configuration.

## 8. Diff and engineering gates

Order (fast to slow, with configurable dependencies): scope/protected paths and lockfile inspection → import boundaries/public API check → formatting/lint/tsc → focused tests → broader tests → Playwright only if relevant.

Gate commands SHALL run in a constrained process environment with timeouts, bounded output and evidence retention. `git diff` exit 1 may be normal; subprocess exit code semantics must be handled per command.

- Source-wide violations already in baseline are classified separately from new violations.
- Public API gate requires an explicit approved baseline/diff. For TS libraries use API Extractor or an equivalent reproducible declaration signature check.
- Design-system checks are opt-in repo policies and SHALL NOT silently block repositories without a configured DS registry.
- Dependency changes are checked via package manifests, lockfiles and approval policy.

## 9. Isolation & threat model

Git worktree provides concurrency isolation, **not security isolation**. For untrusted code execution, use a container or VM with read-only host mounts, no ambient credentials, controlled egress, resource limits and a task-scoped allowlist. Workspace creation and cleanup must be idempotent, including interruption recovery. If a secure runner is unavailable, EIL SHALL be able to operate in `check-only` mode and SHALL refuse autonomous execution of untrusted scripts.

Trust zones: operator policy; runner controller; agent prompts; repository content; tool output; network services. Only operator policies are authoritative. External model access is disabled until repo data-transfer approval. Secret redaction happens before storing logs but does not substitute for making secrets unavailable to runner.

## 10. Ledger schema

SQLite with migrations and explicit IDs. Minimum tables:

```text
tasks(id, base_commit, type, risk, status, contract_hash, created_at)
attempts(id, task_id, engine, model, effort, status, started_at, ended_at,
         input_tokens, output_tokens, cached_tokens, api_cost_usd,
         cost_estimated, provider_price_version, policy_version)
gates(id, attempt_id, gate_id, status, mandatory, duration_ms, evidence_ref)
reviews(id, task_id, reviewer_type, accepted, duration_seconds, changes_requested,
        observed_at)
regressions(id, task_id, discovered_at, severity, related_task_id, repair_cost_usd)
bench_runs(id, scenario_id, variant, seed, base_commit, started_at, ended_at)
```

Telemetry MUST distinguish *unknown* spend from `$0.00`, record model identity and pricing version, avoid storing raw source code by default, and support export to JSONL/CSV.

## 11. Metrics and scientific validity

- `Cost per Accepted Task = sum(attempt + verification API costs) / accepted count`; present human time separately and optionally monetized with transparent assumptions.
- `Cascade Waste = sum(costs of attempts that did not produce accepted artifact)`; this is **not true counterfactual routing regret**.
- `Regression Tax = cost repairing previous accepted changes / total change cost`, with attribution confidence reported.
- `Relative Evolution Cost (REC)_k = C_EIL,k / C_control,k` for same requirement and comparable start state.
- True Routing Regret needs paired alternative executions; data from only chosen route is insufficient.
- Tests passing SHALL NOT equal human acceptance; missing acceptance is labeled pending/unknown.

Primary A/B/C comparisons MUST hold engine, base model, task, base commit, acceptance and runtime resources constant where possible. Routing only varies in C. Report sample sizes and uncertainty; no invented percentage improvements.

## 12. UI and design-system trajectory

MVP includes DS conformance checks on TS/JSX through lint or AST patterns if the registry exists. No new UI Schema. In future, a typed schema MAY describe composition only; fetching, state and event handlers remain TS interfaces/slots. UI Schema go/no-go must be informed by an inventory of existing real screens and escape-hatch coverage.

## 13. Deferred evolution

After evidence of MVP value: second EngineRunner adapter → compact context index if `symbols/references/impact` prove inadequate → calibrated DecisionModel → local ONNX/Jev/Tev models as optional routing advisers → UI product builder. No compulsory neural classifier without a validated dataset.

## 14. Open questions to resolve during implementation

- Which OS-level sandbox is available and approved on the target host?
- Which repository package manager and test commands are authoritative?
- Are external API providers approved for source-code transfer?
- What counts as human accepted PR and how is review time recorded?
- Can public API signatures be extracted reproducibly for target repo?

None of these questions permits bypassing safe defaults. Default to `check-only` where environment constraints are unknown.
