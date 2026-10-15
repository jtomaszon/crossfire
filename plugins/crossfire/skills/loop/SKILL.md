---
name: loop
description: Use when the user says "crossfire", "run it through review", "build-review loop", or asks for any non-trivial code change that should be independently reviewed before it merges. Spec-first: the cross-vendor reviewers (OpenAI Codex required, xAI Grok Build optional) review the spec before any code, then build -> review -> fix loop, with a referee script deciding every step until SHIP or ESCALATE.
argument-hint: "[what to build, or a path to an existing spec]"
---

# Crossfire loop

To review an existing PR or branch without building anything, use the `crossfire:review` skill instead; it can hand its findings to this loop afterwards (`init --from-check`), starting at the fix round.

You are the **orchestrator**. A referee script (`crossfire`) owns every decision about what happens next; your job is to carry messages between it, the builder subagent and the user. You never decide the next step yourself, and you never edit code during the loop: the builder does.

`crossfire` is on your PATH while this plugin is enabled. If it is not, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/crossfire.mjs"` in its place.

## 0. Check the reviewers

Run `crossfire doctor`. If it says **NOT READY**, stop: show the user its output (it lists the exact install and login commands) and tell them to run `/crossfire:setup` once they have done it. Codex is required; never start a loop without it. Grok Build missing is only a warning.

## 1. Context, spec and plan (through superpowers)

The first round only goes as well as what the builder knows before it starts. In real runs the builder started cold because this step was skipped. Do not skip it, also not when the change is a fix to an existing PR.

1. **`crossfire spec --slug <slug>`** (`<slug>`: short, lowercase, hyphens). It makes git ignore `.crossfire/`, prints the SPEC FILE and PLAN FILE paths, and prints this repository's **MEMORY**: kinds of problems reviewers found here before. Keep that list in front of you for the next steps.
2. **superpowers:brainstorming**, always (its short "bounded" path for a small change). Its first step, exploring the project context, is the research step: the repository's CLAUDE.md or AGENTS.md topic map and the docs it points to for this area, how the code already solves similar problems, the callers of what will change, recent commits. For someone else's PR, also read the PR description and every earlier review comment (`gh pr view <n> --comments`), and what the author already tried.
3. **superpowers:writing-plans**. Its plan is written for an engineer with zero context: exact files per task, constraints copied from the spec, and a **Review Focus** section listing the failure modes most likely to bite. Fill Review Focus from the categories reviewers keep finding (transactions and rollback including nested ones, stale in-memory state, concurrency, retries, ordering, missing or unexpected data) and from the MEMORY list; each one needs its test.
4. **Inside a crossfire loop, tell both skills:**
   - Save the design as the SPEC FILE and the plan as the PLAN FILE that `crossfire spec` printed. Not under `docs/superpowers/`, and **never commit them**: reviewers would review them as code, and `crossfire init` refuses a committed spec or plan.
   - The execution method is already supplied: **crossfire**. At writing-plans' execution handoff, do not use superpowers:subagent-driven-development, superpowers:executing-plans or superpowers:requesting-code-review: crossfire's builder implements the plan and Codex (plus Grok) review it.
5. The spec follows [references/spec-template.md](references/spec-template.md): requirements each with an owner and the one to drop first, "What we're deleting", EARS acceptance criteria, numbered E2E tests (the builder may add tests, never weaken these), runnable invariant commands, out-of-bounds files, a `**Risk:**` line (low or high; high turns on the breaker), and **absolute paths** to every document the builder must read. The failure modes live in the plan's Review Focus or in the spec's "How this could fail"; `crossfire init` needs at least 3 in one of them. Only for a genuinely trivial change, pass `--no-failure-modes`. Crossfire's rule: existing test files are not changed unless the spec allows it; add new tests in new files; only if an existing test file must change, an "Allowed test changes" section names it.
6. **Proof commands run only what this change touches:** the specs for the changed code and the new tests, not the full suite. The full suite is CI's job; it runs on the PR.
7. **Prove the spec, once, before any code.** The cheapest place for the cross-vendor attack is the spec, before anything is built:

   ```bash
   crossfire spec-review --slug <slug> --spec <spec path> --plan <plan path> --base <base branch>
   ```

   Run it in the background with its output in a file of its own and wait for that file, as for `RUN_REVIEW` below (it takes minutes). Codex (and Grok, unless it is off or skipped on this machine) review the spec and plan as a design against the repository's current code, in a throwaway worktree; your branch is not touched. Exit 3: the Codex review failed and nothing was saved; run it once more. Then:
   - Revise the spec (and plan) for each finding.
   - Write `.crossfire/specs/<slug>.review-response.md`: one line per finding, how it was addressed or why not.
   - A second spec review only when the user asks.
8. Show the user the revised spec and plan **with the spec review's findings and your responses**, and get a yes before going on, unless they told you to run unattended. This is the one checkpoint at the start; after it, the loop runs on its own.

## 2. Branch and init

- Work on a branch made for this change, never on the base branch. Prefer an isolated worktree (**superpowers:using-git-worktrees** if available); otherwise `git switch -c <slug>` from the base.
- Start the loop, passing every E2E and invariant command from the spec:

```bash
crossfire init --slug <slug> --spec <spec path> --plan <plan path> --base <base branch> \
  --e2e "<command>" --invariant "<command>"
```

Init prints `SPEC REVIEW: current`, `revised after review` (the spec changed and the response file is newer than the review), `stale` (it changed with no recorded response) or `none`. Only with current or revised does the loop use the **lean defaults**; with stale or none it warns and keeps the full ones:

| | lean (current or revised spec review) | full (stale or none) |
|---|---|---|
| Grok (`--grok auto`) | the first code review pass only | every pass |
| Breaker | off; on when the spec says `**Risk:** high` | on |
| `--max-rounds` (default 2 with a current spec review, 3 without) | 2 builder legs | 3 |

Flags always win: `--grok on|off`, `--breaker on|off`, `--max-rounds <n>`, `--max-minutes` (default 45). `--max-rounds` counts the builder legs crossfire runs; with `--from-check`, the pull request's own code is not one of them. Under `--grok auto`, Grok is skipped without being called when its last 3 attempts on this machine failed in the last 7 days (`crossfire doctor` shows why; `--grok on` calls it anyway).

Init first runs every proof command once (preflight). Failing because the feature is not built yet is fine; a command that **cannot run here** (wrong Ruby or Node toolchain, missing binary, version manager not on PATH) stops init with exit 5. Fix the command, usually by using the toolchain the repository's own instructions name, and run init again. Never work around it with `--no-preflight` unless the user says so.

## 3. Follow NEXT ACTION until SHIP or ESCALATE

Every `crossfire` command ends with a `NEXT ACTION`. Do exactly what it says:

**`SEND_BUILDER`**: dispatch the `crossfire:builder` subagent with the Agent tool, `subagent_type: "crossfire:builder"` and **`run_in_background: false`** (always pass it: the Agent tool's default is the background, and a background builder's completion notice can go to someone else, so a loop running inside a subagent would wait forever). Use this prompt, filling in the two paths from crossfire's output:

> Read the brief at `<BRIEF>` and follow it exactly. When you are done, write your result JSON to `<RESULT FILE>` as the brief describes, and reply with that path.

When it returns, run `crossfire built --slug <slug>`. Never resume a builder with SendMessage; dispatch a new one. If the Agent tool refuses the builder (a concurrent-agent limit), do not build it yourself: report up that the loop is blocked on agent capacity, and stop.
- Exit 3 (**MALFORMED**): nothing advanced. Dispatch the builder again with the same prompt plus crossfire's list of problems, then run `crossfire built` again. A second malformed result escalates by itself. This includes a round that weakens tests (existing test files are not changed unless the spec allows it; add new tests in new files; a new test file may not call a skip or focus API) unless the "Allowed test changes" of the spec as approved at init names the file; init keeps a snapshot of the spec, and a later edit of the spec file exempts nothing.
- A builder that finds the spec cannot be built as written returns `SPEC_MISMATCH` with a handoff; `built` runs no proof command and escalates at gate `SPEC` (see ESCALATE).
- Exit 5 with **PROOF ENVIRONMENT**: a proof command cannot run here; this is not the builder's fault and no round was spent. Fix the command with `crossfire proof --slug <slug> --e2e "<cmd>" --invariant "<cmd>"` (give the full new set), then run `crossfire built` again. Never restart the loop with `init --force` for this: that throws away its history.

**`SEND_BREAKER`**: dispatch the `crossfire:breaker` subagent the same way (Agent tool, `subagent_type: "crossfire:breaker"`, `run_in_background: false`) with:

> Read the breaker brief at `<BRIEF>` and follow it exactly. Write your result JSON to `<RESULT FILE>` and reply with that path.

Then run `crossfire attacked --slug <slug>`. Proven attacks go back to the builder as one **harden** round (`SEND_BUILDER (harden)`, handled like any builder round); with none, the next action is the review. Exit 3: re-dispatch the breaker with crossfire's problems (a second bad result skips the breaker; it never blocks the loop).

**`RUN_REVIEW`**: a review takes several minutes, longer than one foreground command may run, so run it in the background with its output in a file of its own, then wait for that file in the foreground. Never end your turn waiting for a completion notification: inside a subagent it may never reach you.

1. Make a fresh output file (foreground): `mktemp "${TMPDIR:-/tmp}/crossfire-review-XXXXXX"`. It prints a path, `<OUT>`; use a new one for every review.
2. Start the review (Bash tool, `run_in_background: true`): `crossfire review --slug <slug> > <OUT> 2>&1; echo "CROSSFIRE-EXIT $?" >> <OUT>`
3. Wait for it (foreground, the Bash tool's longest timeout): `until grep -q CROSSFIRE-EXIT <OUT>; do sleep 20; done; cat <OUT>`. If this times out, run **only this step** again; never start a second review while one runs (crossfire would refuse it: "another crossfire command is running"; that means keep waiting).
4. The last line is the exit code; above it is crossfire's output. `grok: not run on pass N (auto: first code pass only)` or `grok: skipped (...)` is expected, not a failure; mention it in your one-line update.
- Exit 3: the Codex review failed and nothing advanced; run `crossfire review` once more. Exit 5: a reviewer is not usable; show the user the message and stop.

**`SHIP`**: tell the user it shipped, with the report path, a two-line summary (findings fixed, nits accepted), and the `REVIEWERS:` line as crossfire printed it, so the user knows whether Grok actually reviewed or the loop ran on Codex alone. Do not push, merge or open a PR unless the user asks; offer to. If they want to integrate the branch, **superpowers:finishing-a-development-branch** is the right next step. SHIP is not done: whenever the user asks where the change stands (or after they push), run `crossfire ladder --slug <slug>`; it reads whether the branch is pushed, the PR (and whether its head is exactly the shipped commit), its CI and whether it merged into the loop's base, and prints "unknown" for anything it cannot establish. Relay those facts; do not turn them into an action the user did not ask for. It never pushes, merges, posts or recommends; do not poll it in a loop.

**`ESCALATE`**: stop. Show the user the gate, the reason, the `REVIEWERS:` line and the report's "What the owner needs to decide" section, and ask what they want: accept as is, a direction for a new loop on top of this branch, **start over from a rewritten spec**, or drop it. This is a real decision point; never work around it.
- **Gate `SPEC`** (the builder returned `SPEC_MISMATCH`): show the builder's handoff from the report (severity, summary, what it tried, the situation, its synthesis). The usual answer is a revised spec (`crossfire respec`), but the person decides whether the spec or the builder is wrong.
- **Starting over** is the better choice when the report says "Consider starting over" (findings clustering in one place across passes, fixes re-flagged, new blockers after the first fixes): each patch there tends to open the next edge case. `crossfire respec --from-loop <slug> --slug <new-slug>` drafts a new spec from the old one with every finding as a known failure mode the new loop tests from the start. Review and simplify it with the user (this is a spec approval, like the first one), then create a fresh branch from the base and `init` the new loop there; the old branch is a reference and is never merged. Example: a cache change keeps getting new ordering edge cases; the new spec lists them all, and the builder designs for them instead of patching around them.
- **At most one new loop per escalation** (a fix loop on top of the branch, or a respec). If that loop escalates too, stop and wait for the person.
- **The person decides, not an agent.** If you are a coordinator or subagent running loops for someone, report the escalation up and wait; do not choose for them.
- Only if the user said to run unattended may you choose yourself, and then: any further code goes through a **new crossfire loop** (never write, commit, push or merge code outside a loop after an escalation), and never push, merge or open a PR for a branch whose loop escalated with a BLOCKER or CHANGES finding still open or unreviewed.

## Rules while the loop runs

- **Never** edit code, tests or the spec yourself, never edit files under the loop's directory, and never run reviewers any other way. Everything goes through the builder and `crossfire`.
- Valid findings go straight back to the builder: never stop to ask the user whether to fix them. The only stops are SHIP and ESCALATE.
- Stay quiet in between: one short line per round at most ("round 2: Codex found 2 issues, builder fixing"). The user hears about SHIP or ESCALATE.
- If a review prints `WARNING: <reviewer> did not review this pass`, mention it in your one-line update; the SHIP or ESCALATE report repeats it.
- **Precedents** (`crossfire precedent add "<ruling>"`) record a question the owner settled, so builders, the breaker and reviewers stop raising it. Add one only on the person's explicit words, never by an agent's own decision: when the user says something like "that is fine, stop flagging it", quote their ruling in one sentence. `crossfire precedents` lists them.
- `crossfire status --slug <slug>` shows where a loop is, if you lose track. `crossfire status` lists every loop in the repository, and flags any loop whose builder or breaker wrote a result that crossfire has not recorded (`STALLED: ... run crossfire built`): run that command.

## Running several loops at once

Before starting loops in parallel, answer with numbers, and tell the user:
- **Agents:** each loop needs **2 concurrent agents** (the one following it, plus a builder or breaker at a time). With a limit of N concurrent agents, run at most N/2 loops, and one loop per agent session.
- **Merging:** how the branches will merge (one at a time, or a batch tested once), how long CI takes on a pull request, and how many PRs will be open at once. Prefer few open PRs and a plan written before the work starts.
- **Proof commands:** what each one proves for its change. Keep them to what the change touches; the full suite is CI's job.
- **Liveness:** whoever coordinates checks every loop at least hourly with `crossfire status` and acts on `STALLED`; "waiting" with no new step for an hour is a stall, not progress.
- Several loops can run at once only in separate worktrees with separate slugs. One loop per checkout is enforced: `crossfire init` refuses while another loop is active in the checkout (and `init --force` will not restart a loop that has recorded steps). When init refuses, run the commands it prints: they make the new worktree, copy the spec and start the loop there.
- `crossfire abandon --slug <slug>` only on the person's explicit words, and only for a loop init reports as looking stuck (no step for 3 hours, no command running). Never edit or delete files under `.crossfire/` to get around a refusal.

## Gates the referee enforces (for explaining an escalation)

Breaker (internal, before a review pass, when on): proves attacks with failing tests; the builder hardens; it never escalates by itself · SPEC the builder returned SPEC_MISMATCH (the spec cannot be built as written) · G0 the spec's E2E and invariant commands must pass before any review · G1 malformed input twice · G2 round cap · G3 a finding re-flagged after a claimed fix, or the builder disputing a non-nit · G4 a new finding where a fix was claimed · G5 a new blocker at review pass 2 or later · G6 time budget, checked only before a new builder leg (a finished fix is always reviewed) · G7 nits get one pass, then ship without another review. Blockers never downgrade; anything ambiguous escalates.
