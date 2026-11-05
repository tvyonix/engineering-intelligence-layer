# Capability: delivery-evidence

## ADDED Requirements

### Requirement: Evidence bundle

Система SHALL выдавать машиночитаемый и человекочитаемый отчёт с diff, gate results, версиями политик, расходами и ошибками.

#### Scenario: Completed task

- **WHEN** выполнена проверка задачи
  - **THEN** отчёт содержит status каждого gate, полные логи по ссылке и итоговый статус review

#### Scenario: Failed check

- **WHEN** проверка провалилась
  - **THEN** пакет сохраняет проверяемую причину и не объявляет задачу завершённой

### Requirement: No automatic merge

Система SHALL отделять производство diff от его принятия и объединения с основной веткой.

#### Scenario: All gates pass

- **WHEN** все gates пройдены
  - **THEN** предлагается ручное ревью/PR, а автоматический merge не выполняется

