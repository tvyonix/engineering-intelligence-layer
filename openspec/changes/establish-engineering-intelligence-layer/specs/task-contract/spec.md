# Capability: task-contract

## ADDED Requirements

### Requirement: Machine-readable task contract

Система SHALL принимать версионированный контракт задачи, содержащий идентификатор, base commit, разрешённые/защищённые пути и проверяемые критерии приёмки.

#### Scenario: Valid scoped request

- **WHEN** контракт содержит существующий base commit и непустую область разрешённых изменений
  - **THEN** он проходит валидацию и получает стабильный contract hash

#### Scenario: Invalid privileged scope

- **WHEN** контракт пытается разрешить запись в защищённую область без утверждённой политики
  - **THEN** задача блокируется до запуска агента

### Requirement: Human acceptance distinct from test success

Система SHALL отличать технический статус проверки от факта принятия работы человеком.

#### Scenario: Tests green but not reviewed

- **WHEN** все automated gates зелёные, но отзыв человека отсутствует
  - **THEN** задача имеет статус `needs_review`, а не `accepted`

