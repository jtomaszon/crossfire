# Crossfire SHIP: fix-traversal

- Result: shipped: approved at review pass 2
- Spec: `<repo>/.crossfire/specs/fix-traversal.md`
- Branch diff: `main`..`a5445d8ddfe6ee788f71d2a7e2fc5708113ee66c`, 2 file(s) changed
- Builder legs: 2 of 5; review passes: 2; 15 of 45 min
- Reviewers: codex 2/2 passes, grok 2/2 passes
- First review pass: 2 finding(s)
- Breaker: 1 pass(es), 0 proven attack(s)

## Findings
| ID | Severity | Status | Where | Reviewers | Finding |
|---|---|---|---|---|---|
| F1 | BLOCKER | closed | src/serve.mjs:8 | codex + grok | Decoded traversal escapes the public directory |
| F2 | CHANGES | closed | src/serve.mjs:8 | grok | Malformed percent-encoding throws out of the resolver |

## Evidence
- Proof commands crossfire ran itself (last run, round 2):
  - `npm test`: exit 0
- Tests the builder named this loop: 19 (public dir is configured, serves index.html from public/, E2E-1: /index.html and /a%20b.html resolve inside public/, E2E-2: traversal and absolute request paths never leave public/, E2E-3: malformed percent-encoding returns null without throwing, F1: literal ../ traversal (reported case) returns null, F1: traversal nested deeper than its start still escapes and returns null, F1: percent-encoded traversal (upper/lower case, encoded slash) returns null, F1: sibling directory sharing the public prefix is rejected, F1: the public directory itself is not a file and returns null, F1: double-encoded traversal is decoded once and stays literal inside public/, F1: backslash paths (Windows-style input) return null, ...). Crossfire checks that they pass only through the proof commands above.
- Breaker: 0 attack(s) proven with failing tests; the builder answered 0 FIXED and 0 DISPUTED
- Reviewers read the branch diff against `main` read-only: codex 2/2 passes, grok 2/2 passes.
- Not verified by crossfire: anything outside the proof commands (the full test suite, lint, migrations, deploys). CI on the pull request is that gate.

## Files changed
- src/serve.mjs
- test/serve.test.mjs

## Timeline
- 2026-10-13T12:25:12.822Z init: base main (3ebb6a717bfd), spec <repo>/.crossfire/specs/fix-traversal.md; preflight: 1 proof command(s) can run here
- 2026-10-13T12:25:12.822Z from-check: pr-1: 2 finding(s) at 7b9c285825a1
- 2026-10-13T12:25:12.822Z review-recorded: pass 1: 2 finding(s) from codex, grok
- 2026-10-13T12:25:12.822Z send-builder:fix: round 2
- 2026-10-13T12:26:40.564Z malformed: build-r2-fix: F2: FIXED needs `where`, the file:line of the fix (e.g. "lib/app.rb:120"; several separated by commas)
- 2026-10-13T12:27:58.481Z build-recorded: round 2: DONE
- 2026-10-13T12:27:58.481Z send-breaker: round 2
- 2026-10-13T12:29:06.529Z break-recorded: round 2: 0 proven attack(s)
- 2026-10-13T12:29:06.529Z run-review: pass 2
- 2026-10-13T12:29:08.256Z review-recorded: pass 2: 0 finding(s) from codex, grok
- 2026-10-13T12:29:08.256Z ship: approved at review pass 2
