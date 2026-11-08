# Phase reports — consolidated evidence trail

Executor: GLM-5.3-Flash per `examples/codex-or-glm-handoff.md`. This file
consolidates the per-phase reports (previously delivered in chat) into the
repository as a review aid for tasks 1.7 and 5.7. Tests/commands were run at
the stated commits; verdict lines below are verbatim from the runs.

## Phase 0 — standalone `eil check` (commit e6e605d)

- Deliverables: CLI `eil check` (no agent/LLM/network), strict TaskContract
  (Zod, stable sha256 over canonical JSON), path canonicalization with
  symlink/traversal containment, `protect > allow` scope gate, baseline
  context, evidence bundle (evidence.json + summary.md + logs).
- Key decisions: fail-closed exit codes (0 needs_review / 1 blocked /
  2 error); missing/unknown/throwing required gates synthesize `error`;
  untracked files included via `ls-files --others` + `--no-index` (index is
  never mutated); check is read-only for the target repo.
- Verification: 49/49 tests at the time; smoke run blocked a rename into a
  protected area (exit 1).

## Phase 1 — deterministic gates (commits e6e605d … a77124d)

- 1.1 command runners (types/lint/tests): bash -c under operator-only
  commands, timeouts (SIGKILL), output caps that kill the child, exit-code
  semantics (0 pass / 1 fail / other error; exit 1 without parseable
  diagnostics = error), full logs in evidence.
- Execution policy: host execution DENIED by default; only
  `execution.vettedRepos` (realpath) may run commands — repository content
  can never grant itself execution.
- 1.2 import boundaries: forbiddenImports + new-cycle detection (Tarjan SCC)
  vs baseline snapshot; baseline unavailable → error (fail closed).
- 1.3 lockfile approval via `dependencies.approvedFiles` (the policy file IS
  the approval artifact).
- 1.4 api-compat: public API fingerprints via the TypeScript compiler API
  (members included); removed/changed → fail; new package → not_applicable
  with reason; snapshot failure → error, never pass.
- 1.5 ds-conformance: forbidden components/props (explicit + shorthand),
  DS import allowlist, raw-color ban; not_applicable without `ds` policy.
- 1.6 structural: check mode contains no LLM code path; verdict is a pure
  function of gate results.
- Notes: ESLint 9 removed the `unix` formatter (parsed `--format json`);
  Node 22 `--test` rejects directory args; macOS `/var` → `/private/var`
  realpath matters for path normalization.

## Phase 2 — context tools + ledger

- `symbols(file)` (header-only signatures, overloads, re-exports), 
  `references(symbol)` (exact coordinates, 200 cap), `impact(diff)` (reverse
  static-import graph, `completeness: 'static-import-analysis'`,
  `potentiallyIncomplete` on non-literal dynamic imports).
- SQLite ledger (better-sqlite3): 6 tables from design.md §10, idempotent
  migrations, JSONL export with no source-code columns by construction.
- Cost veracity: `cost_kind` billed/estimated/unknown with code-level
  invariants; unknown never rendered as $0.
- Task Record (task-record.md) written into every evidence bundle.

## Phase 4 — risk and cascade (commits 0961d0b, 55182dd)

- 4.1 deterministic risk: monotonic low→medium→high, blocked terminal;
  protected paths/known secrets → blocked; hints only elevate.
- 3.1 isolated workspaces: independent clone per task at the base commit,
  one-writer locks (live-pid protection), stale recovery, idempotent
  cleanup, captureFailedAttempt (4.4).
- 4.2–4.3 cascade planner: cheap-first for low/medium; high → strong tier or
  needs_review; escalation only on reproducible failure signatures; fresh
  workspace for every attempt.
- The layering violation `packages/benchmarks → apps/cli` was found by EIL's
  own import-boundaries gate during dogfooding and fixed via dependency
  injection (checker injected from the CLI layer).

## Phase 5 — evidence and evaluation (commits a77124d, ea6929b, c996446)

- 5.1 PR report (`eil report`) — self-contained, no absolute paths.
- 5.2 paired A/B/C bench runner: identical clones at one base commit,
  comparability recorded (incomparable configs marked NOT causal), engine
  commands only for vetted repos, honest `pending` attempts.
- 5.3 sequential 6-step Beaver UI fixture with per-step regression probe
  (steps 1..k re-verified, `FAIL step N` attribution).
- 5.4 metrics with honesty: CPAT unavailable with zero accepted tasks;
  cascade waste is not a routing regret; REC requires measured costs on
  both sides per step; regression tax excludes/count unattributed items;
  unknown costs → labeled lower bounds, never zeros.
- 5.5 `eil accept`: human acceptance is a review event; gates passing keeps
  `needs_review` (asserted).
- 5.6 `--repeat N` with cross-repetition reproducibility check; publication
  artifacts: results.json, samples JSONL, full command logs, auto-generated
  LIMITATIONS.md (scripted stand-in ≠ agent; single fixture; does not
  generalize).

## Phase 3.3 (check-only part) — secrets and injection (commit 5fa50c4)

- `secrets-scan` gate over ADDED diff lines (structured signatures +
  generic assignments with placeholder exclusion); findings → mandatory
  fail (`known-secret`) → risk blocked; secret VALUES never stored (masked
  excerpts; asserted over the whole evidence file). Included in the default
  policy.
- Prompt injection is inert data: gate outcomes identical with and without
  injection content (integration test).

## Release gates v0.2 (commit 1edf5d4)

All six gates checked with evidence in `docs/release-gates-v0.2.md`;
self-check (`npm run selfcheck`) runs EIL's own gates against this
repository in CI (import boundaries vs the root commit).

## Post-release hardening (commits 0771511 … field validation)

- **3.2 sandbox security test executed** — 22/22 PASS (Docker Desktop,
  node:22-bookworm): FS/secrets/network/process isolation, 5 escape
  scenarios, resource limits (incl. the memory-swap lesson), and `eil
  check` running INSIDE the hardened container with an untouched
  workspace. Found along the way: check portability (lazy imports of
  ts-morph/better-sqlite3 — no native module loads in the check path,
  verified via a module._load hook), `--json` swallowing failure reasons,
  and the alpine/git image requirement. Sign-off of the runner
  infrastructure stays with 1.7.
- **4.2–4.4 + 3.1**: isolated workspaces (locks live OUTSIDE the
  workspace — an in-workspace lock polluted every diff; found by pipeline
  tests), deterministic cascade planner, failed-attempt artifact capture.
- **4.5 (deterministic surface)**: timeout / provider-unavailable (127) /
  reproducible exit-1 escalation / budget exhaustion / blocked-risk — via
  the engine adapter contract (`ScriptedEngineRunner` maps command
  outcomes onto typed failure signatures; model-API failures land with
  the live engine).
- **3.6 `eil run`**: full attempt pipeline CLI with the operator-supplied
  `execution.engineCommand`; ledger records BOTH the engine attempt and
  the eil-check verification attempt (design §11 — found by the CLI test).
- **Dogfooding**: self-check now includes `secrets-scan` — it immediately
  flagged 9 secret-shaped test fixtures; resolved by the explicit
  `eil-allow-secret-fixture` line marker (allowances are reviewable acts
  in the source, never inferred from content).
- **CI incident & fix**: every GitHub Actions run since the first commit
  was red (ERR_IPC_CHANNEL_CLOSED). Root cause: better-sqlite3@13
  prebuilt segfaults on node 20 (reproduced with a one-line require,
  exit 139). Pinned 12.x; full timeline in decisions.md (2026-11-07).
- **Field validation** (`npm run field:test`, weekly in CI): real OSS
  repositories at pinned SHAs — zod (152 references through namespace
  usages; impact: 7 changed → 180 affected/28 tests) and hono (6
  pre-existing import cycles correctly classified as inherited). The
  test itself caught and fixed a UX bug (`eil report` demanded --repo).
- **Dependency security**: runtime audit clean — tinypool critical closed
  by a scoped override, zod high closed by the 4.6.7 upgrade (2×
  `z.record(k,v)` migration; strict semantics re-verified). CI now fails
  on any high+ in the prod chain (`npm audit --omit=dev`). Remaining 2
  moderate are dev-tooling only (breaking vitest 5 not justified yet).

## Open items (explicitly outside the executor's scope)

1.7 security design review (brief: docs/security-review-brief.md);
5.7 independent audit of results; 3.2 sandbox security test (TL decision:
Linux VM + container); 3.3 execution-time allowlist/egress; 3.4–3.7 Pi SDK
and `eil run`; 4.5 engine-failure tests. Final pipeline at the time of
writing: 189/189 tests (19 files) + lint + typecheck + build + self-check,
cold `npm ci` verified; spec validated with @fission-ai/openspec@1.16.0
(--strict): valid.
