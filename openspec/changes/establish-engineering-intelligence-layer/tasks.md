# Implementation tasks (GLM-5.3-Flash-first, evidence-driven)

Каждая задача считается выполненной только после перечисленных тестов. Пакет рассчитан на поэтапное выполнение GLM-5.3-Flash; Tier-1 ревью точечно, без обязательной передачи всей разработки. Не отмечать task без evidence.

## Phase 0 — Foundation and standalone diff checks

- [x] 0.1 Создать TS Node CLI, конфигурацию, Vitest, eslint и базовый CI; задокументировать поддерживаемые Node и OS версии.
  <!-- Evidence: package.json (bin eil), tsconfig*, vitest.config.ts, eslint.config.js, .github/workflows/ci.yml, docs/supported-environments.md; `npm run ci` → lint+typecheck+49 tests+build, exit 0. -->
- [x] 0.2 Реализовать Zod `TaskContract`, строгую валидацию и примеры валидных/невалидных задач.
  <!-- Evidence: src/packages/contracts/task-contract.ts (strict schema, overlap check), hash.ts (stable sha256 of canonical JSON); tests: task-contract.test.ts (17 cases incl. unknown-field rejection, key-order-independent hash). -->
- [x] 0.3 Реализовать канонизацию путей и проверку allow/protected scope для diff, включая symlinks и path traversal.
  <!-- Evidence: policy-engine/paths.ts, scope.ts; tests: traversal/absolute/NUL rejection, realpath containment, symlink-escape and dangling-symlink integration tests on fixture repos. -->
- [x] 0.4 Реализовать `eil check --repo ... --task ... --base ...` без запуска LLM или агента.
  <!-- Evidence: src/apps/cli/main.ts; check mode makes no network/LLM/agent calls; smoke test on fixture repo: verdict blocked (exit 1) with protected-path violation; --base override recorded as baseCommitSource. -->
- [x] 0.5 Добавить режим baseline сравнения: новые нарушения отдельно от унаследованных.
  <!-- Evidence: policy-engine/violations.ts classifyViolations (fingerprint-based, unit-tested); path-scope reports current-change violations as new + base-commit protected-path touches as baseline_context (integration test). -->
- [x] 0.6 Тесты: запрещённый путь отклонён; неприменимый gate явно помечен; отсутствие результатов не возвращает success.
  <!-- Evidence: tests/integration/eil-check.test.ts: forbidden path → blocked/exit 1; dependency-policy → not_applicable with provable reason; unimplemented/unknown/missing required gates → error/exit 2 (fail closed). 49/49 tests pass. -->

## Phase 1 — Deterministic engineering policy

- [x] 1.1 Подключить typecheck/lint/test runner с тайм-аутами, exit codes, обрезкой вывода и ссылкой на полный лог.
  <!-- Evidence: quality-gates/command-runner.ts (bash -c, timeout SIGKILL, output cap kills child), content-gate.ts + tests-gate.ts (exit semantics 0/1/other, exit-1-without-diagnostics fails closed, full output.log in evidence); host execution denied by default, only execution.vettedRepos (TL decision docs/decisions.md). Integration: positive vetted run (tsc/eslint json/node --test), timeout, exit 137, missing tool, no test script. -->
- [x] 1.2 Добавить import/dependency boundaries и запрет новых циклов, регрессионные фикстуры.
  <!-- Evidence: import-graph.ts (relative import extraction static+dynamic, Tarjan SCC) + import-boundaries-gate.ts (forbiddenImports, forbidNewCycles vs baseline snapshot; baseline unavailable → error). Fixtures: forbidden import, new cycle vs pre-existing inherited cycle, dynamic import(). Known limitation: regex-based, no tsconfig aliases (Phase 2 ts-morph). -->
- [x] 1.3 Сделать проверку изменений package.json/lockfiles, approval requirement для новой зависимости.
  <!-- Evidence: dependency-policy-gate.ts: manifest/lockfile paths ⊆ policy dependencies.approvedFiles → pass ('covered by operator approval'), иначе fail с rule dependency-manifest-changed; policy file is the approval artifact, repo content cannot self-approve. Integration test: fail without / pass with approvedFiles. -->
- [x] 1.4 Добавить public API compatibility check для TS-пакетов, корректно обрабатывать репозитории без baseline.
  <!-- Evidence: api-surface.ts (TypeScript compiler API: entry resolution via package.json types/typings or index conventions; deterministic fingerprints incl. interface/class/enum members), api-compat-gate.ts (opt-in; removed/changed export → fail; added → evidence; new package / no TS entry → not_applicable with reason; snapshot provider failure → error, never pass). Integration tests: removed export, changed signature, added export pass, initial-commit (no parent) base, new package + no-entry packages. -->
- [x] 1.5 Добавить конфигурируемый Beaver UI DS gate на основе разрешённых imports/props/tokens; пропуск только при отсутствии DS policy.
  <!-- Evidence: ds-conformance-gate.ts (bounded JSX scanner: forbidden components, per-component forbidden props incl. shorthand, componentImports ⊆ allowedImports, forbidRawColors; violations carry file + policy contract 'registry'); policy.ds typed strictly. Integration tests: component/prop/import/raw-color violations, clean multi-line JSX passes. Not-applicable only with no ds section (diff-quality spec). -->
  <!-- ds-conformance gate: no ds policy → not_applicable; ds policy configured → error (rule engine pending). -->
- [x] 1.6 Проверить, что ни один LLM-ответ не может пометить failing mandatory gate как passed.
  <!-- Evidence: check mode has no LLM code path at all (no network calls in src); verdict is a pure function of GateResult (computeVerdict, unit-tested); runGates synthesizes errors for missing/throwing gates. Structural guarantee carries into later phases: gate results are produced only by deterministic runners. -->
- [ ] 1.7 Tier-1 или человеческое security design review для политики выполнения инструментов и парсинга путей.
  <!-- Brief prepared for the reviewer: docs/security-review-brief.md (7 areas + verdict format). Pending: independent Tier-1/human review; must complete before any vettedRepos entry beyond fixtures and before Phase 3. -->

## Phase 2 — Context and observable task ledger

- [x] 2.1 Реализовать `symbols(file)` с ts-morph и ограничением вывода; тесты на exports, overloads, reexports.
  <!-- Evidence: context-tools/symbols.ts (ts-morph; top-level declarations with kind/export status/header-only signatures — no bodies; one record per overload signature with overloadGroup; re-exports with source; caps 100 symbols/400 chars). CLI `eil symbols --repo --file`. Tests: exports, 3-way overload group, reexport named + star, missing file error. -->
- [x] 2.2 Реализовать `references(symbol)` с указанием точных координат и ограничениями на объём.
  <!-- Evidence: context-tools/references.ts (TypeScript language service findReferences; exact file/line/column/endLine/endColumn; declaration vs reference kind; import-specifier references included; cap 200 with truncated flag). CLI `eil references --repo --file --name`. Tests: declaration coords, multi-file references incl. imports, unknown symbol → empty without crash. -->
- [x] 2.3 Реализовать `impact(diff)` с пометкой потенциально неполного результата для dynamic imports.
  <!-- Evidence: context-tools/impact.ts (reverse graph over static imports/exports + literal dynamic imports/require via ts-morph; BFS; affectedTests detection; completeness:'static-import-analysis' constant; potentiallyIncomplete=true with note when non-literal dynamic imports exist; cap 200 truncated). CLI `eil impact --repo --base`. Tests: transitive reverse deps, non-literal dynamic flag + literal resolution, honest no-dynamic case. -->
- [x] 2.4 SQLite migrations: task, attempt, gate, review, regression, benchmark; экспорт JSONL.
  <!-- Evidence: ledger/db.ts (better-sqlite3, schema_migrations, idempotent apply, WAL, FK ON; 6 design tables + indexes), ledger/records.ts exportJsonl (one JSONL per table). CLI `eil ledger --db init|export`; `eil check --ledger` records task/attempt(eil-check)/gates. Tests: idempotency, 6 tables, JSONL export content, CLI integration incl. ledger-failure-does-not-change-verdict. -->
- [x] 2.5 Различать billed/estimated/unknown cost, хранить pricing version и модель.
  <!-- Evidence: records.ts validateCost: billed/estimated require api_cost_usd, unknown forbids it (never 0-faked); attempts.cost_kind CHECK constraint; model + provider_price_version columns stored when known; check-mode attempt is cost_kind 'unknown' with NULL amount. Tests cover all invariants incl. negative amount rejection. -->
- [x] 2.6 Писать Task Record в evidence folder; ADR только при значимом архитектурном решении.
  <!-- Evidence: evidence/task-record.ts renderTaskRecordMarkdown written as task-record.md per check run: scope, acceptance criteria (recorded, not executed), gate results, violations, human acceptance = explicitly not accepted, cost = unknown. ADRs: docs/decisions.md is the conditional ADR log (entries only on significant decisions, e.g. 2026-11-05 TL decisions). -->

## Phase 3 — Safe runner and first engine

- [ ] 3.1 Реализовать отдельный Git worktree per task, lock, отмену и гарантированную очистку.
- [ ] 3.2 Выбрать sandbox контейнер/VM; до реализации предоставить check-only fallback.
- [ ] 3.3 Реализовать allowlist инструментов, блокировку secrets и контролируемый egress; тесты на prompt-injection из README/comments.
- [ ] 3.4 Реализовать единственный `PiEngineRunner`, используя официальный Pi SDK без собственного agent loop.
- [ ] 3.5 Настроить GLM-5.3-Flash как default executor через поддерживаемый провайдер, с конфигурируемой моделью и без жёсткого хранения ключей.
- [ ] 3.6 Сделать `eil run --task ... --repo ... --policy ...` с доказательствами по каждому шагу.
- [ ] 3.7 Tier-1/человек: независимый security review sandbox, secrets, command execution и права записи.

## Phase 4 — Risk-aware execution and recovery

- [ ] 4.1 Реализовать deterministic risk classification + blocked risk без ML.
- [ ] 4.2 Low/medium: cheap-first bounded retry; high: configured strong tier или needs_review.
- [ ] 4.3 Эскалация только после воспроизводимых fail-сигналов; на чистом состоянии, с отдельной историей затрат.
- [ ] 4.4 Сохранять diff и ошибки от неудачных попыток, не переносить неконтролируемое состояние.
- [ ] 4.5 Тесты на broken tool calls, model timeout, budget exhaustion, context limits, provider unavailability.

## Phase 5 — Evidence and evolution evaluation

- [ ] 5.1 Формировать evidence bundle и человекочитаемую сводку для PR (без автоматического merge).
- [ ] 5.2 Реализовать A/B/C manifest runner: одинаковые репозитории, модели, критерии, базовые commit.
- [ ] 5.3 Реализовать последовательные 6-step изменения Beaver UI test fixture; регрессии перепроверяются на каждом шаге.
- [ ] 5.4 Посчитать Cost per Accepted Task, Cascade Waste, REC и Regression Tax без подмены неизвестных нулями.
- [ ] 5.5 Ввести human acceptance event; отделять pass gates от accepted.
- [ ] 5.6 Прогнать минимум smoke suite и несколько независимых повторений; опубликовать выборки, логи и ограничения.
- [ ] 5.7 Tier-1 review: аудит результатов, неизвестных расходов, безопасности и архитектурных регрессий.

## Release gates for v0.2

- [ ] `eil check` работает полностью без агента и внешнего model API.
- [ ] Обязательный gate fail/error блокирует принятие; политика неизменна для дешёвого и сильного tier.
- [ ] Провайдер не получает secrets, непросмотренные proprietary files не отправляются за пределы разрешённых интеграций.
- [ ] Запуск не может менять исходный рабочий каталог и основную ветку без явного разрешения.
- [ ] Есть воспроизводимый эксперимент A/B/C; результат честно отражает неизвестную стоимость и human-pending задачи.
- [ ] Нет новых запрещённых архитектурных зависимостей внутри самого EIL.
