# Capability: routing-policy

## ADDED Requirements

### Requirement: Deterministic risk routing

Система SHALL маршрутизировать задачи по явным правилам риска и бюджету, без обязательной обученной модели.

#### Scenario: Routine change

- **WHEN** задача low risk, budget достаточен и cheap tier доступен
  - **THEN** cheap tier запускается первой попыткой

#### Scenario: Sensitive code

- **WHEN** задача затрагивает auth, secrets или privileged CI
  - **THEN** cheap-first policy не применяется без специального разрешения и задача требует независимой проверки

### Requirement: Bounded escalation

Система SHALL ограничивать повторные попытки и сохранять причины эскалации.

#### Scenario: Budget exhausted

- **WHEN** достигнут hard budget cap
  - **THEN** агент останавливается и задача остаётся непринятой

#### Scenario: Escalation after failure

- **WHEN** обязательный gate воспроизводимо падает после разрешённого числа повторов
  - **THEN** эскалация начинается в новой сессии на контролируемой рабочей копии

### Requirement: Optional decision models

Система MAY поддерживать интерфейс decision model, но его отсутствие SHALL NOT блокировать маршрутизацию.

#### Scenario: Decision model disabled

- **WHEN** ML-маршрутизатор недоступен
  - **THEN** deterministic policy продолжает работу без изменения security constraints

