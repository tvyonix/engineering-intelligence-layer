# Coding-agent handoff (GLM-5.3-Flash default)

Implement the OpenSpec change `establish-engineering-intelligence-layer` in this repository. Read `README.md`, `proposal.md`, `design.md`, all capability specs, and `tasks.md` first.

Implementation policy:

1. **Do not build another agent loop.** Build an external Engineering Intelligence Layer. Start with standalone `eil check` before any Pi integration.
2. Follow tasks in order, one verifiable unit at a time. Never mark a task done without passing the tests relevant to it; record commands and exit codes.
3. Use TypeScript and the smallest set of dependencies that satisfies requirements. Prefer simple module boundaries and small functions.
4. Use GLM-5.3-Flash for main implementation. Request an independent Tier-1 review for critical security and architecture decisions or persistent failures. Tier-1 is not required to generate routine code.
5. One writer in an isolated workspace. No production deployment or merge. No access to ambient secrets.
6. Keep `tests passed`, `human accepted` and `cost known` distinct. No fake telemetry.
7. Output after each phase: changed files, tests with result, risks, unresolved questions, remaining tasks.
8. If sandbox is not demonstrably secure, implement `check-only` mode and stop before executing untrusted commands.

Acceptance:
- `eil check` runs with model providers disabled;
- mandatory failures cannot be bypassed;
- attempt histories and unknown costs are recorded correctly;
- paired A/B/C benchmark is reproducible;
- GLM-first workflow has clear bounded escalation points.
