# 1.7 review — verdict response (2026-11-11)

Ответ исполнителя на независимое ревью. Каждый пункт статуса: **FIXED**
(воспроизведено и закрыто, проверено репро-скриптами ревьюера exp1–exp4),
**FIXED+NOTED** (закрыто + принято решение с обоснованием) или **NOTED**
(принято как осознанное решение, см. ADR).

## Блокирующие

| # | Находка | Статус | Что сделано |
|---|---------|--------|-------------|
| 1 | Self-check проверял пустой граф (NodeNext `.js` не резолвился) | **FIXED** | `rewriteJsSpecifier` в import-graph; на самом EIL граф = 183 ребра. Гейт немедленно нашёл 2 реальных нарушения (тест в packages импортировал apps; цикл context-commands↔main) — оба устранены (тест перенесён, `runCheck` инжектится, типы вынесены в `types.ts`). Юнит-тест NodeNext-резолва добавлен. |
| 2 | selfcheck отсутствовал в ci.yml | **FIXED** | Шаг `npm run selfcheck` добавлен в матрицу после build. |
| 3 | Self-policy в рабочем дереве — PR ослабляет сам себе | **FIXED** | Self-check берёт политику/таск из `origin/main` (fallback HEAD до первого пуша): правила самопроверки меняются только коммитом в main, где diff по `ops/self-*.yaml` явный. |
| 4a | `++ /dev/null` ломал парсер патча | **FIXED** | Гейт переписан на скан **содержимого файлов** (патч-парсер больше не участвует в детекции). |
| 4b | `.gitattributes -diff` прятал секрет | **FIXED** | Скан файлов; `core.attributesFile` принудительно `/dev/null`, diff всегда `--no-ext-diff --no-textconv`. |
| 4c | NUL-байт делал патч бинарным | **FIXED** | NUL нормализуется в перевод строки, содержимое сканируется. |
| 4d | Маркер ставил автор диффа, без следа | **FIXED** | Маркер действует только для путей из привилегированного `policy.allowSecretFixtureMarkers`; каждое подавление пишется в evidence (`suppressed[]`). Без allowlist маркер в диффе бессилен (exp1 B4 → blocked). |
| 4e | `<`/`example` освобождали assignment | **FIXED** | Placeholder-исключение строгое: целое значение либо канонический плейсхолдер, либо дефис-композиция плейсхолдерных слов в нижнем регистре. `AKIA…EXAMPLE` и `password="hunter2hunter2" // a<b` остаются находками (exp1 B0/B5). |
| 4f | Вложенный git-репозиторий и gitignored-файлы вне скана | **FIXED** | `detectHiddenChanges`: nested-git (прямая FS-проверка `.git`), `git status --ignored=matching` для exclude-спрятанного, `ls-files -v` для skip-worktree/assume-unchanged. Всё это — violations `hidden-change:*` в path-scope (fail) + risk high. D1/D3 → blocked. |
| 5 | Git-конфиг репозитория исполнялся на хосте | **FIXED** | Все наши git-вызовы: `-c core.fsmonitor=false -c core.attributesFile=/dev/null -c core.pager=cat` + `--no-ext-diff --no-textconv` на diff. exp1 E/E2: маркерные файлы fsmonitor/external-diff не созданы. Движок в .git: pipeline снимает pre/post-снапшот (config+info/exclude+HEAD) — дрейф = failure-сигнатура `engine:mutated-git-state` (exp3 G2). |
| 6 | Движок ослеплял чекер (exclude + skip-worktree → needs_review) | **FIXED** | См. 4f + 5: атака G2 даёт verdict **blocked**, риск high, попытка помечена. |
| 7 | Каскад не ретраил провал гейтов | **FIXED** | Статус попытки резолвится после чека: engine-complete + gates-blocked = failed c сигнатурами `gate:*`; планировщик ретраит/эскалирует (exp3 G1: 3 попытки → бюджет → needs-review). |
| 8 | Таймаут не убивал потомков | **FIXED** | spawn detached, kill по группе процессов (`process.kill(-pid)`); exp2: 500ms таймаут → 507ms факт (было 8010ms). |

## Серьёзные

| # | Находка | Статус | Что сделано |
|---|---------|--------|-------------|
| 9 | Сырые секреты в evidence-патчах | **FIXED** | `redactSecretsInText` применяется к diff.patch и failed-attempt патчам до записи; `[REDACTED:rule]`; exp3 G3: grep по артефактам пуст. |
| 10 | accept принимал blocked-задачу | **FIXED** | Guard: принимать можно только `needs_review` (последний вердикт в ledger); reject всегда доступен. exp3 H: отказ с причиной. |
| 11 | CLI vs USAGE | **FIXED** | `--rejected`/`--markdown` — булевы флаги; accept/metrics не требуют `--repo`. |
| 12 | Метрики | **FIXED** | (a) unknown-only CPAT → UNAVAILABLE, не $0; (b) пустой ledger → waste UNAVAILABLE; (c) accepted = последний review по времени (accept-then-reject не считается); (d) REC per-step: без измеренных сторон null, не 0; (e) RegressionTax с unknown — lowerBound-пометка. Тесты обновлены. |
| 13 | usage→billed без USD валид бы взорвал pipeline | **FIXED** | Pipeline пишет cost_kind unknown до появления версионированного прайсинга; validateCost остаётся стражем. |

## Мелкие

| # | Находка | Статус |
|---|---------|--------|
| 14 | recoverStaleWorkspaces удалял любые каталоги | **FIXED**: фильтр по префиксам `eil-ws-`/`eil-bench-` |
| 15 | Bench передавал каталог манифеста как --policy | **FIXED**: policy передаётся только если задана явно |
| 16 | comparability игнорировала agent/model | **FIXED**: fingerprint включает agent+model |
| 17 | captureFailedAttempt дифф от индекса | **FIXED**: дифф от base-коммита задачи |
| 18 | Полный env процессам | **FIXED**: `buildSandboxedEnv` — allowlist (PATH/HOME/TMPDIR/LANG/LC_*/TZ/SHELL + win-набор), git-дефолты |
| 19 | Обязательный not_applicable «засчитан» | **NOTED** (by design per spec): N/A допустим только с доказанным правилом активации (ds без policy, api-compat new-package) — теперь каждое N/A гейта видно в gate-results с reason; видимость для человека — в summary/task-record |
| 20 | build/dist/coverage скип на любой глубине; >2MB и .mts/.cts молча | .mts/.cts **FIXED** (в скане); скип-каталоги и лимит размера **FIXED-видимы**: secrets-scan сообщает counts scanned/skipped в reason и артефакт |
| 21 | Версия alpha.0 при CHANGELOG alpha.3 | **FIXED**: 0.2.0-alpha.4 везде |
| 22 | npm audit 3 moderate ts-morph | **NOTED**: ниже порога полки (`--omit=dev --audit-level=high`), решение в ADR 2026-11-08 |

## По зонам handoff — повторный запрос

Зоны 1 (пути), 3 (исполнение команд), 4 (vetted), 5 (import-сканер),
6 (evidence), 7 (движок/пайплайн) переработаны; просим повторный проход по
тем же репро-скриптам (exp1–exp4 воспроизводят теперь blocked/pass
корректно) и по новым поверхностям: `detectHiddenChanges`,
`scanFilesForSecrets` + allowlist, `buildSandboxedEnv`, снапшот .git в
pipeline. Замечание зоны 1 (lstat-ошибки ≠ «файла нет») принято к сведению:
в Т7 sandbox-теста и в чек-контейнере поведение не менялось; отдельный
фикс предлагаем сделать при следующем проходе вместе с 19/20 при
необходимости.

## Верификация

- Репро ревьюера exp1–exp4 прогнаны против нового build: все блокирующие
  кейсы дают blocked; таймаут 507ms; граф 183 ребра; артефакты без
  секретов.
- Полный конвейер: lint + typecheck + **197 тестов** + build + self-check
  (политика из origin/main, гейты на живом графе) — зелёные на GitHub CI
  (все 4 матрицы).
