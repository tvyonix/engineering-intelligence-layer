# Experiment design: demonstrate value, not an impressive demo

## Central hypothesis

For repeated changes to the same TypeScript product, adding EIL gates and evaluation reduces accepted cost or regression tax at non-inferior functional correctness versus the same agent alone.

## Variants

- A: Pi + GLM-5.3-Flash without EIL gates; baseline.
- B: exact same engine/model/snapshot + deterministic gates.
- C: B plus risk-aware cascade/escalation (strong tier only when configured/approved).

## Prevent confounding

Use equivalent tasks, initial commit, acceptance scripts, tool permissions, max budget, timeout and compute. Record whether Model B/C differs because C escalated. Randomize or counterbalance task order. Run independent replicates. Evaluators should not know experiment variant when feasible.

## Measurements

- Primary: `CostPerAcceptedTask` with unknown cost not treated as zero; task-level numerator includes all retries and LLM verification calls.
- Quality co-primary: acceptance rate with external deterministic tests + human review.
- `RegressionTax` per sequential step and `REC_k` relative to paired control.
- Secondary: review minutes, time-to-accept, false block rate, gates runtime, cascade waste, changed API contracts, complexity delta.

## Sequential benchmark

One 6-step evolution scenario is a smoke-test, **not statistical evidence**. Repeat in multiple independent projects/branches, at varying task complexities. The follow-on steps must rerun earlier tests. Report failure cases and not just final success.

## Data hygiene

Record selected routes and alternative candidates; do not claim counterfactual routing regret from single-route logs. Dataset exports redact private code. Human reviewer feedback is delayed, variable and potentially biased. LLM-judge feedback is auxiliary and calibrated against human review, never grounds automatic security acceptance.

## Decision rules

Before claiming improvement, preregister primary metrics, thresholds and uncertainty reporting; improvement must not be bought at lower correctness. If A and B/C have indistinguishable quality/cost with wide uncertainty, classify as inconclusive — do not announce a win.
