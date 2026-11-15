# Подключение EIL к вашему проекту

Копипаст-инструкция. EIL **не добавляет зависимостей в ваш проект** и не
меняет его код — он живёт рядом и проверяет диффы. Работа с GitHub-репозиторием [`tvyonix/engineering-intelligence-layer`](https://github.com/tvyonix/engineering-intelligence-layer).

---

## Уровень 0 — одна команда, ноль установки, ноль файлов

У вас в репозитории есть незакоммиченные изменения (от агента/человека) — проверьте их:

```bash
cd ~/work/мой-проект
npx -y github:tvyonix/engineering-intelligence-layer check --repo .
```

Первая загрузка ~минуту, дальше из кэша. Ничего не запускается на вашем
компьютере; секрет в диффе → `blocked (exit 1)` с файлом и строкой.

Вердикты: `needs_review (0)` — чисто, решает человек · `blocked (1)` —
плохое изменение, написано какое · `error (2)` — проверка не завершилась.
Отчёт для чтения появится в `eil-evidence/…/summary.md`.

---

## Уровень 1 — постоянный контроль в CI (GitHub Actions)

Два файла в вашем репозитории:

`.eil/task.yaml` — границы конкретной задачи (можно один на всё):
```yaml
version: 1
id: repo-guard
baseCommit: "HEAD"
description: "Постоянная проверка PR-диффов"
scope:
  allow: ["src/**", "tests/**"]
  protect: [".env*", ".github/workflows/**", "package-lock.json"]
acceptance:
  - id: review
    description: "Человек смотрит дифф"
policy:
  maxAttempts: 1
  noNewDependencies: false   # true = правки package.json/lockfile запрещены
```

`.eil/policy.yaml` — что проверять (генерируется в CI, см. ниже):
```yaml
version: 1
quality:
  required: ["path-scope", "secrets-scan", "dependency-policy", "import-boundaries"]
boundaries:
  forbidNewCycles: true      # новые циклы импортов запрещены, старые не валят
```

`.github/workflows/eil.yml`:
```yaml
name: eil
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: EIL check of the PR diff
        run: |
          BASE="${{ github.event.pull_request.base.sha }}"
          cat > .eil/policy-ci.yaml <<EOF
          version: 1
          quality:
            required: ["path-scope", "secrets-scan", "dependency-policy", "import-boundaries"]
          boundaries:
            forbidNewCycles: true
          EOF
          npx -y github:tvyonix/engineering-intelligence-layer check \
            --repo . --task .eil/task.yaml --policy .eil/policy-ci.yaml \
            --base "$BASE" --out eil-evidence
```

Что произойдёт: каждый PR проверяется автоматически; нарушение → красный
чек со списком проблем; полный отчёт — в артефактах (`eil-evidence/summary.md`).

---

## Уровень 2 — полный прогон (типы/линт/тесты) локально и в CI

EIL запустит команды **только** в репозиториях из вашего личного белого
списка и только с командами, которые вы прописали сами:

`.eil/policy-full.yaml`:
```yaml
version: 1
quality:
  required: ["path-scope", "secrets-scan", "types", "lint", "tests"]
  commands:
    types: "npx --no-install tsc --noEmit --pretty false"
    lint:  "npx --no-install eslint . --format json"
    tests: "npm test"
execution:
  vettedRepos:
    - "/АБСОЛЮТНЫЙ/путь/к/вашему/проекту"   # результат команды: realpath ~/work/мой-проект
  timeoutMs: 300000
```

Локально: `npx -y github:… check --repo . --task .eil/task.yaml --policy .eil/policy-full.yaml`

⚠️ Путь в `vettedRepos` — абсолютный realpath, он разный на ноутбуке и на
CI-раннере. Для CI — генерируйте секцию в workflow (как policy-ci выше),
подставив `"$(realpath .)"`. В CI тестам нужен предшествующий `npm ci`
(обычный шаг).

Провал тестов → `blocked`. Новые нарушения линта отличают от старых:
унаследованные не валят вердикт, ловятся только новые.

---

## Что ещё умеет (опционально)

```bash
# PR-отчёт из результатов проверки
npx -y github:… report --evidence eil-evidence-папка

# «кто использует эту функцию?» — read-only, без настройки
npx -y github:… symbols   --repo . --file src/app.ts
npx -y github:… references --repo . --file src/app.ts --name myFunc
npx -y github:… impact    --repo . --base HEAD~1   # что задело изменение

# журнал + ЧЕЛОВЕЧЕСКАЯ приёмка (зелёный ≠ принято)
npx -y github:… ledger --db .eil/ledger.db init
npx -y github:… check --repo . … --ledger .eil/ledger.db
npx -y github:… accept --db .eil/ledger.db --task repo-guard --reviewer "human:имя"
```

---

## Если что-то не так

| Симптом | Причина / лечение |
|---|---|
| `outside-allow:.eil/…` в диффе | Вы редактировали конфиги — добавьте `.eil/**` в `allow` или правьте их вне диффа. |
| `execution_not_permitted` на types/lint/tests | Так задумано: внесите проект в `vettedRepos` (realpath!) и задайте `commands`. |
| «указал репозиторий, всё равно не пускает» | Путь из `realpath` (macOS: `/private/var/…`); для CI путь генерируется в workflow. |
| npx качает заново | Это кэш npm; для стабильности зафиксируйте коммит: `github:tvyonix/engineering-intelligence-layer#<sha>`. |

Подробнее: [getting-started](getting-started.md) · [README](https://github.com/tvyonix/engineering-intelligence-layer)
