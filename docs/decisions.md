# Engineering decisions log

Dated, reviewable decisions that change EIL behaviour. Spec-level requirements
live in `openspec/`; this file records how open questions were resolved.

## 2026-11-05 — Phase 0 review (tech lead)

| Question | Decision |
|----------|----------|
| OS sandbox | Linux VM with a container runner for local macOS development (Colima or Docker Desktop are candidates). No agent command execution on the host. The choice must be confirmed by a security test: file, secret, network and process isolation, and inability to escape the allowed workspace. |
| External model APIs | Forbidden by default. Allowed per repository and per provider only after the source-transfer policy is reviewed. |
| Human accepted | An explicit human acceptance of a concrete commit/diff and its evidence bundle. Green CI never implies human accepted. |
| Unknown cost | Stays `unknown`; never rendered as `0`. |
| Merge | Only after checks and explicit human confirmation. |

### Scope overlap: allow ∩ protect is valid

`allow: src/**` together with `protect: src/index.ts` must be a valid contract.
Runtime `protect > allow` (path-scope gate) provides the safety property, so a
blanket contract-level rejection was over-restrictive for normal development.

- Contract validation reports overlap as **warnings** (`scopeOverlapWarnings`).
- Runtime enforcement is unchanged: a changed file matching protect is a
  `protected-path` violation even when allow matches it.
- The task contract cannot widen protection: `protect` lists are only read
  from the contract/operator policy, never from repository content.

### Evidence patch truncation is an error

The saved diff patch is capped at 16 MiB. Truncation is acceptable for storage,
but the check must then report **`error`** (exit 2), never `pass`: a synthetic
mandatory gate `diff-patch-integrity` fails closed, because the evidence bundle
no longer contains the full diff under review.

### Command execution before sandbox

Phase 1 gates (types, lint, tests) execute repository code. Until an approved
sandbox runner exists:

- host execution is **denied by default** (`execution_not_permitted`);
- commands run only inside repositories explicitly vetted by realpath in
  `execution.vettedRepos` — intended for verified test fixtures;
- gate commands come from operator policy only (`quality.commands`),
  never from repository content.

### Phase 1 execution order

GLM-5.3-Flash implements 1.1 (command gates), 1.2 (import boundaries),
1.3 (lockfile approval), 1.4 (evidence/baseline separation). Tier-1 performs
the security review (1.7) **before** command execution is enabled for any
untrusted repository, and again after the sandbox lands. No Pi SDK, no router,
no new LLMs until `eil check` is solid.

### Negative-test criterion for Phase 1

The phase is not complete when EIL detects violations; it is complete when EIL
never produces a positive verdict with incomplete mandatory verification.
Required negative scenarios, each with a verifiable exit code and an evidence
record: missing command, command timeout, invalid configuration, symlink
outside the workspace, changed lockfile, incomplete diff (truncated patch),
parser failure, killed child process.

## 2026-11-07 — Pin better-sqlite3 to 12.x (v13 native segfault on node 20)

**Проблема.** Все прогоны GitHub Actions CI с первого коммита были красными:
vitest-воркеры умирали (`ERR_IPC_CHANNEL_CLOSED`). Локально на macOS+node 22
всё было зелёным — комбинация, не попадающая в битую пару.

**Диагностика.** Не воспроизводилось в контейнерах node 22 (arm64/amd64,
CI=true, лимиты CPU/памяти раннеров). Воспроизведено в контейнере node:20 —
и сужено до одной строчки вне vitest: `require('better-sqlite3')` →
SIGSEGV (exit 139). То есть prebuilt-бинарник better-sqlite3@13.0.3 бит для
node 20 (ABI 115); любой тест, грузящий ledger, ронял воркер. Временный
обход (`fileParallelism: false` на CI) снят после устранения причины.

**Решение.** better-sqlite3 закреплён на 12.2.0 (проверено: node 20/22,
linux arm64/x64, полный прогон 195/195 параллельно). Миграция на v13 —
только после появления рабочих prebuilds для node 20 в upstream и
проверки в CI-матрице.

**Урок для процесса.** Зелёный локальный CI не означает зелёный CI:
матрица платформ имеет смысл, только если её результаты кто-то читает.
Проверка статуса GitHub Actions добавлена в определение done для фаз.

**Влияние на ревью 1.7.** Зона 6 брифа (ledger/нативные зависимости)
дополнена фактом: нативная зависимость уже однажды роняла весь тестовый
конкур тихо; при ревью — проверить целесообразность замера на
node-sqlite3-wasm как альтернативы без нативного кода.

## 2026-11-08 — Dependency security: runtime chain clean, dev chain accepted

**Контекст.** `npm audit` показывал 13 уязвимостей (2 critical, 1 high) с
первого коммита — никто их не читал (см. урок ADR от 2026-11-07 про CI).

**Разбор и действия.**
- `tinypool ≤2.1.1` (critical, prototype-pollution → RCE в опциях воркера;
  dev-цепочка vitest) — закрыто точечным `overrides: { tinypool: ^2.1.2 }`
  вместо breaking-апгрейда vitest 5; suite 199/199 зелёной.
- `zod <4.6.6` (high, memory exhaustion на oversized constrained
  collections) — **runtime**-зависимость (валидация контрактов/политик).
  Апгрейд до zod 4.6.7 выполнен: поверхность API консервативна, единственная
  миграция — `z.record(v)` → `z.record(k, v)` (2 вызова). Strict-семантика
  контрактов подтверждена тестами (unknown-field rejection).
- Остаток (обновление 2026-11-08, позднее тем же днём): `@vitest/mocker`
  закрыт апгрейдом vitest 3.2.7 → 4.1.12 (адвайзори покрывает ≤4.1.11;
  breaking-переход на vitest 5 не потребовался). Попутно tinypool исчез из
  дерева — vitest 4 не использует его, отдельный override снят.
  Инсталляция потребовала `npx npm@11 install`: npm 10.9.3 (арборист)
  падает `Cannot read properties of null (reading 'edgesOut')` в
  loadPeerSet на peer-цепочке `@vitest/browser-playwright` vitest 4 —
  баг npm, воспроизводимый на голом `npm i -D vitest@4.1.12 typescript`;
  свежая npm собирает дерево нормально, lockfile читается любой.
- Финальный остаток: 1 moderate `minimatch` (ReDoS-класс) в dev-транзитиве
  @ts-morph/common/typescript-estree. Override на мажор minimatch рискует
  сломать транзитивы сильнее, чем ReDoS при парсинге собственных globs —
  принято оставить; runtime-полка CI (--omit=dev) его не видит.

**Защита от регрессий.** В CI добавлен шаг
`npm audit --omit=dev --audit-level=high`: падает, если в runtime-цепочке
появится high/critical. Dev-цепочка сознательно вне жёсткой полки.

## 2026-11-08 — npm 11 compatibility: explicit allowScripts

`npx npm@11 ci` собирает проект, включая нативный better-sqlite3
(install-скрипты пока предупреждение, не блок). Чтобы будущие ужесточения
npm не сломали сборку молча, install-скрипты двух легитимных нативных
пакетов (better-sqlite3, fsevents) одобрены явно полем `allowScripts` в
package.json. Побочный эффект перехода через npm@11: spec'и в package.json
нормализованы под фактические версии локфайла (typescript ^5.9.3) — CI на
этих версиях зелёный до и после.

Покрытие тестами зафиксировано для ревьюера: `npm run coverage`
(85% statements / 70% branches / 92% functions; слабое место — usage-ветки
CLI, не детерминированные модули решений).

## 2026-11-11 — Round 1 security review: verdict NOT SIGNED, all findings fixed

Независимый ревьюер отклонил подпись 1.7: 8 блокирующих, 5 серьёзных,
9 мелких находок (воспроизведения — его собственные скрипты exp1–exp4).
Ключевые классы: слепой import-граф (NodeNext), self-check вне CI и в
PR-контролируемом файле, 5 обходов secrets-scan, исполнение git-конфига
целевого репозитория на хосте, ослепление чекера движком, каскад без
ретраев гейтов, таймаут без убийства потомков, сырые секреты в evidence,
accept blocked-задач, расходжение CLI/USAGE, 5 дефектов честности метрик.

Все закрыты в тот же день и верифицированы прогонами exp1–exp4 против
нового build (все атакующие кейсы → blocked; таймаут 507ms; граф 183
ребра; артефакты без секретов). Оживший гейт немедленно нашёл 2 реальных
нарушения в самом EIL — подтверждение тезиса ревьюера о слепоте.

Процессные следствия: (1) self-check обязан выполняться в CI и с
политикой из origin/main, иначе он декоративен; (2) полнота графа
проверяется числом рёбер, а не кодом ответа; (3) детектор, который автор
диффа может выключить строкой (маркер), — не детектор: маркер живёт
только в привилегированном allowlist; (4) намерение (gitignore билд-
артефактов) неотличимо от атаки по содержимому — это операторское
решение (workspaceIntegrity.ignoreHidden, дефолт пуст).

Ожидается повторный sign-off; Phase 3 остаётся закрытой до него.
