# Capability: diff-quality

## ADDED Requirements

### Requirement: Mandatory gates

Система SHALL обеспечивать детерминированные проверки scope, types, tests, dependency boundaries, public API и dependencies согласно применимости.

#### Scenario: Failing required gate

- **WHEN** обязательный gate возвращает `fail` или `error`
  - **THEN** изменение нельзя принять независимо от оценки LLM

#### Scenario: No baseline available

- **WHEN** сравнение публичного API невозможно из-за отсутствия baseline
  - **THEN** система сообщает `error` или `needs_review`, но не выставляет `pass`

### Requirement: Existing defects

Система SHALL отличать новые нарушения от исходных нарушений в базовом коммите.

#### Scenario: Pre-existing violation

- **WHEN** нарушение уже существует в baseline и diff его не ухудшает
  - **THEN** оно классифицируется как исходное, а не как дефект новой реализации

### Requirement: Design system rules

Система SHALL применять заранее определённые, проверяемые правила дизайн-системы только если она явно подключена.

#### Scenario: Unknown UI component

- **WHEN** Beaver UI policy запрещает компонент или prop в изменении
  - **THEN** gate возвращает нарушение с указанием файла и контракта

