# Capability: evolution-benchmark

## ADDED Requirements

### Requirement: Paired benchmark

Система SHALL поддерживать A/B/C-прогоны с явным фиксированием исходного состояния, engine, модели, ресурсов и критериев приёмки.

#### Scenario: A versus B

- **WHEN** сравниваются базовый агент и тот же агент с gates
  - **THEN** различия условий и результатов записаны, а результаты не объявляются причинными при несопоставимых конфигурациях

### Requirement: Sequential product evolution

Система SHALL запускать последовательные изменения проекта и повторно проверять требования предыдущих этапов.

#### Scenario: Step 6

- **WHEN** выполнен шестой шаг benchmark
  - **THEN** проверки шагов 1–6 исполняются повторно и регрессии атрибутируются по доступным данным

### Requirement: Metric honesty

Система SHALL рассчитывать Cost per Accepted Task, Regression Tax, REC и Cascade Waste с указанием пропущенных данных.

#### Scenario: Incomplete human review

- **WHEN** принятых человеком задач ещё нет
  - **THEN** Cost per Accepted Task помечается как недоступный, а не делится на фиктивную единицу

