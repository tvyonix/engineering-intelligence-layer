# Capability: evaluation-ledger

## ADDED Requirements

### Requirement: Complete attempt telemetry

Система SHALL сохранять идентификаторы модели/engine, версии правил, исходы проверок, число попыток и достоверность стоимости.

#### Scenario: Price unknown

- **WHEN** провайдер не возвращает usage и тарифы неизвестны
  - **THEN** стоимость помечается `unknown`, а не нулём

#### Scenario: Failed attempt

- **WHEN** попытка не прошла gate
  - **THEN** её стоимость учитывается в общем расходе задачи

### Requirement: Meaningful acceptance

Система SHALL отдельно хранить machine gate status, review result и post-merge regressions.

#### Scenario: Human corrections requested

- **WHEN** ревьюер принимает изменение после правок
  - **THEN** сохраняются факт приёмки, объём правок и затраченное время если они доступны

### Requirement: Protect training data

Система SHALL исключать raw source code и secrets из аналитических экспортов по умолчанию.

#### Scenario: Export dataset

- **WHEN** пользователь экспортирует историю
  - **THEN** экспорт содержит допустимые агрегированные признаки без исходных кодовых фрагментов и токенов авторизации

