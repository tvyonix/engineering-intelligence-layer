# Capability: engine-adapter

## ADDED Requirements

### Requirement: Independent diff checking

Система SHALL поддерживать проверку изменения без запуска coding-agent.

#### Scenario: Existing diff

- **WHEN** пользователь передаёт валидный task contract и Git diff
  - **THEN** EIL выдаёт нормализованные результаты проверок независимо от модели

### Requirement: Pluggable executor with one initial implementation

Система SHALL определять контракт адаптера, а первая реализация SHALL использовать ровно один engine; другие движки не являются блокирующей зависимостью.

#### Scenario: Provider unavailable

- **WHEN** Pi SDK или API модели недоступны
  - **THEN** standalone `check` остаётся доступным и не выдаёт ложную оценку расходов

### Requirement: One writer

Система SHALL допускать не более одного активного автора в конкретном рабочем пространстве.

#### Scenario: Concurrent task

- **WHEN** второй запуск пытается писать в занятую рабочую область
  - **THEN** он получает отдельный workspace или отказ без повреждения первого

