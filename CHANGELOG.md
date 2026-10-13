# Changelog

## 1.1.0

From the first outside review.

- **Evidence in every SHIP and ESCALATE report:** the proof commands crossfire ran itself and their exit codes, the tests the builder named, what the breaker proved and how it was answered, what the reviewers read, and what crossfire did not verify (the full suite, lint, migrations, deploys: CI on the pull request is that gate).
- **file:line everywhere:** a FIXED BLOCKER or CHANGES finding needs `where` (the file:line of the fix), and a proven breaker attack needs its `file` and `line`; the referee refuses results without them.
- **"Still open" needs the reviewer's tag.** On a re-check, an earlier finding is still open only when a reviewer re-flags it with its `[Pn]` tag. An untagged finding near an earlier one is reported as new, "near Pn", and that earlier finding as unclear: never guessed fixed or open (it was a known issue).
- **Skill descriptions start with their trigger phrases,** so Claude routes to the right skill.

## 1.0.1

Public-repository hygiene, from the first outside review.

- README: what leaves your machine, what crossfire will never do, the loop as a numbered list, the plugin-dependencies requirement next to the install command, JARVIS explained; stale private-repository instructions and the old marketplace migration removed.
- One wording for Grok Build's plan requirement in the README, the setup skill and `doctor`.
- SECURITY.md (how to report, what crossfire is trusted with, what leaves your machine), CONTRIBUTING.md, issue and pull-request templates.
- **Fix, found by reviewing these documents against the code:** a breaker that committed (leaving the tree clean) was refused once, then skipped on the second attempt, so review ran on a commit the proof commands never verified. HEAD drift is now refused every time; in a loop, `review` runs only on the commit the proof commands verified, and both `review` and `check` discard their verdicts if the branch moves while the reviewers read it.
- The documents say precisely what is sent where (spec excerpts, earlier findings and the builder's answers reach the reviewers; "kept out of git" is not "never sent"), that Grok also runs on `crossfire check` whenever it is usable, and that the `crossfire` script never pushes or posts while the orchestrator does only when asked.
- A discarded review leaves nothing behind (no review files, no reviewer runs counted toward the pass, no reviewer-health entry), and `crossfire proof` changes the proof commands only while the builder is next, so new commands always run before a review. The documents say plainly that reviewers read the live checkout: crossfire compares HEAD before and after, and cannot see a change that is reverted within the review.

## 1.0.0

First release under `jtomaszon/crossfire`. Same code as 0.7.0, rebranded: the marketplace is now `jtomaszon` (install `crossfire@jtomaszon`), and the history starts fresh here. Versions 0.1.0 to 0.7.0 below were developed privately before this repository existed.

## 0.7.0

- **The watcher wakes on PR comments.** `crossfire watch --pr <n>` also reads the PR's conversation comments, inline review comments and reviews through `gh`, using the watched remote's own repository (never gh's default), and wakes when one needs handling. `--from <login>` (repeatable) limits who can wake it; `--comments off` turns it off; crossfire's own comments (`<!-- crossfire -->` marker) never wake it.
- **At least once, with acknowledgement.** A comment is saved as pending before it is printed, and is shown again on every run until the session acknowledges it (`--ack <ID>`, `--ack all`; `--ack-only` acknowledges without watching). A crash or a dead consumer never loses a comment. Designed after three crossfire reviews of an exactly-once version kept finding the next edge (restart gaps, startup failures, concurrent watchers, a crash between saving and printing).
- **Pushes are acknowledged too.** The last head the session acknowledged (`--ack head:<sha>`) is persisted; a push is reported until acknowledged, so one that lands while a comment is being handled is never missed.
- **The PR's repository is never guessed:** it comes from the watched remote's URL or `--repo OWNER/NAME`; gh's default repository is never used, and every gh call names the host explicitly.
- **One watcher per PR**, with a stale-lock takeover that two racing watchers cannot both win; the lock is taken before the inbox is read, on every path.
- **gh failures:** no gh, not logged in or not found turn comment watching off and say so; anything else, including HTTP 403 (GitHub rate limits), is retried every poll; comments posted during an outage at start are delivered once gh recovers.
- **A reviewer that could not review** (`needs-attention` with nothing itemised, e.g. its sandbox could not run git) is a failed review: retried, then G1. Never a finding the builder is sent to fix.
- **doctor tests Codex's sandbox** (`codex sandbox -- true`) and marks Codex NOT READY where it cannot run commands; README "Codex and Grok on Linux" explains the Ubuntu AppArmor case and its fix.
- **Grok's review envelope** (JSON inside `result.text` or `result.structuredOutput`) is unwrapped, and reviewers' absolute paths are made repo-relative, so the same place matches across reviewers.
- The review skill posts honest severities (a nit is labelled optional) and marks its own comments.
- Comments are printed in full, never cut, since they are acknowledged as handled.
- Reviewed with crossfire itself: one check on macOS and five on Linux, Codex only (Grok hit its free-tier limit); every finding fixed except the lock-takeover race under a long pause, listed under Known issues in the README.

## 0.6.0

The first round only goes as well as what the builder knows before it starts; in real runs the planning step was skipped.

- **Through superpowers.** The loop always goes brainstorming (its context exploration is the research step) then writing-plans, whose Review Focus lists the likely failure modes; crossfire no longer duplicates them. `init --plan <file>` takes the plan; its Review Focus satisfies the failure-modes check. A committed plan is refused like a committed spec. `crossfire spec` prints the PLAN FILE path.
- **Per-repository memory** in `<git common dir>/crossfire/memory.md` (shared by worktrees, never committed, rules and titles only): when a loop ends, each real finding is recorded with the broadest rule the builder named; checks record what they reported. Builder and breaker briefs include it, `crossfire spec` shows it, `crossfire memory` prints it.
- Proof commands run only what the change touches; the full suite is CI's job.
- The review skill reads the PR conversation and the repository's memory before asking the reviewers.

## 0.5.0

- **Watch a PR.** `crossfire watch --pr <n>` (or `--branch`) waits until the PR's head moves, or the PR is merged or closed (when `gh` is available), then exits; it polls `git ls-remote`, so it works without a GitHub login. `/crossfire:review` offers it after a review with findings and re-checks on every push until the review approves, the PR closes, or the user stops it.
- **Re-check with a delta.** `crossfire check --since <earlier check>` gives the reviewers the earlier findings tagged P1..Pn and reports which were fixed, which are still open (re-flagged or at the same place) and what is new, on screen and in the report.

## 0.4.0

- **Review without building.** `crossfire check` reviews the current branch once with Codex (and Grok when it can run): no spec, no builder, no loop; findings and a report in `.crossfire/checks/<id>/`. `crossfire checks` lists them. The new `crossfire:review` skill (`/crossfire:review <PR>`) checks a PR out into its own worktree, runs the check and reports; it never posts to GitHub unless asked.
- **`init --from-check <id>`** starts a loop at the fix round with a check's findings, so fixing a reviewed PR no longer begins with a builder round that re-verifies existing work. The check counts as the first review pass; a check older than the branch's HEAD, or one that approved, is refused.

## 0.3.0

Aim: make the cross-vendor review a formality. In the first real loops, every Codex finding was the same class of bug (transaction and rollback semantics) that the spec never asked about and the builder never looked for; fixes then peeled one layer per round.

- **Breaker.** Before every review pass, a cold `crossfire:breaker` subagent attacks the round by category and proves each attack with a failing test in a throwaway worktree (never the branch). Proven attacks get one harden round, which does not use up a round; disputes go to the reviewers to judge, never escalate. `crossfire attacked` records it; `--breaker off` disables it.
- **Failure modes in the spec.** `init` requires a "How this could fail" section with at least 3 items (`--no-failure-modes` for trivial changes); the template lists the categories.
- **Depth rules in every builder brief:** read whole files, callers and the repository's docs for the area before editing; inside a round, depth beats brevity guidance meant for the main session.
- **Broadest rule, tested variants.** A FIXED BLOCKER or CHANGES finding must name the broadest rule the fix enforces and at least 3 tested variants of it; the referee refuses a result without them.
- Reports show the first review pass outcome and the breaker's passes and proven attacks.

## 0.2.0

From the first real loops (three loops on one PR, 2026-10-09).

- **Reviewer visibility.** Every SHIP and ESCALATE output and report has a `REVIEWERS:` line (e.g. `codex 2/2 passes, grok 0/2 passes (failed: ...)`), and a pass where an optional reviewer did not review prints a WARNING. Before, Grok failed every pass on a Mac and nothing in the reports said so.
- **Reviewer health per machine** (`~/.local/state/crossfire/reviewers.json`, outside every repo; one-line errors only, no code or findings). `doctor` marks a reviewer not ready when its last reviews on this machine all failed, and on macOS warns when Grok has never completed a review and `/var/run/docker.sock` is a symlink (Docker Desktop, OrbStack), the setup where its sandbox refused to start.
- **Proof preflight.** `init` runs every proof command once and refuses one that cannot run in this environment (missing binary, wrong toolchain); failing because the feature is not built yet is fine. `--no-preflight` skips it.
- **Environment failures cost no round.** When a proof command fails because it cannot run (e.g. `Could not find 'bundler' ... required by your Gemfile.lock`), `built` exits 5 with PROOF ENVIRONMENT and nothing advances; before, the builder was sent back for a round it could not fix.
- **`crossfire proof --slug <s> --e2e ... --invariant ...`** replaces the proof commands of a running loop, so a wrong command no longer needs `init --force` (which discarded the loop's history).

## 0.1.4

- Grok in sessions whose PATH lacks the Grok installer's directories (sessions started by a desktop app or a daemon): crossfire sets `GROK_BINARY` to `~/.grok/bin/grok` (or `~/.local/bin/grok`) for xAI's plugin when `grok` is not on PATH. An explicit `GROK_BINARY` always wins.

## 0.1.3

- Working with superpowers: the loop skill tells superpowers that the execution method is crossfire (no subagent-driven-development, executing-plans or requesting-code-review in the loop) and keeps its design doc, plan and spec out of git (superpowers' brainstorming commits them by default, which `crossfire init` refuses). The builder agent uses superpowers' TDD, debugging and verification skills only. After SHIP, finishing-a-development-branch is the suggested way to integrate.

## 0.1.2

- `doctor` on Linux tries a real bubblewrap sandbox instead of only looking for `bwrap`, so a host where AppArmor blocks it (Ubuntu 23.10+) shows Grok as not usable, with the reason.
- README: "Grok on Linux".

## 0.1.1

Fixes from the first live run on a real host (Codex and Grok Build, 2026-10-09).

- `crossfire spec --slug <s>`: sets up the git ignore rule and prints where to write the spec, before it is written. Before, a spec written before `init` could be committed with the change and reviewed as code.
- `init` refuses a spec that is committed on the branch.
- `doctor` on Linux: Grok Build counts as usable only when bubblewrap (`bwrap`) is installed; its read-only review sandbox refuses to start without it.
- `doctor`: a reviewer that is installed but not logged in shows only the vendor's next steps, not the install commands again.
- A failed reviewer is reported by its own one-line error instead of the raw payload.

## 0.1.0

First version.

- `crossfire` referee CLI (`init`, `built`, `review`, `status`, `report`, `doctor`) with gates G0 to G7, ported from the JARVIS build loop.
- Reviewers: OpenAI's official Codex plugin is required and reviews every pass (`adversarial-review`, read-only); xAI's official Grok Build plugin adds a second review when installed (`critique`, read-only). Plugins from any other marketplace are refused.
- `loop` skill (orchestrator), `setup` skill (readiness), `builder` agent, spec template.
- Depends on `codex@openai-codex` and `superpowers@claude-plugins-official`.
