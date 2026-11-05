# Implementation strategy: GLM-5.3-Flash vs Tier-1

## Decision

**Use GLM-5.3-Flash for main implementation.** Use an independent Tier-1 coding/reasoning model only on high-value review points; don't spend Tier-1 tokens implementing ordinary scaffolding. Это рабочая гипотеза по разделению труда, а не гарантированная экономия.

## Model strengths and important caveat

As of 2026-11-05, Z.ai self-reports GLM-5.3-Flash 84.3 on Terminal-Bench 2.1 and 63.4 on DeepSWE 1.1, versus 85.0 and 58.0 for Opus 4.8. For **NL2Repo**, GLM Flash scored 56.3 versus Opus 4.8 69.7. These benchmark results are not a direct prediction for this system. Source: https://z.ai/blog/glm-5.3-flash .

Pi lists native compatibility: https://pi.dev/models/zai/glm-5-3-flash .

## Execution responsibilities

| Work | Preferred | Required validation |
|---|---|---|
| Scaffolding, TS contracts, Zod schemas, migrations | GLM Flash | tests + typecheck |
| Git diff parsing, ts-morph tools | GLM Flash | property/fixture tests |
| Gates and evidence formatting | GLM Flash | negative tests + CI |
| Pi SDK adapter | GLM Flash | end-to-end dry run |
| Threat boundaries, sandbox policy, secret handling | Tier-1 review + human security approval | adversarial tests |
| Architecture design/tradeoffs | Tier-1 one-time review, optionally | human acceptance |
| Complex repeated failures | Tier-1 on escalation | rerun exact failed tests |
| Product requirements, Beaver UI UX | Claude or appropriate high-quality model when necessary | UI acceptance + human review |

## Recommended prompts

**GLM implementation**: "Реализуй ровно следующий unchecked пункт tasks.md. Не изменяй scope. После реализации запусти соответствующие тесты, приведи exit codes, diff и новые риски. Не считай `test skipped` успехом." 

**Tier-1 audit**: "Независимо проверь trust boundaries, корректность изоляции, возможность prompt injection и нарушения API-контрактов по diff и evidence. Не переписывай проект. Выведи конкретные нарушения с воспроизводимыми тестами." 

## Stop rules

- More than 2 failed attempts with substantially the same error → stop and investigate context/requirements or use stronger model.
- Unknown or incomplete test result → do not accept.
- Any insecure step needing privileges → require human approval.
- Architecture proposals impacting security → demand independent human review even if Tier-1 agrees.

## Local deployment

GLM-5.3-Flash is 320B total with 18B active parameters (MoE); active parameter count does not mean full weights fit on a MacBook M2 Pro. Treat GLM Flash as an API model in MVP. Small local classifiers can be evaluated later and must not be necessary for task execution.
