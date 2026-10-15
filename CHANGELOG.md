# Changelog

## 1.5.0

Loops that cannot step on each other. Two loops in one checkout committed to the same branch and each loop's reviewers saw the other's commits.

- **One active loop per checkout.** `crossfire init` refuses, changing nothing, while a loop with another slug is active in the checkout. It names that loop and how long ago its last step was, and prints the commands to start the new loop in a worktree of its own, runnable as printed: `git worktree add ../<repo>-<slug> <slug>` (or `-b <slug> <base>` when there is no such branch), `mkdir -p` and `cp` of `.crossfire/specs/<slug>.*` into it, then `cd` and the init line pointing at the copies. With `--from-check`, it says the check belongs to this checkout. The decision and the new loop's state are made under one checkout-wide lock, `.crossfire/runs/.init.lock`. There is no flag to skip it.
- **`init --force` keeps recorded work.** It archives and restarts only a loop that finished or has recorded nothing since its init (a bare or `--from-check` init); a loop with recorded steps is refused with the worktree commands.
- **`crossfire abandon --slug <slug>`:** the person ends a loop that looks stuck (active, no crossfire command holding its lock, no step for 3 hours). It re-checks under the loop's lock and escalates at gate `ABANDONED` with the reason `no step since <time> (<N> h <M> min ago); abandoned by the person`. Nothing ends a loop automatically.
- **Locks held while their process is alive.** A loop's lock and the init lock are files created exclusively with `<pid> <hostname>` and the time. A lock is held while its process is alive on this host, however old it is: a long `built` or `review` never loses its lock, so `abandon` cannot run under it. The init lock waits up to 10 seconds for a live holder. Nothing takes a lock over: a lock whose process is gone (or written on another host, or unreadable) is refused with a message naming the file, its contents, its age and the command to clear it.
- **`crossfire unlock --slug <slug>` and `crossfire unlock --init`:** the person removes a lock left by a crossfire process on this host that is gone; it prints what it removed and refuses (changing nothing) a lock whose process runs, one from another host or one it cannot read that is under 60 seconds old.
- **One unlock at a time, locks never empty, health advisory.** Each unlock holds `.crossfire/runs/.unlock.lock` and refuses, changing nothing, while another unlock holds it; a marker left by a crashed unlock is named (file, process, age) and only a person deletes it. Locks are created with their contents already in them (a temporary file linked into place), and an unreadable lock older than 60 seconds can be removed with `unlock`. A malformed reviewer health file is read as if its invalid entries were not there, so it never aborts doctor, spec-review, check or a loop step.
- The memory file, the reviewer health file and the precedents file keep their 1.4.0 behaviour, with no lock: concurrent updates to them from loops running at the same moment are best effort.

## 1.4.0

Prove the spec, code once. Measured on 26 real loops and 8 checks: the first review pass found 74% of all findings and pass 3 or later found none; Grok found findings no one else did where its sandbox works, and on a host where it fails, crossfire kept calling it; the breaker overlapped the reviewers most of the time, at about 6 minutes a round. So the cross-vendor attack moves to the cheapest point, the spec before any code exists, and the code reviews after it get lean.

- **`crossfire spec-review --slug <slug> --spec <file> [--plan <file>]`: prove the spec before any code.** Codex (and Grok) review the spec and plan as a design against the repository's current code, with a focus of their own: gaps, contradictions, untestable or ambiguous acceptance criteria, missing failure modes, conflicts with the code the spec names, and cheaper ways to the same goal; high, medium and low mean a wrong build or a hole, a round lost to ambiguity, and wording. Crossfire commits the spec and plan at `crossfire-spec-review/<slug>.md` on a throwaway branch in a throwaway worktree on the base, so the reviewers read them as a diff, and removes both afterwards, also when a reviewer fails or times out; the user's branch, working tree and index are never touched. Saved as `.crossfire/specs/<slug>.review.json` (findings, reviewers, when, base commit, sha256 of the spec and plan) and `.review.md`. The loop skill runs it once after drafting, revises the spec, writes `<slug>.review-response.md` (one line per finding) and shows the person the revised spec with the findings and responses at the one approval stop.
- **`init` says whether the spec is the one reviewed:** `SPEC REVIEW: current`, `revised after review` (changed, with a response file newer than the review), `stale` (changed with no response) or `none`, recorded in the loop state and the report. It never blocks.
- **Lean code reviews, only after a current spec review.** With `current` or `revised after review`: `--grok auto` runs Grok on the first code review pass only (with `--from-check`, the first pass crossfire runs) and prints `grok: not run on pass N (auto: first code pass only)` after it; the breaker is off unless the spec has a `**Risk:** high` line or `--breaker on`; `--max-rounds` defaults to 2. With `stale` or `none`, init warns and keeps the 1.3 defaults (Grok every pass, breaker on, 3 rounds). Flags always win. New loops store `policy: 2` and the settings they decided; a loop started on 1.3 keeps its own, including Grok on every pass.
- **`--max-rounds` counts the builder legs crossfire runs:** in a `--from-check` loop the pull request's own code is not one, so a red proof run on the first fix of a 2-round loop goes back to the builder instead of escalating with no review.
- **Grok on a broken host is skipped:** under `--grok auto`, when its last 3 attempts on this machine failed and the latest is under 7 days old, crossfire skips it without calling it (`grok: skipped (...)`) in spec reviews, checks and loop reviews. `--grok on` still calls it; a success resets the count.
- **Tests are not weakened:** Existing test files are not changed unless the spec allows it; add new tests in new files. `built` refuses, as malformed, a round whose commits since the head the loop started from (recorded at `init`; with rename detection) delete an existing test file (one present when the loop started), rename it to a name that is not a test file, or change any line in it, or add a skip or focus call (`.skip(`, `.only(`, `xit(`, `xdescribe(`, `@pytest.mark.skip`, `@unittest.skip`, `@Disabled`, `t.Skip(`) in a new test file, listing each file and line, unless the `## Allowed test changes` section of the spec as approved at `init` names the file. A test file is known by its name: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*.py`, or under `__tests__/`; helpers and fixtures are not test files. Only the loop's own builder commits are judged: a `--from-check` pull request's commits, or commits on the branch before `init`, are not, and a branch that no longer descends from the start head fails closed. The guard applies only to loops started on 1.4 (`policy: 2`); a loop started on 1.3 keeps the 1.3 rules. `init` keeps a snapshot of the spec (with its sha256): the exemptions and the reviewers' copy of the spec come from it, never from a later edit of the spec file. Renames with no content change and `{ skip: <condition> }` options pass. The check runs on every builder result, whatever its status (DONE, PARTIAL, FAILED or SPEC_MISMATCH). The snapshot's sha256 is also kept outside the run directory (in the git common dir); a missing or changed record fails closed. For a renamed test file, the section must name its old path; naming only the new path does not exempt the rename. `spec-review` refuses a base that already has a `crossfire-spec-review` path (a symlink, file or directory), so it never writes through one.
- **`SPEC_MISMATCH`:** a builder that finds the spec cannot be built as written stops with a structured handoff (severity, summary, tried, situation, synthesis). No proof command runs, the ledger does not change, and the loop escalates at the new gate `SPEC` (checked before the generic BUILDER one), on any round, with the handoff in the report and the suggestion to revise the spec (`crossfire respec`). A missing or invalid handoff is malformed.
- **Precedents:** `crossfire precedent add "<ruling>"` records the owner's ruling as a dated line in `<git common dir>/crossfire/precedents.md`; builder and breaker briefs and every reviewer's focus (loop, check and spec review) carry the latest 30 under "Settled by the owner; do not raise these again". The loop skill adds one only on the person's explicit words. `crossfire precedents` lists them.
- **Size warning:** a review pass (or check) on a diff over about 400 changed lines or 10 files, lockfiles excluded, prints `WARNING: this change is <N> lines in <M> files; past about 400 lines or 10 files, split it` and notes it in the report. It does not block.
- **Spec template:** requirements each with an owner and the one to drop first, a "What we're deleting" section, a `**Risk:**` line (high turns the breaker on), and an optional "Allowed test changes" section.
- `spec-review` writes its review documents without following symlinks (it refuses a symlinked `.crossfire` or `.crossfire/specs`, and replaces files instead of writing through them). A concurrent local process racing it is listed under Known issues.
- The old-version warning fires only when the session runs an older crossfire than the installed one, not for a newer development build.
- Nothing else is removed: `respec`, `watch` and `ladder` stay.

## 1.3.0

From running many loops in parallel.

- **Loops inside subagents no longer wait forever.** The loop skill dispatches builders and breakers with an explicit `run_in_background: false` (the Agent tool defaults to the background, and a background agent's completion notice can go to someone else), never resumes a builder with SendMessage, and runs reviews in the background with their output in a fresh file per review (`mktemp`) that it then waits for in the foreground (a timeout repeats only the wait, never the review), instead of ending its turn to wait for a notification. The review skill does the same for `crossfire check`.
- **`STALLED` in `crossfire status`:** when a builder or breaker wrote its result and nobody ran `built` or `attacked`, `status` (one loop, or every loop in the repository) says so, with how long ago and the command to run.
- **`crossfire respec --from-loop <slug> --slug <new-slug>`: start over from a rewritten spec.** It drafts a new spec from a finished loop's spec, with every finding (and the breaker's proven attacks) as a known failure mode the new loop must test from the start, each with its full evidence (the scenario, failing test or reviewer's text, and what defeated the last fix when a reviewer re-flagged it), plus a "Starting over" section: start from the base, not the old branch, and simplify where the failures cluster. It writes only the draft; no branch, loop or commit. Escalation reports say "Consider starting over" with the evidence when findings cluster in one file across passes, a fix is re-flagged, a new blocker appears after the first fixes (G5) or the round cap is hit (G2).
- **At most one new loop per escalation, always** (a fix loop or a respec); if it escalates too, stop and wait for the person. This was the unattended-only rule.
- **`--max-rounds` defaults to 3** (was 5): most loops finish within two review passes, and the ones that do not are usually better started over.
- **`init` says a loop needs 2 concurrent agents**, and warns when there are more than 6 proof commands or their first run takes over 5 minutes, since they run every round. The spec template asks what each proof command proves.
- **G6 (time budget) says how long finished results sat unrecorded**: `built` and `attacked` log when a builder or breaker result waited 5 minutes or more before anyone recorded it, so a stalled agent is not mistaken for slow work.
- README: "Before running many loops" (agents, merging, proof commands, liveness, starting over); the loop skill has the same as "Running several loops at once".

## 1.2.1

- **`crossfire ladder` reads CI for the commit itself**, not for the PR number: the check runs and commit statuses of the PR head it validated (`gh api repos/.../commits/<sha>/check-runs` and `/status`), so CI can no longer be attributed to a different head. This removes the known issue listed in 1.2.0.
- **The PR's head is read before and after CI.** CI is reported only when the PR, read back, still has that head (otherwise unknown, and `--json` gives `headNow`). If the head moves while the ladder reads it, the PR line and the CI line say so, and nothing read for the old head is reported as current.
- **Unknown, not a tally:** a list shorter than GitHub's own count, a PR with 100 or more checks, and an outcome or check status crossfire does not know.
- **Pending:** required checks that have not reported yet, check runs GitHub has queued but not created, and a rerun queued over a finished check of the same name.
- Check runs and commit statuses that share a name are kept apart.

## 1.2.0

From reading real loops on a second machine, with the owner's decisions.

- **`crossfire ladder --slug <slug>`**, after SHIP: is the branch pushed, is there a PR (and is its head exactly the shipped commit, or are there unreviewed commits on top), what does CI say on that head, did it merge into the loop's base. Facts only: it never pushes, merges, posts or recommends an action. It reads (`git ls-remote`, `gh pr list`, `gh pr checks`, `gh pr view`) the watched remote's own repository (`--repo` only when the remote is not a GitHub address). Anything it cannot establish (gh failing, a commit this clone does not have or a shallow clone, a PR head that moved while it was reading) is printed as unknown. Same-repository PRs only; a merged PR stays merged after GitHub deletes the branch. It stops at merged: checking that the change works where it runs stays a person's job. (A first version also suggested the next step; crossfire's review showed every edge case turned into a wrong instruction, so it was removed.) Merged means merged into the loop's base (`origin/main`, `upstream/main` and `main` are the same base), decided across every PR on the branch including fork PRs, and unknown when a merged PR's head is not in this clone or the PR list was truncated. A loop without a recorded branch (started before 1.2.0) needs `--branch`.
- **G6 (time budget) is checked only before a new builder leg.** A finished fix always gets its review pass, an approval ships even over budget, and over budget the breaker leg is skipped (logged) rather than leaving the fix unreviewed. Before, the budget could run out right after a fix was built, before anyone reviewed it.
- **Escalations belong to the person who asked for the change.** The loop skill tells coordinators and subagents to report an escalation up and wait. With "run unattended", any further code goes through a new loop, at most one new loop per escalation, and a branch whose loop escalated with findings open or unreviewed is never pushed, merged or PR'd. The escalation report carries the same limits.
- **The report says when the breaker was skipped or failed** (`Breaker: 1 pass(es) completed, 1 skipped`): a skipped or failed breaker leg was counted as a clean pass with 0 attacks. Found by crossfire's review of 1.1.1.
- **`doctor` and `init` warn when the session runs an older crossfire than the installed one**, and suggest `/reload-plugins`. Long sessions kept running versions several releases old.

## 1.1.1

Documentation, from the first outside review.

- `docs/workflow.md`: the habits around the loop: one small PR per change, SHIP is not done (the ladder to live and verified), CI is the gate and the loop is the proof, commit messages that explain why, rollback and runbooks in every spec, worktree hygiene, lessons in memory, name the rule.
- `docs/example/`: a complete real run on crossfire 1.1.0 (review a PR, spec and plan, a loop started from the review, builder, breaker, both reviewers approve, SHIP), every artifact included.
- The spec template asks for a **Rollback** and a **Runbook and docs** section, and its Out of bounds lists destructive git, data, secrets and network.

## 1.1.0

From the first outside review.

- **Evidence in every SHIP and ESCALATE report:** the proof commands crossfire ran itself and their exit codes, the tests the builder named, what the breaker proved and how it was answered, what the reviewers read, and what crossfire did not verify (the full suite, lint, migrations, deploys: CI on the pull request is that gate).
- **file:line everywhere:** a FIXED BLOCKER or CHANGES finding needs `where` (the file:line of the fix), and a proven breaker attack needs its `file` and `line`; the referee refuses results without them.
- **"Still open" needs the reviewer's tag.** On a re-check, an earlier finding is still open only when a reviewer re-flags it with its `[Pn]` tag. An untagged finding near an earlier one is reported as new, "near Pn", and that earlier finding as unclear: never guessed fixed or open (it was a known issue).
- **Skill descriptions start with their trigger phrases,** so Claude routes to the right skill.
- `where` accepts line ranges (`src/serve.mjs:15-20`) and lists (`a.mjs:3, b.mjs:9`); a pre-release refused ranges.
- The timeline records a review pass when the reviewers finish, not when they start.

Found by reading real loops on a second machine:

- **Fix: a G6 (time budget) escalation right after the breaker dropped its proven attacks,** and the report said "Nothing else is open". The attacks are now recorded before the budget is checked.
- Escalation reports list findings the builder claimed fixed that no reviewer re-checked ("Claimed fixed by the builder, not re-reviewed").
- `REVIEWERS: codex 1/1 passes (last verdict: needs-attention)`: "1/1 passes" counts reviews that ran, and was being read as "approved".
- `crossfire --version` works (it failed with "--version needs a value").

From crossfire's review of this release (Codex + Grok):

- Re-check: every earlier finding near an untagged new one is unclear, whatever the severity (only the first was, so a second one nearby could be called fixed); a `[Pn]` tag counts only at the start of a title.
- Escalation reports separate what is still open, fixes a reviewer re-flagged (G3/G4), fixes no reviewer has seen yet, and disputes no reviewer settled. The finding behind a G4 is recorded as open.
- The breaker line counts the builder's answers (FIXED, DISPUTED) and says whether a review ran after them, instead of calling every closed attack "hardened".
- `where` must use lines from 1 with ranges in order, is kept on the finding, shown to the reviewers next pass ("FIXED at a.js:10") and in the report's findings table.
- An odd `variants` value on a DISPUTED answer no longer crashes `built`.
- Second review: when two reviewers report the same place, every reviewer's tag counts (a merged finding kept only one title). A finding at the place of several claimed fixes keeps all of them open (only one was, the rest were closed as accepted), and on a re-check a tagged re-flag keeps its neighbours unclear. Breaker answers are counted as reviewed or not one by one. Claimed fixes in loops started before 1.1.0 are listed as not re-reviewed. The builder brief's `where` example passes the `where` check.
- Third review: a finding a reviewer re-flags after it was closed is reopened, and the reviewer's new title and text reach the escalation report (the report said "Nothing else is open"). A merged finding counts at every reviewer's location. A builder answer changed after a review is not counted as reviewed.

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
