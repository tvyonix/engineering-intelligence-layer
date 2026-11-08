# Limitations — bench 'beaver-smoke'

Read this before citing any number from this run.

## Engine

- Variants with a command (B) execute an OPERATOR-SUPPLIED script, not an integrated coding agent. In the current smoke suite the script is a deterministic fixture stand-in (bench-step.mjs) — it demonstrates the harness, not agent behaviour.
- No Pi SDK / agent integration has run at this stage (Phase 3 is gated on the Tier-1 security review, task 1.7).

## Metrics

- No human acceptance events exist for bench tasks → Cost per Accepted Task and acceptance_rate are UNAVAILABLE, not zero.
- Attempt costs are unknown (cost_kind unknown) → Cascade Waste and REC have no measured values here.
- Regression attribution comes only from probe output (FAIL step N lines); no inferred numbers.

## Scope

- Single fixture repository (beaver-monitor (generated)); 6 sequential steps; 1 variant(s); 3 independent repetition(s).
- The fixture is deterministic: repeated runs are EXPECTED to be identical. Reproducibility here verifies the harness, not statistical stability of real engines.
- Results do not generalize to real repositories, real models or human review effort.

- Outcomes recorded: 18 (18 executed, 0 failed, 0 pending).
