# Review handoff — tasks 1.7 and 5.7

Единый вход для независимого ревью (Tier-1 / человек). Всё, что нужно, — в
этом репозитории; ниже — навигация и ожидаемый формат вердикта.

## Что проверять

### 1.7 — Security design review (блокер для 3.3-остатка и 3.4)

| Зона | Материал | Код |
|------|----------|-----|
| Пути, канонизация, TOCTOU | [brief](security-review-brief.md) §1 | `src/packages/policy-engine/paths.ts` |
| Git-подпроцессы | brief §2 | `src/packages/diff-inspector/git.ts` |
| Исполнение команд | brief §3 | `src/packages/quality-gates/command-runner.ts` |
| Гейт исполнения (vetted) | brief §4 | `src/packages/quality-gates/execution-policy.ts` |
| Import-сканер | brief §5 | `src/packages/quality-gates/import-graph.ts` |
| Evidence writer | brief §6 | `src/packages/evidence/bundle.ts` |
| Sandbox-инфраструктура | [результаты 22/22](../ops/sandbox-security-results.md) + [план](sandbox-security-test-plan.md) | `scripts/sandbox-security-test.sh` |
| Движок-контракт и пайплайн | [phase-reports](phase-reports.md), «3.6» | `src/packages/agent-adapters/`, `src/packages/runner-pipeline/` |

Контекст решений оператора: [decisions.md](decisions.md) (sandbox = Linux
VM + контейнер; model APIs default-deny; human accepted = явное событие;
unknown ≠ 0; merge только человеком).

### 5.7 — Аудит результатов (метрики, честность, регрессии)

| Вопрос | Материал |
|--------|----------|
| Метрики считают то, что заявлено? | `src/packages/ledger/metrics.ts` + `metrics.test.ts` |
| Unknown-стоимость нигде не превращается в 0? | metrics.test.ts (13 кейсов) + ledger/records.ts `validateCost` |
| Acceptance отделён от гейтов? | `eil accept` (`context-commands.ts`) + тест `phase5-metrics-accept` |
| Bench честен о несопоставимости? | `benchmarks/manifest.ts` `analyzeComparability` + тесты |
| Ограничения опубликованы? | LIMITATIONS.md автогенерируется каждым прогоном; пример — в любом `--out` bench-прогона |

## Приглашение к сомнению (специально для ревьюера)

1. **Self-check сам себе не судья:** `npm run selfcheck` проверяет границы
   модулей EIL своими же гейтами — ревьюера просим оценить, не слеп ли этот
   набор правил к классам нарушений, которые сам допускает.
2. **Нативная зависимость:** better-sqlite3 уже однажды тихо ронял весь CI
   ([ADR](decisions.md), 2026-11-07). Оценить: остаться на 12.x, поднять
   после фикса v13 или мигрировать на node-sqlite3-wasm.
3. **Fail-closed полнота:** инвариант «отсутствие результата ≠ success»
   проверен на известных сценариях; ревьюера просим искать непокрытые пути
   (например, гейт, который научился возвращать pass без артефактов).
4. **Захваченные артефакты неудачных попыток** содержат дифф, который мог
   включать секреты — они маскируются только на уровне evidence-бандла
   check-прогона; оценить достаточность.

## Формат вердикта

На каждую зону: **OK / замечание (severity, суть, предлагаемый фикс)**.
Блокирующие замечания по зонам 1–5 брифа = запрет на расширение
`execution.vettedRepos` за пределы фикстур и на подключение Pi (3.4) до
устранения. 5.7: отдельное заключение по каждой метрике.

## Воспроизведение

```bash
npm ci && npm run ci        # lint + typecheck + 198 тестов + build + self-check
node dist/apps/cli/main.js check --repo <fixture> --task ops/self-task.yaml --policy ops/self-policy.yaml
bash scripts/sandbox-security-test.sh   # требует Docker; ~2 мин
```
