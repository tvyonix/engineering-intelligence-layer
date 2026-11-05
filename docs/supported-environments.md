# Supported environments (EIL Phase 0)

## Verified

| Component | Version |
|-----------|---------|
| Node.js | 22.19.0 (macOS 15, arm64) |
| npm | 10.9.3 |
| git | 2.39.5 (Apple Git-154) |
| TypeScript | 5.7.x (NodeNext) |
| Vitest | 3.2.x |

## Requirements

- **Node.js >= 20** (CI matrix covers 20 and 22). No runtime flags beyond defaults.
- **git >= 2.28** — used for: `rev-parse`, `diff --name-status -z --find-renames`, `diff --binary`, `diff --no-index`, `ls-files --others --exclude-standard`, `diff --quiet`. All invocations are read-only.
- **OS:** macOS 14+ and Linux (x64/arm64) via CI. **Windows is not supported in v0.2**: path canonicalization and symlink containment assume POSIX semantics.
- **Network:** `eil check` performs no network access, no model API calls, no agent execution. It runs repository content never: check mode only reads git state and writes an evidence bundle under `--out` (default `./eil-evidence/…` relative to the invocation directory, not the target repo).

## Git hardening

Subprocess calls strip ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_NAMESPACE`, set `GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_NOSYSTEM=1`, so an operator shell cannot redirect git at another repository or hang on credential prompts. Commands run through `execFile` without a shell.

## Known limitations (Phase 1)

- Untracked files are included via `git ls-files --others --exclude-standard` and their content enters the saved patch via `git diff --no-index -- /dev/null <abs path>` (read-only; does not use `git add -N`, which would mutate the index).
- The saved patch is truncated at 16 MiB. Truncation forces a synthetic mandatory `diff-patch-integrity` gate to `error` (exit 2) — an incomplete diff never yields a positive verdict.
- **Host command execution is denied by default.** Gate commands (types/lint/tests) run only inside repos explicitly listed in `execution.vettedRepos` (realpath). Commands come from operator policy `quality.commands` only. Default commands: `npx --no-install tsc --noEmit --pretty false`, `npx --no-install eslint . --format json`, `npm test`.
- eslint output is parsed from `--format json` (the `unix` formatter is no longer part of ESLint 9 core).
- Baseline classification (new vs inherited) runs the same command in a `git archive` snapshot of the base commit — extracted to a temp dir, realpath-resolved (macOS `/var` → `/private/var` matters for path normalization). Commands must therefore work without an install step; repos needing `npm ci` for tools are not yet supported on host execution.
- `tests` gate is a tree-state gate: any failure fails it (baseline attribution is deliberately not applied). `types`/`lint` fail only on NEW violations; inherited ones are recorded in evidence.
- Import boundaries (`import-boundaries` gate, opt-in via `boundaries` policy): regex-based relative-import extraction — no tsconfig path aliases, no barrel re-export expansion; full AST analysis is planned with ts-morph context tools (Phase 2). Caps: 20k files, 2 MiB per file, 200k edges.
- Public API compatibility (`api-compat` gate, opt-in via `quality.required`): deterministic declaration-signature fingerprint of package entry exports via the TypeScript compiler API (interface/class/enum members included, so member changes are detected). Compared against the base-commit snapshot. Removed export or changed signature → fail; added export → evidence only; new package (no baseline entry) or no TS entry → `not_applicable` with explicit reason; snapshot provider failure → `error`, never `pass`. Not a replacement for API Extractor release tooling.
- Design-system conformance (`ds-conformance` gate, opt-in via `ds` policy): forbidden JSX components, per-component forbidden props (explicit and shorthand), DS module import allowlist (`componentImports` ⊆ `allowedImports`), raw hex color ban. JSX attribute scanning is a bounded heuristic scanner — multi-line tags, nested braces and quotes are handled; exotic syntax may need the ts-morph pass (Phase 2).
- Scope overlap (`allow` covering `protect`) is valid with a warning (TL decision 2026-11-05); runtime `protect > allow` enforces protection per changed file.
- Context tools (Phase 2): `eil symbols|references|impact` use ts-morph over the source tree (no persistent graph; caps: 20k files, 100 symbols/file, 200 references, 200 affected files — caps fail closed with `ContextLimitExceededError`). `symbols` returns header-only signatures (no function bodies leave the repository). `impact` covers static imports/exports and literal dynamic imports only and always reports `completeness: 'static-import-analysis'`; non-literal dynamic imports set `potentiallyIncomplete`. All three are read-only and require no execution policy.
- Ledger (Phase 2): better-sqlite3 (native module; prebuilt binaries for Node 20/22 on macOS/Linux). Schema migrations are idempotent; JSONL export contains structured rows only — no source code or secrets exist in the schema by construction. `eil check --ledger` records the run; a ledger failure is reported as a warning and never changes the check verdict.
- Dependencies for context tools and ledger: `ts-morph` (planned by design.md for context tools), `better-sqlite3` (design.md §10 mandates SQLite). Both added in Phase 2; no other new dependencies.
