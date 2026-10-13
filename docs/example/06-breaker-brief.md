# Crossfire breaker brief: fix-traversal, round 2

You are the **breaker**. A builder just finished this round and its proof commands pass. Independent reviewers from another vendor will review the branch next. Your job is to find what they would find, first: **assume the change is wrong and prove it.**

## What to read
- The spec: `<repo>/.crossfire/specs/fix-traversal.md` (its acceptance criteria and its "How this could fail" section).
- The change: `git diff 3ebb6a717bfd3522a8b802b69a68783e206c98f7...HEAD` in `<repo>` (branch `feature/resolve-public`, HEAD `a5445d8ddfe6ee788f71d2a7e2fc5708113ee66c`). Read every changed file in full, and the code it calls and that calls it.
- The plan: `<repo>/.crossfire/specs/fix-traversal.plan.md` (its Review Focus lists the failure modes the planner expected).
- Do not read the builder's notes or result files: review the code cold.

## What reviewers found in this repository before
Earlier loops and reviews here found these kinds of problems. Check whether this change could have any of them, and test for the ones that apply:
- 2026-10-13 · BLOCKER · src/serve.mjs · Decoded traversal escapes the public directory (codex+grok, reported in check pr-1)
- 2026-10-13 · CHANGES · src/serve.mjs · Malformed percent-encoding throws out of the resolver (grok, reported in check pr-1)

## How to attack
Go through each category and try to construct a concrete scenario where the change does the wrong thing:
- transactions, rollback and nested transactions (savepoints), callbacks that run after commit or rollback
- stale in-memory state: objects, caches or flags that do not match what was committed
- concurrency: two requests, jobs or processes at once; races between check and act
- retries and idempotency: the same job, webhook or request twice; partial failure halfway
- ordering: events, callbacks or jobs arriving in a different order, or not at all
- missing or unexpected data: nil, empty, deleted, archived, very large, other tenants
- the boundaries the spec names: limits, permissions, time, money, external services failing

**Prove every attack with a failing test, and never change the branch:**
1. Make a throwaway worktree: `git -C <repo> worktree add --detach "$(mktemp -d)/crossfire-breaker" HEAD`.
2. Write the test there, with the repository's own test framework and conventions, and run it. It must fail because of the bug, not because of a typo or setup.
3. Remove the worktree when done (`git worktree remove --force <path>`). Leave the real working tree exactly as you found it: no edits, no commits, no stashes.

Report only attacks you proved with a failing test, each with the `file` and `line` the bug is at. Ideas you could not prove go in `summary`, one line each. One proven, real bug beats ten guesses.

## Already found by the reviewers in earlier passes (do not report these again)
- [F1] Decoded traversal escapes the public directory (claimed_fixed)
- [F2] Malformed percent-encoding throws out of the resolver (claimed_fixed)

## Your result
Write this JSON to `<repo>/.crossfire/runs/fix-traversal/breaker-r2.json`, then reply with that path:

```json
{
  "status": "DONE",
  "summary": "what you tried, and unproven ideas (one line each)",
  "attacks": [
    {
      "title": "short statement of the bug",
      "category": "transactions",
      "severity": "BLOCKER or CHANGES",
      "file": "path/to/file",
      "line": 120,
      "scenario": "the exact sequence that breaks it",
      "rule": "the broadest rule the code breaks",
      "test": "the test you wrote: its name and its code",
      "command": "how you ran it",
      "output": "the failing output (last lines)",
      "proven": true
    }
  ]
}
```

`attacks` is empty when you could not break it. `status` is FAILED only if you could not do the job at all (say why in `summary`).
