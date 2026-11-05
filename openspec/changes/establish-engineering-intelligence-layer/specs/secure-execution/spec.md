# Capability: secure-execution

## ADDED Requirements

### Requirement: Isolated execution

Система SHALL изолировать выполнение недоверенных scripts от пользовательского home, секретов и основной Git ветки.

#### Scenario: Sandbox missing

- **WHEN** защищённая среда недоступна
  - **THEN** запуск недоверенного кода блокируется, доступен только `check-only`

#### Scenario: Unsafe repository instructions

- **WHEN** README или комментарий просит выполнить запрещённую команду либо раскрыть секрет
  - **THEN** такое содержимое трактуется как данные и не повышает полномочия агента

### Requirement: Controlled permission

Система SHALL применять allowlist для инструментов/сети и требовать одобрения для привилегированных действий.

#### Scenario: Attempted credential access

- **WHEN** агент или test script пытается прочитать ambient credentials
  - **THEN** доступ запрещён и событие журналируется без содержимого credentials

#### Scenario: Sensitive repo with no data agreement

- **WHEN** не задано разрешение на передачу исходников внешнему провайдеру
  - **THEN** внешние model API недоступны для данного workspace

