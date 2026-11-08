# Field test results — real OSS repositories

Run: 2026-11-08T10:33:58.195Z · executor: `node scripts/field-test.mjs` (pinned SHAs inside the script)

EIL analysis commands executed against real-world TypeScript code (not fixtures): monorepo package layouts, namespace imports, `.js` specifiers, release-only commits.

| Suite | Check | Result | Detail |
|-------|-------|--------|--------|
| zod | check on a real code commit (needs_review) | PASS | verdict=needs_review, gates: path-scope:pass, import-boundaries:pass, secrets-scan:pass |
| zod | references on a widely-used real symbol (namespace imports) | PASS | 152 references incl. namespace usages (util.assertEqual), declaration at packages/zod/src/v3/helpers/util.ts:5 |
| zod | impact on a multi-file real diff | PASS | 7 changed → 180 affected, 28 affected tests, completeness=static-import-analysis (honestly flagged incomplete) |
| zod | symbols on a real module (bounded signatures) | PASS | 100 declarations, all signatures within the 400-char bound |
| hono | release-only commit (package.json only) checks clean | PASS | verdict=needs_review |
| hono | pre-existing import cycles detected as inherited (not blocking) | PASS | 6 inherited cycle(s) in real OSS code (e.g. src/compose.ts) — new-cycle gate stays green |
| zod | PR report renders from a real-repo evidence bundle | PASS | 24 lines, no absolute host paths |

All field checks passed. Findings during development of this test (fixed/validated): the initial `references` empty-result on zod was a wrong-file mistake (v4 vs v3 util); with the correct symbol the language service returns 152 references — no product defect found.
