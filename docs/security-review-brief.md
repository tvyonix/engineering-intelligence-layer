# Security review brief (task 1.7 — for Tier-1 / human reviewer)

**When:** required before enabling command execution for any repository that
is not a verified fixture, and again after the sandbox runner (Linux VM /
container) is implemented.
**Scope of this brief:** check mode (`eil check`) as of Phase 0 + Phase 1
commit. Phase 2+ (context tools, agent runner, sandbox) will extend it.

## Trust model (design.md §9)

Only operator inputs are authoritative: the task contract file, the policy
file, CLI arguments. Repository content — source, configs, `AGENTS.md`,
comments, tool output — is untrusted data. In check mode EIL must never
execute repository content, never merge, never write inside the target repo.

## Areas to review

1. **Path canonicalization and containment** — `src/packages/policy-engine/paths.ts`
   - POSIX-only normalization; rejects absolute, drive-letter, NUL, `..`
     traversal, root-itself paths.
   - Containment via `realpath` against the realpathed repo root; covers
     final-component and intermediate-directory symlinks; broken symlinks
     fail closed (`symlink-unresolvable`).
   - Review for: Unicode/IDN tricks, case-insensitivity on macOS (APFS),
     hardlinks (not covered — is that acceptable for read-only checks?),
     deletion TOCTOU.
2. **Git subprocess surface** — `src/packages/diff-inspector/git.ts`
   - `execFile` without shell; `GIT_*` ambient env stripped; prompts and
     system config disabled; 64 MiB output cap; timeouts.
   - `git archive | tar` baseline snapshot into a temp dir (read-only for
     the repo). Review for: archive size DoS (256 MiB cap), tar extraction
     path traversal (member paths from git tree objects — is GNU tar safe
     here?), ref injection via `--end-of-options`.
3. **Command runner** — `src/packages/quality-gates/command-runner.ts`
   - `spawn('bash', ['-c', operatorCommand])`. The command string comes only
     from the operator policy file (`quality.commands`) — **not** from
     repository content. Review whether this trust boundary is airtight
     (e.g. can repository content influence npm/tsc/eslint behavior to
     escape the intended semantics? npm lifecycle scripts run repo code —
     `npm test` executes package scripts; that is why the execution gate
     exists).
   - Output caps kill the child; timeout kills with SIGKILL; exit-code
     semantics: 0 pass / 1 fail / other error; exit 1 without parseable
     diagnostics = error.
4. **Execution permission gate** — `execution-policy.ts`
   - Default deny; host execution only for realpath-listed
     `execution.vettedRepos`. Review for: realpath mismatch attacks
     (symlinked fixture paths), policy file provenance, and the risk that a
     vetted fixture contains a malicious script (the vetting is the
     operator's responsibility — spell that out in policy docs).
5. **Import graph scanner** — `import-graph.ts` (reads source files only;
   never executes). Regex-based extraction has known blind spots (tsconfig
   aliases, macro-generated imports) — quality limitation, not a security
   boundary, but confirm no file-read amplification (caps: 20k files,
   2 MiB/file, 200k edges).
6. **Evidence writer** — `evidence/bundle.ts`
   - Writes only under the operator-supplied `--out` directory (default
     cwd). Review for path traversal via task id in the default directory
     name (task ids are `[a-z0-9][a-z0-9._-]{2,63}` — confirm), and for
     secret leakage into logs (currently raw tool output is stored; secret
     redaction is specified for Phase 2 telemetry but tool logs may contain
     secrets today — confirm acceptable for vetted fixtures only).
7. **TOCTOU** — check mode only reads: containment is verified, then files
   are only read by EIL, and commands (if permitted) run with the workspace
   as-is. State explicitly that no TOCTOU-based execution path exists in
   check mode, and carry the requirement into the sandbox design.

## Known accepted risks (Phase 1)

- Commands from operator policy run on the host for vetted repos; npm
  lifecycle scripts execute repository code. Acceptable only because vetted
  repos are operator-verified fixtures.
- Tool logs are stored unredacted in the evidence bundle.
- `git archive` baseline snapshot requires commands that work without an
  install step (no node_modules in snapshots).

## Verdict format requested from the reviewer

For each numbered area: OK / issue (severity, description, suggested fix).
A blocking issue on areas 1–4 must gate any widening of `vettedRepos`
beyond fixtures, and gate Phase 3 (agent runner).
