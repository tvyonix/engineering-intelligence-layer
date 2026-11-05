# Sandbox security test results — task 3.2

**Дата:** 2026-11-06 · **Хост:** macOS 15 (arm64), Docker Desktop 29.5.3
**Образ:** `node:22-bookworm` (полный Debian-вариант: включает git; alpine
не подошёл — нет git, а сеть внутри контейнера запрещена, поэтому apk add
невозможен)
**Конфигурация контейнера:** `--cap-drop ALL --security-opt
no-new-privileges --read-only --tmpfs /tmp --pids-limit 64(256 для T7)
--memory 256m --memory-swap 256m --cpus 1 --user 1000:1000 --network none
-e HOME=/tmp`, bind-mounts: только workspace (rw), evidence (rw),
репозиторий EIL и node_modules (ro, только для T7).

**Исполнитель теста:** скрипт `scripts/sandbox-security-test.sh`
(план: [docs/sandbox-security-test-plan.md](../docs/sandbox-security-test-plan.md)).

## Вердикт: **22/22 PASS** — изоляция контейнерной конфигурации подтверждена

| ID | Тест | Результат | Примечание |
|----|------|-----------|------------|
| T1.1 | Хостовая /Users не видна | **PASS** | denied (exit 1) |
| T1.2 | /root/.aws, /root/.ssh недоступны | **PASS** | denied |
| T1.3 | Запись вне /workspace запрещена | **PASS** | read-only rootfs |
| T1.4 | Запись в /workspace и /tmp работает | **PASS** | |
| T1.5 | Нет хостовых bind-mounts, кроме заявленных | **PASS** | матчатся целевые пути маунтов; служебный маркер `/run/host_mark` Docker Desktop не является хостовым путём (уточнено в ходе прогона) |
| T2.1 | Ambient env без токенов | **PASS** | |
| T2.2 | SSH/AWS-ключи недостижимы | **PASS** | |
| T2.3 | Env образа без секретов | **PASS** | |
| T3.1 | Исходящий HTTP запрещён | **PASS** | `--network none` |
| T3.2 | DNS не резолвится | **PASS** | |
| T4.1 | Только процессы контейнера | **PASS** | |
| T4.2 | PID-namespace изолирован | **PASS** | |
| T4.3 | pids-limit 64 работает | **PASS** | fork-цикл отклонён (exit 2) |
| T5.1 | Symlink из workspace видит rootfs контейнера, не хост | **PASS** | |
| T5.2 | /proc/1/root — rootfs контейнера | **PASS** | |
| T5.3 | docker.sock не смонтирован | **PASS** | критично |
| T5.4 | mount запрещён | **PASS** | cap-drop ALL |
| T5.5 | su/эскалация запрещены | **PASS** | no-new-privileges |
| T6.1 | Лимит памяти работает | **PASS** | exit 137 (OOM); **требуется `--memory-swap 256m`** — без него выделение уходит в swap (уточнено в ходе прогона) |
| T6.2 | CPU limit `--cpus 1` | INFO | информационно |
| T7.1 | `eil check` работает внутри контейнера | **PASS** | JSON-вердикт выдан; **требовался полный образ с git** (alpine не содержит git, сеть для apk недоступна) |
| T7.2 | Смонтированный workspace не изменён check'ом | **PASS** | git status чист |
| T7.3 | Evidence записан в отдельный rw-маунт | **PASS** | |

## Находки в ходе прогона (исправлены)

1. **Портабельность check** — `main.ts` статически импортировал ts-morph
   (через context-commands) и нативный better-sqlite3. Исправлено ленивыми
   импортами: check-путь не загружает тяжёлые/нативные модули (проверено
   хуком на module._load: [] на этапе импорта).
2. **UX** — `eil check --json` при ошибке глотал причины. Исправлено: при
   ненулевом exit в JSON-режиме причины печатаются в stderr.
3. **T6.1** — нужен `--memory-swap 256m`: Docker по умолчанию разрешает
   swap вдвое сверх лимита, и выделение 400 MB не падало.
4. **T7** — образ обязан содержать git (check вызывает git для
   read-only-операций); выбран `node:22-bookworm`.

## Статус 3.2

- Изоляция контейнерной конфигурации **подтверждена техническим
  security-тестом** по плану ТЛ (файлы/секреты/сеть/процессы/escape/лимиты).
- **Ограничение:** тест выполнялся на Docker Desktop хоста разработки
  (macOS). Решение о целевой инфраструктуре runner'а (отдельная Linux VM с
  Colima/Docker внутри, как постановил ТЛ) и **финальный sign-off — за
  человеком/Tier-1 в рамках 1.7**. До sign-off исполнение команд из
  недоверенных репозиториев остаётся запрещённым (execution policy:
  только vetted fixtures).
- Скрипт воспроизводим: `bash scripts/sandbox-security-test.sh`
  (переменная `IMAGE` переопределяет образ).
