# Release gates v0.2 — status and evidence

Чеклист из `tasks.md` («Release gates for v0.2») с указанием доказательств на
момент коммита self-check. Пункты, зависящие от Tier-1 ревью, помечены явно.

## 1. `eil check` работает полностью без агента и внешнего model API ✅

- В `src/` нет сетевых вызовов; check-режим использует только git-подпроцессы и файловые чтения (см. [security-review-brief.md](security-review-brief.md), зона 3).
- Интеграционные тесты запускают check на fixture-репозиториях без сети; время работы гейтов не зависит от внешних сервисов.
- Evidence: `tests/integration/eil-check.test.ts`, `tests/integration/phase1-gates.test.ts`.

## 2. Обязательный gate fail/error блокирует принятие; политика неизменна для tiers ✅

- `computeVerdict`: обязательный `fail` → exit 1 (blocked), обязательный `error`/отсутствие результата → exit 2; отсутствующий/неизвестный гейт синтезируется как `error` — пропуск никогда не равен success ([run-gates.ts](../src/packages/quality-gates/run-gates.ts)).
- Понятие tiers (cheap/strong) появляется только в Phase 3/4; политика исполнителя команд едина для всех вызовов и не параметризуется уровнем — правило «политика неизменна» соблюдено конструктивно, финальная проверка — после Tier-1 ревью Phase 3.
- Evidence: `run-gates.test.ts`, интеграционные негативные тесты (timeout, exit 137, missing script, unvetted).

## 3. Провайдер не получает secrets; непросмотренные proprietary files не отправляются наружу ✅

- Check-режим не отправляет ничего наружу: ни исходников, ни diff, ни логов.
- `symbols()` возвращает header-only сигнатуры — тела функций не покидают репозиторий; ledger и JSONL-экспорт не содержат колонок с исходным кодом по построению схемы.
- secrets-редакция логов (Phase 3, task 3.3) — до тех пор команды не исполняются вне vetted fixtures, что ограничивает поверхность.
- Evidence: `context-tools.test.ts` (signature without bodies), `ledger.test.ts` (no source/diff properties in export).

## 4. Запуск не может менять исходный рабочий каталог и основную ветку без явного разрешения ✅

- `eil check` — только read-only git-операции (diff, rev-parse, archive); untracked-патч собирается через `--no-index`, а не `git add -N`.
- Bench-раннер работает в независимых локальных клонах; исходный репозиторий не пишется.
- Evidence: интеграционные тесты не наблюдают изменений fixture-репозиториев после check; git-окружение подпроцессов зачищено от `GIT_*` ([git.ts](../src/packages/diff-inspector/git.ts)).

## 5. Есть воспроизводимый эксперимент A/B/C; результат честно отражает неизвестную стоимость и human-pending задачи ✅ (с ограничениями)

- `eil bench --repeat N`: парные клоны одного base commit, сравнимость конфигураций фиксируется, несопоставимые помечаются «NOT causal»; повторения проверяются на воспроизводимость; движок-стенд-ин заменяет агента (Phase 3 заблокирована на 1.7).
- Честность: engine-less варианты → attempts `pending`; acceptance нет → CPAT/acceptance_rate UNAVAILABLE; unknown costs → lower bound, не ноль.
- Ограничения опубликованы в LIMITATIONS.md каждого прогона.
- Evidence: `phase5-bench-report.test.ts` (включая 3 повторения × 6 шагов), `metrics.test.ts`.

## 6. Нет новых запрещённых архитектурных зависимостей внутри самого EIL ✅

- Dogfooding: `npm run selfcheck` (в составе `npm run ci`) прогоняет `eil check` на самом EIL с политикой [ops/self-policy.yaml](../ops/self-policy.yaml):
  - `forbiddenImports`: `src/packages/** → src/apps/**` (запрещено; нарушение `benchmarks/runner.ts → apps/cli/main.ts` было найдено этим правилом и устранено инверсией зависимости — checker инжектируется из CLI);
  - `forbiddenImports`: `src/** → tests/**`;
  - `forbidNewCycles: true` против root-коммита (инвариант «с рождения монолита»).
- Evidence: `.eil-self-check/latest/evidence.json` (path-scope pass, import-boundaries pass), CI-скрипт.

## Открытые пункты (вне GLM-контура)

| Пункт | Блокер | Материал |
|---|---|---|
| 1.7 security design review | приёмка командного исполнения вне fixtures, Phase 3 | [security-review-brief.md](security-review-brief.md) |
| 5.7 аудит результатов (1.7 + 5.4–5.6 артефакты) | независимый взгляд на метрики и честность | results.json, LIMITATIONS.md, [metrics.ts](../src/packages/ledger/metrics.ts) |
| Phase 3 (sandbox, Pi, 3.1–3.7) | 1.7 | design.md §9, задачи 3.1–3.7 |
| Phase 4.2–4.5 (каскад, восстановление) | Phase 3 | design.md §6 |
