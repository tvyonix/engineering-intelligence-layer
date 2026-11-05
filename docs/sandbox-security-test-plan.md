# Sandbox security test plan — task 3.2

**Цель:** подтвердить техническим security-тестом выбор sandbox (решение ТЛ
от 2026-11-05: Linux VM + контейнерный runner; Docker Desktop/Colima —
кандидаты) до подключения исполнения команд из недоверенных репозиториев
(Phase 3.3-остаток, 3.4+).

**Правило вердикта:** любой FAIL в T1–T5 = sandbox не одобрен, исполнение
остаётся запрещённым (`eil check` продолжает работать в check-only режиме).
Финальный sign-off — человеком в рамках 1.7 (этот тест — вход, не замена).

**Конфигурация контейнера под тест (design.md §9):**

```bash
docker run --rm \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,size=64m,noexec \
  --pids-limit 64 --memory 256m --cpus 1 \
  --user 1000:1000 \
  -v "$WORKSPACE:/workspace:rw" \
  --network none \
  -e HOME=/tmp \
  <image> sh -c '...'
```

Свойства, которые даёт эта конфигурация: корневая ФС образа read-only,
единственная rw-точка — `/workspace` (копия задачи), окружение не содержит
ambient-переменных, сети нет, возможности drop-нуты, root отклонён,
лимиты процессов/памяти/CPU заданы, docker.sock не монтируется.

## T1 — Файловая изоляция

| ID | Проверка | Действие в контейнере | Ожидание |
|----|----------|----------------------|----------|
| T1.1 | Хостовая домашняя папка не видна | `ls /Users` (macOS-хост) | FAIL (нет такого пути в rootfs образа) |
| T1.2 | Хостовые секретные каталоги не видны | `ls ~/.ssh /root/.aws 2>&1` | FAIL |
| T1.3 | Запись вне `/workspace` невозможна | `touch /etc/evil` | FAIL (read-only rootfs / не-root) |
| T1.4 | Запись в workspace и /tmp работает | `touch /workspace/ok /tmp/ok` | PASS |
| T1.5 | Никаких хостовых bind-mounts, кроме заявленных | `grep -E '(/Users\|/private\|/Volumes)' /proc/self/mounts` | FAIL (0 строк) |

## T2 — Секреты

| ID | Проверка | Действие | Ожидание |
|----|----------|----------|----------|
| T2.1 | Ambient env не протекает | `env \| grep -Ei '(token\|secret\|api_?key\|aws\|gh_)'` | FAIL (0 строк) |
| T2.2 | SSH/AWS-ключи хоста недоступны | `cat /workspace/../../../*/ssh/* 2>&1` и T1.2 | FAIL |
| T2.3 | Снаружи (docker inspect): Env содержит только переданное; Mounts — только `/workspace` | `docker inspect` разбор | PASS |

## T3 — Сеть (deny by default)

| ID | Проверка | Действие | Ожидание |
|----|----------|----------|----------|
| T3.1 | Исходящих соединений нет | `wget -T 3 -q http://example.com && echo LEAK` | FAIL (сеть недоступна) |
| T3.2 | DNS не резолвится | `nslookup example.com` | FAIL |

## T4 — Процессы

| ID | Проверка | Действие | Ожидание |
|----|----------|----------|----------|
| T4.1 | Видны только процессы контейнера | `ps aux` | в списке нет хостовых процессов |
| T4.2 | PID 1 — процесс контейнера | `readlink /proc/1/exe` | entrypoint контейнера |
| T4.3 | pids-limit работает | fork-цикл до 64+ | FAIL (fork error) |

## T5 — Escape-сценарии

| ID | Проверка | Действие | Ожидание |
|----|----------|----------|----------|
| T5.1 | Symlink из workspace наружу не даёт хост | `ln -s / /workspace/esc; ls /workspace/esc/Users` | FAIL (rootfs контейнера, не хост) |
| T5.2 | `/proc/1/root` — это rootfs контейнера | `ls /proc/1/root/Users` | FAIL |
| T5.3 | docker.sock не смонтирован | `ls /var/run/docker.sock` | FAIL (критично) |
| T5.4 | mount/setuid-эскалации отключены | `mkdir /etc/x` / `mount -t tmpfs none /mnt` | FAIL (cap-drop ALL) |
| T5.5 | Повышение привилегий невозможно | `su`, `sudo` у non-root | FAIL |

## T6 — Лимиты ресурсов

| ID | Проверка | Действие | Ожидание |
|----|----------|----------|----------|
| T6.1 | Память ограничена | выделить >256 MB | процесс убит OOM |
| T6.2 | CPU ограничен | нагрузка в 1 поток | не влияет на хост заметно (информационно) |

## T7 — EIL check внутри изолированного контейнера

| ID | Проверка | Действие | Ожидание |
|----|----------|----------|----------|
| T7.1 | `eil check` работает в контейнере на read-only смонтированном workspace; evidence пишется в отдельный rw-маунт | `node /eil/apps/cli/main.js check --repo /workspace ... --out /evidence` | verdict идентичен хостовому прогону; репозиторий не изменён |

## Запуск

```bash
scripts/sandbox-security-test.sh     # выполняет T1–T7, печатает вердикт
```

Результаты фиксируются в `ops/sandbox-security-results.md`. После PASS по
T1–T5 и T7: sandbox-инфраструктура одобрена к использованию в 3.3-остатке и
3.4+ (окончательный sign-off — 1.7).
