# Crossfire SHIP: fix-traversal

- Result: shipped: approved at review pass 2
- Spec: `<repo>/.crossfire/specs/fix-traversal.md`
- Branch diff: `main`..`723cc050dcf15287e76baab14315582f7b9db2cd`, 2 file(s) changed
- Builder legs: 2 of 5; review passes: 2; 12 of 45 min
- Reviewers: codex 2/2 passes, grok 2/2 passes
- First review pass: 2 finding(s)
- Breaker: 1 pass(es), 0 proven attack(s)

## Findings
| ID | Severity | Status | Where | Reviewers | Finding |
|---|---|---|---|---|---|
| F1 | BLOCKER | closed | src/serve.mjs:8 (fix: src/serve.mjs:25-33, test/serve.test.mjs:42-100) | codex + grok | Decoded parent segments escape the public directory |
| F2 | BLOCKER | closed | src/serve.mjs:8 (fix: src/serve.mjs:13-21, test/serve.test.mjs:102-125) | grok | decodeURIComponent throws on bad percent-encoding |

## Evidence
- Proof commands crossfire ran itself (last run, round 2):
  - `npm test`: exit 0
- Tests the builder named this loop: 18 (public dir is configured, serves index.html from public/, E2E-1: /index.html and /a%20b.html resolve inside public/, relative root is resolved to an absolute path inside public/, E2E-2: traversal requests never resolve outside public/, F1: reported case /%2e%2e/%2e%2e/etc/passwd returns null, F1: plain parent segments that escape return null, F1: percent-encoded parent segments and slashes that escape return null, F1: parent segments that stay inside public/ are accepted, F1: sibling directory sharing the public prefix is rejected, F1: the public directory itself is not a file to serve, F1: backslash (Windows-style) paths return null, ...). Crossfire checks that they pass only through the proof commands above.
- Breaker: 0 attack(s) proven with failing tests; the builder answered 0 FIXED and 0 DISPUTED
- Reviewers read the branch diff against `main` read-only: codex 2/2 passes, grok 2/2 passes.
- Not verified by crossfire: anything outside the proof commands (the full test suite, lint, migrations, deploys). CI on the pull request is that gate.

## Files changed
- src/serve.mjs
- test/serve.test.mjs

## Timeline
- 2026-10-13T14:35:39.981Z init: base main (3ebb6a717bfd), spec <repo>/.crossfire/specs/fix-traversal.md; preflight: 1 proof command(s) can run here
- 2026-10-13T14:35:39.981Z from-check: pr-1: 2 finding(s) at 7b9c285825a1
- 2026-10-13T14:35:39.981Z review-recorded: pass 1: 2 finding(s) from codex, grok
- 2026-10-13T14:35:39.981Z send-builder:fix: round 2
- 2026-10-13T14:36:52.875Z build-recorded: round 2: DONE
- 2026-10-13T14:36:52.875Z send-breaker: round 2
- 2026-10-13T14:37:54.840Z break-recorded: round 2: 0 proven attack(s)
- 2026-10-13T14:37:54.840Z run-review: pass 2
- 2026-10-13T14:47:40.014Z review-recorded: pass 2: 0 finding(s) from codex, grok
- 2026-10-13T14:47:40.014Z ship: approved at review pass 2
