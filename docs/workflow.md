# Working with crossfire: the habits around the loop

Crossfire proves a change. These are the delivery habits that make that proof worth something; most of them come from operating systems in production, where "done" means live and observed.

## One change, one branch, one worktree, one small PR

Give every change its own slug, branch and worktree (`superpowers:using-git-worktrees`, or `git worktree add ../<repo>-<slug> -b <slug> origin/main`). Keep it small: roughly 400 changed lines or 10 files at most, lockfiles not counted. A bigger change is several changes; split it and run a loop for each. Small changes get short reviews, and the reviewers find real problems instead of drowning in a large diff.

## SHIP is not done

SHIP means the loop passed the gates it was configured with, locally: the proof commands, Codex's review, and Grok's and the breaker's when they ran (Grok is optional and a loop continues on Codex alone if it fails; the breaker can be off or skipped; after a nit pass, G7 ships the nit fixes without another review). Before saying which checks passed, read the report's Reviewers line (how many passes each reviewer completed, its last verdict when it was not an approval, and its latest error; not which pass it missed), its Evidence section, and its timeline: a reviewer that missed a pass shows there as `reviewer-failed:<name>` next to that pass's `review-recorded` line, and the Breaker line counts legs completed, skipped (malformed twice, or the time budget) and failed, with `breaker-skipped` and `breaker-failed` in the timeline saying why. A change is done further up the ladder:

1. **SHIP**: crossfire's loop passed.
2. **Pushed**: the branch is on the remote (a person pushes; crossfire never does).
3. **PR open**: with the crossfire report's summary in it.
4. **CI green**: the full suite, lint and integration checks pass on the PR.
5. **Merged**.
6. **Live and verified**: deployed, and checked where it runs.

`superpowers:finishing-a-development-branch` takes you from SHIP to a PR. `crossfire ladder --slug <slug>` reads rungs 2 to 5 (pushed, PR, CI, merged) and names the next step for a person; it never pushes, merges or posts, and rung 6 stays a person's check. Never report a change as done at a lower rung than the one it reached.

## CI is the gate; the loop is the proof

Proof commands (`--e2e`, `--invariant`) run only what the change touches: the specs for the changed code and the new tests. They run every round, so they must be fast. The full suite belongs to CI on the pull request: only CI may say "the repository is fine". Crossfire's report says so in its Evidence block.

## Commit messages explain why

```
<area>: <what changed>

<why: the finding, acceptance criterion or incident it closes, and anything
deliberately not changed>
```

This is a habit for the people who squash or edit the loop's commits before the PR; crossfire does not give the builder this template or check its messages, so a builder's commit message is whatever it wrote. A reviewer reading `git log` six months later should understand the change without the loop's files.

## Every spec says how to undo it

The spec template has a **Rollback** section: a feature flag, a plain revert, a revert-safe migration, a reversible backfill. If a change cannot be undone cleanly, the owner decides that before the loop starts, not after it ships.

## Runbooks change with the code

If the change touches something people operate, the spec names the runbook or doc that must change, and the builder updates it in the same change. A deploy whose runbook is out of date is not done.

## Worktree hygiene

- Loop state lives in each worktree's `.crossfire/` (git ignores it); the repository's memory lives once, in `<git common dir>/crossfire/memory.md` (`git rev-parse --git-common-dir`), shared by all worktrees. In a linked worktree `.git` is a file pointing elsewhere, so the memory is not under that worktree; `crossfire memory` prints it from anywhere.
- `git worktree list` shows them; remove a finished one with `git worktree remove <path>`, and `git worktree prune` cleans up after ones deleted by hand.
- One loop per worktree at a time; several loops at once need several worktrees.

## Lessons go to memory, not to skills

When a loop teaches something about a repository ("transactions with savepoints keep biting here"), crossfire records it in that repository's memory automatically, and the next builder and breaker read it. Skills describe procedures and change rarely and deliberately.

## Name the rule, fix every place

The single most useful instruction in crossfire: a finding is evidence of a rule being broken. Name the broadest rule that still holds, find every place that breaks it, fix them all, and test at least three variants. A fix that only covers the cited line invites the next review to find the next line.

## Stop early, never guess

The referee is allowed to stop the loop early; it is not allowed to guess. When something is ambiguous (a disputed finding, a fix that keeps coming back, a new blocker late in the loop, a budget spent), it escalates to a person with the options.
