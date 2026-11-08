# Engineering Intelligence Layer (EIL) — OpenSpec v0.2

**Статус:** 30/31 задач change выполнены (Phases 0–2 полностью; 3.1, 3.2 (security-тест 22/22), 3.3 (check-only), 3.6, 4.1–4.5 (детерминированная часть), 5.1–5.6); все 6 release gates v0.2 закрыты с evidence ([docs/release-gates-v0.2.md](docs/release-gates-v0.2.md)). Осталось — только независимое ревью и живой движок: 1.7 (security design review), 5.7 (аудит результатов), 3.4–3.5/3.7 (Pi SDK после 1.7 и data agreement). Единый вход для ревьюера: [docs/review-handoff.md](docs/review-handoff.md). Отчёты фаз: [docs/phase-reports.md](docs/phase-reports.md).

## Что мы строим

Внешний **Engineering Intelligence Layer** над готовым AI coding-agent. Он не заменяет движок; он принимает задачу, разрешает ограниченную область изменений, проверяет полученный diff, собирает доказательства качества и считает стоимость принятого изменения и последующей эволюции продукта.

Основная проверяемая гипотеза: один и тот же движок с EIL показывает меньшую стоимость **accepted change** и/или меньше регрессий на серии изменений, чем без EIL, при не меньшей функциональной корректности.

## Принципиальные отличия от v0.1

- Ядро — проверка инженерных контрактов и измерение **evolution cost**, а не отдельный интеллектуальный agent loop.
- В первом эксперименте используется **один базовый движок (Pi SDK)**. Только после A/B добавляется второй адаптер.
- **GLM-5.3-Flash** — рекомендуемый основной исполнитель реализации и low-cost tier; Tier-1 модель подключается для design/security review и сложных ошибок. Успешность этого разделения ещё необходимо измерить.
- Роутинг сначала задаётся правилами, без Jev / ONNX / bandit / обучения.
- Поддерживается отдельный режим `evaluate-diff`, который не требует запуска агента. Это первая инкрементальная ценность.
- CI и GitHub-интеграции — надстройки: MVP работает локально в CLI.

## Реализация (Phase 0 + 1 + 2, выполнено)

В репозитории появилась реализация Phase 0–2: standalone-CLI `eil check` — проверка существующего diff по контракту задачи и политике, без агента, LLM и сети; детерминированные гейты; контекстные инструменты на ts-morph; SQLite ledger с телеметрией и JSONL-экспортом.

```text
src/
  apps/cli/                 # bin `eil`: check, symbols, references, impact, ledger
  packages/
    contracts/              # Zod TaskContract + policy, стабильный sha256-хэш
    policy-engine/          # канонизация путей, allow/protect, symlink/traversal, new vs inherited
    diff-inspector/         # git: name-status -z, untracked, baseline-снапшот (git archive), patch
    quality-gates/          # path-scope, dependency-policy, types/lint/tests, import-boundaries,
                            # api-compat, ds-conformance; run-gates + verdict (fail closed)
    context-tools/          # symbols(file), references(symbol), impact(diff) — ts-morph, read-only
    ledger/                 # SQLite: tasks/attempts/gates/reviews/regressions/bench_runs,
                            # миграции, cost billed|estimated|unknown, JSONL export
    evidence/               # EvidenceBundle (Zod), summary.md, task-record.md, logs/
tests/                      # интеграционные тесты на реальных fixture-репозиториях
docs/decisions.md           # журнал решений (ADR-lite)
docs/security-review-brief.md  # бриф для Tier-1 security review (task 1.7)
```

Ключевые политики: host-исполнение команд запрещено по умолчанию (`execution.vettedRepos`); новые зависимости требуют записи в `dependencies.approvedFiles`; обрезанный патч (>16 MiB) → `diff-patch-integrity` error; baseline new/inherited через `git archive`-снапшот; в ledger стоимость помечается `billed|estimated|unknown` (unknown ≠ $0); Task Record в каждом evidence-бандле.

Команды: `npm install`, `npm run ci`, проверка: `eil check --repo <path> --task <task.yaml> [--ledger <db>]`; выполнение: `eil run --repo --task --policy --out [--ledger]` (движок = `execution.engineCommand` из operator policy; Pi-адаптер подключается после security review); контекст: `eil symbols|references|impact`; отчёты: `eil report|metrics|accept`; benchmark: `eil bench`; ledger: `eil ledger --db <path> init|export`. Коды выхода: 0 — гейты пройдены (`needs_review`, не acceptance), 1 — blocked, 2 — error (fail closed). Окружения: `docs/supported-environments.md`. Заметка о нативной зависимости: better-sqlite3 закреплён на 12.x (v13 сегфолтит на node 20 — см. `docs/decisions.md`, 2026-11-07).

## Файлы

```text
openspec/                        # спецификация change (proposal/design/tasks/specs)
examples/                        # примеры task/policy/benchmark + handoff
docs/                            # decisions (ADR), security brief, phase reports,
                                 # release gates, review handoff, plans
src/apps/cli/                    # bin `eil`: check, run, symbols, references,
                                 # impact, report, bench, accept, metrics, ledger
src/packages/…                   # contracts, policy-engine, diff-inspector,
                                 # quality-gates, context-tools, ledger,
                                 # evidence, isolated-runner, agent-adapters,
                                 # runner-pipeline, benchmarks
tests/                           # unit + интеграционные (fixture-репозитории)
ops/                             # self-policy/task, sandbox results,
                                 # bench artifacts, field-test results
scripts/                         # self-check, sandbox test, bench smoke, field test
.github/workflows/               # ci (matrix + self-check + audit), field (OSS)
```

## Рекомендуемый порядок

1. Ознакомиться с `proposal.md` и `design.md`.
2. Открыть `tasks.md`: это исполнимый checklist (Phase 0–2, 3.1, 3.3*, 4.1–4.4, 5.1–5.6 выполнены с evidence-комментариями).
3. Реализация живёт в корне репозитория (`src/`, `tests/`, `ops/`, `scripts/`): `npm install && npm run ci` — lint + typecheck + тесты + build + self-check (EIL прогоняет свои гейты на самом себе).
4. Команды CLI: `eil check|symbols|references|impact|report|bench|accept|metrics|ledger` (см. `eil --help`).
5. Спецификация проверена CLI: `npx @fission-ai/openspec validate establish-engineering-intelligence-layer --strict` → valid.

## Инварианты

- Один writer на изолированную задачу.
- Нет автоматического merge или production deploy.
- Проверки выполняются детерминированно; LLM judge — дополнение, не замена.
- Пропуск обязательных проверок не может интерпретироваться как success.
- Secrets и секретные контексты не попадают в телеметрию или внешний LLM без отдельной политики.
- Сильная модель не является обязательной для каждой подзадачи, но security-critical изменения требуют независимой приёмки человеком.

**Источники формата:** https://openspec.dev/docs/schemas/spec-driven и https://github.com/Fission-AI/OpenSpec .
