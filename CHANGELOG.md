# Changelog

All notable changes to EIL (Engineering Intelligence Layer). Format follows
[Keep a Changelog](https://keepachangelog.com/); versions are pre-release alphas.

## [Unreleased]

### Added
- `npm run coverage` (`@vitest/coverage-v8`): 85% statements / 70% branches / 92% functions.
  Weakest branches are the CLI argument dispatcher; decision modules are well above that.

### Changed
- `package.json`: `typescript` spec normalized to `^5.9.3` (matches lockfile); `allowScripts`
  added for `better-sqlite3` and `fsevents` (see review notes: npm 10 ignores it).

## [0.2.0-alpha.3] - 2026-11-08

### Security
- Runtime dependency chain cleaned; CI runs `npm audit --omit=dev --audit-level=high`
  as a regression guard.
- Dev dependency `vitest` bumped to 4.1.12 (closes the `@vitest/mocker` advisory, drops `tinypool`).

### Added
- Field validation of EIL against real OSS repositories (zod, hono): `npm run field:test`,
  dedicated `field.yml` CI workflow with an isolated field policy.
- Dogfooding: secrets-scan on EIL itself; published smoke-bench artifact
  (`ops/bench-artifacts/latest`, `npm run bench:smoke`).

### Fixed
- `eil report` UX bug found by the field test.

## [0.2.0-alpha.2] - 2026-11-07

### Added
- `eil run`: attempt pipeline CLI with scripted engine mode (task 3.6).
- Engine adapter contract and attempt pipeline; deterministic surface (phases 4.5 / 3.6 core).
- Sandbox security test executed: 22/22 isolation checks pass (task 3.2).
- Review handoff entry point (`docs/review-handoff.md`), current-state README.

### Fixed
- `better-sqlite3` pinned `13.0.3` → `12.2.0`: v13 segfaults on Node 20.
- CI: test files run sequentially on GitHub runners (`ERR_IPC_CHANNEL_CLOSED` crash).

## [0.2.0-alpha.1] - 2026-11-05

### Added
- Standalone `eil check`, deterministic gates, context tools, ledger (phases 0–2).
- Deterministic risk classification, no ML (4.1).
- Isolated workspaces with one-writer locks and a deterministic cascade policy (3.1, 4.2–4.4).
- Secrets-scan gate and prompt-injection-as-data tests (3.3, check-only).
- PR report, paired A/B/C benchmark runner, sequential Beaver fixture (5.1–5.3).
- Honesty-first metrics and human acceptance event (5.4–5.5); reproducible smoke bench (5.6).
- Release gates v0.2 checklist with a dogfooded self-check in CI.

### Changed
- CLI `--json` output discipline; cold-install verification.
