# Crossfire builder brief: fix-traversal, round 2 of 5: Fix the review findings

## Read first
- The spec: `<repo>/.crossfire/specs/fix-traversal.md` (read all of it; it is the contract).
- The plan: `<repo>/.crossfire/specs/fix-traversal.plan.md` (its tasks, the exact files each one touches, and its Review Focus: write those tests first).
- Repository: `<repo>`, branch `feature/resolve-public`, compared against `main`.
- Any document the spec names, by the absolute path it gives.

## Before you edit: depth first
Inside a crossfire round, depth beats brevity. Any instruction elsewhere to keep reads brief or to delegate exploration applies to the main session, not to you.
- Read every document the spec lists, in full, and the repository's own notes for this area (its CLAUDE.md or AGENTS.md usually has a topic map: follow it to the area's docs).
- Read every file you will change in full, not line ranges, and the callers of every method you change.
- Look for how the repository already solves the same problem (an existing callback, job, lock or pattern) before inventing one.
- Before writing code, list for yourself how this change could fail (the spec's "How this could fail" section is the start, not the end), and write those tests first.


## What reviewers found in this repository before
Earlier loops and reviews here found these kinds of problems. Check whether this change could have any of them, and test for the ones that apply:
- 2026-10-13 · BLOCKER · src/serve.mjs · Decoded traversal escapes the public directory (codex+grok, reported in check pr-1)
- 2026-10-13 · CHANGES · src/serve.mjs · Malformed percent-encoding throws out of the resolver (grok, reported in check pr-1)

## Rules for every round
- Work only in this repository and branch. Never push, merge, rebase onto another branch, or force-push.
- Test first: write or extend a failing test, then make it pass (superpowers:test-driven-development if it is available).
- Every claim in your result maps to a named test that exists in the tree. A claim you cannot point to a test for does not go in the result.
- Every shortcut fails closed. If something is unfinished, it refuses or errors loudly; it never silently succeeds.
- Never edit, weaken, skip or delete an E2E test or invariant the spec defines. You may add tests.
- Files the spec marks as owner-built get small targeted fixes only: no rewrites, restyling or restructuring.
- Finish by committing everything (`git add -A && git commit`), so `git status` is clean. Reviewers only see committed work.

## Commands crossfire runs itself after your round (gate G0)
Your round only reaches review if all of these exit 0:
- `npm test`

## This round
The reviewers found the problems below.
Each one is evidence of a rule being broken, not a list of lines to patch. For each one:
1. Name the **broadest** rule that still holds. Not "re-check the flag after the second save" but "a post-commit decision reads committed state, never the in-memory object". A rule that only covers the cited case is too narrow: the next review will find the next case.
2. Write at least 3 variants of that rule being broken (the reported case plus other ways it can break), each as a test that fails before your fix.
3. Find every other place in the code that breaks the same rule mechanically (grep, AST, call graph), not just the line cited, and fix them all.

Answer every finding in `fixes`: FIXED (with `where`, the file:line of your fix, plus `rule` and `variants`), or DISPUTED with your reason (that stops the loop and goes to the owner). WONTFIX is only allowed for NIT.

### F1 · BLOCKER · src/serve.mjs:8-9 · from codex + grok
**Decoded traversal escapes the public directory**

path.join normalizes attacker-controlled '..' segments without enforcing containment. Verified: resolvePublic('/srv/site', '/../secret.txt') returns '/srv/site/secret.txt'; encoded traversal also escapes after decoding. If the returned path is served as intended, requests can expose files outside public/, including application secrets.

Reviewer's recommendation: Resolve against an absolute public base and reject candidates whose path.relative(base, candidate) is '..', starts with '..' plus the platform separator, or is absolute. Add regression tests for literal and percent-encoded traversal.
### F2 · CHANGES · src/serve.mjs:8 · from grok
**Malformed percent-encoding throws out of the resolver**

decodeURIComponent(requestPath) throws URIError on truncated or invalid escapes such as % or %ZZ. The function does not catch that, and nothing in this change shows a caller that does. A single crafted request path therefore fails the request synchronously; if the HTTP handler does not catch it, Node treats it as an uncaught exception and can take down the process. That is attacker-controlled input on the path this function is meant to map.

Reviewer's recommendation: Catch URIError and treat it as a bad request (reject the path, do not throw). Add a test that resolvePublic("%") does not throw and does not return a usable path.

## Your result
When you are done, write this JSON to `<repo>/.crossfire/runs/fix-traversal/build-r2-fix.json` (exactly this shape; `fixes` must answer F1, F2):

```json
{
  "status": "DONE",
  "summary": "one or two sentences: what changed and why",
  "commit": "<full sha of HEAD after your final commit>",
  "tests": [
    {
      "name": "test_name_as_in_the_tree",
      "command": "how to run it",
      "passed": true
    }
  ],
  "fixes": [
    {
      "id": "F1",
      "status": "FIXED",
      "note": "what you changed",
      "where": "path/to/file.ext:120 (file:line of the fix; several separated by commas)",
      "rule": "the broadest rule that still holds, e.g. 'a post-commit decision reads committed state, never the in-memory object'",
      "variants": [
        {
          "scenario": "the reported case",
          "test": "test name in the tree"
        },
        {
          "scenario": "another way the same rule breaks",
          "test": "test name"
        },
        {
          "scenario": "a third way",
          "test": "test name"
        }
      ]
    },
    {
      "id": "F2",
      "status": "FIXED",
      "note": "what you changed",
      "where": "path/to/file.ext:120 (file:line of the fix; several separated by commas)",
      "rule": "the broadest rule that still holds, e.g. 'a post-commit decision reads committed state, never the in-memory object'",
      "variants": [
        {
          "scenario": "the reported case",
          "test": "test name in the tree"
        },
        {
          "scenario": "another way the same rule breaks",
          "test": "test name"
        },
        {
          "scenario": "a third way",
          "test": "test name"
        }
      ]
    }
  ]
}
```

`status` is DONE when the work is complete and committed, PARTIAL or FAILED otherwise (both stop the loop and go to the owner). Then reply with one line: the path of the result file.
