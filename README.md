# crossfire

A Claude Code plugin that runs a change through a **spec-first build → review → fix loop** with reviewers from other AI vendors, until it ships or needs a human.

- **Claude builds.** A builder subagent implements the spec test-first and commits each round.
- **Other vendors review, starting with the spec.** **OpenAI Codex reviews the spec before any code exists, then every round (required).** **xAI Grok Build adds a second, independent review** of the spec and the first code pass when it is installed. Both run read-only, through their vendors' own official Claude Code plugins.
- **A referee decides.** The `crossfire` script, not the model, decides every next step and stops the loop at hard gates: round cap, a finding that keeps coming back, a regression, a time budget. You hear about it only when it ships or when it needs your call.

It pairs with [superpowers](https://github.com/obra/superpowers): superpowers brings the habits (brainstorming, plans, red/green TDD, worktrees, debugging), crossfire brings the independent reviewers and the referee. The gates come from JARVIS, the author's earlier private builder-reviewer agent setup; the lessons behind each gate are in the [CHANGELOG](CHANGELOG.md).

> **Status: experimental.** Used daily by its author; expect rough edges. Known issues are listed below.

## Install

Crossfire only uses the vendors' **official** plugins; it refuses a copy from any other marketplace.

```bash
# 1. Codex (required): the CLI, logged in
npm install -g @openai/codex
codex login                       # or: codex login --device-auth

# 2. The marketplaces crossfire's dependencies come from
claude plugin marketplace add openai/codex-plugin-cc

# 3. Crossfire
claude plugin marketplace add jtomaszon/crossfire
claude plugin install crossfire@jtomaszon    # also installs codex@openai-codex and superpowers
```

Requirements: Claude Code with plugin dependencies support (step 3 relies on it to install Codex's plugin and superpowers), Node.js 18.18+, git.

Then, in Claude Code: `/reload-plugins` and `/crossfire:setup`. It must say **READY**.

**Optional, recommended: Grok Build as a second reviewer.** Install xAI's Grok Build CLI and log in (`grok models` must work; Grok Build needs an xAI plan that includes the Grok Build CLI; on a free plan it stops after a review or two (usage limit)), then:

```bash
claude plugin marketplace add xai-org/grok-build-plugin-cc
claude plugin install grok-build@xai-grok-build
```

### What leaves your machine

Crossfire itself has no telemetry. The tools it drives send data under their own terms:

- **OpenAI (Codex) and, when usable, xAI (Grok Build),** on every `crossfire spec-review`, every loop review pass and every `crossfire check` (including `/crossfire:review`): crossfire's focus text (in a spec review, the spec and plan themselves, committed in a throwaway worktree; in a loop, the spec inline up to 12,000 characters plus its path, earlier findings and the builder's answers; in a check, the `--focus` text, which `/crossfire:review` fills with the PR description and earlier review comments, plus any `--spec` file inline up to 12,000 characters and, with `--since`, the earlier check's findings; everywhere, the owner's precedents), and their agent reads the branch diff and whatever repository files it chooses, read-only. Grok is used when it is usable unless you pass `--grok off`; under the default `--grok auto` a lean loop uses it on its first code pass only.
- **Anthropic (Claude Code):** the orchestrator, the builder and the breaker are ordinary Claude Code sessions; they read the spec, the plan, the briefs and the repository's memory, and `crossfire watch` prints PR comment bodies in full into the session.
- **GitHub:** `crossfire watch` and `/crossfire:review` read the PR's state, comments and reviews through `gh`; `crossfire ladder` reads the PRs from the loop's branch and the CI check runs and commit statuses of the PR's head commit. `crossfire watch` and `crossfire ladder` read the branch's head with `git ls-remote`.

Kept out of git (through `.git/info/exclude`) and stored only on your machine: `.crossfire/` (specs, plans, spec reviews, loop runs, checks, the watcher's inbox), `.git/crossfire/memory.md` and `.git/crossfire/precedents.md` (in the git common directory, shared by every worktree), and `~/.local/state/crossfire/reviewers.json` (one-line reviewer errors). "Out of git" is not "never sent": parts of these reach the tools above as described. See [SECURITY.md](SECURITY.md).

### What crossfire will never do

- The `crossfire` script never pushes, merges, rebases onto another branch, force-pushes, deletes branches (other than the throwaway `crossfire/spec-review-*` branch and worktree that `crossfire spec-review` creates on the base and removes again), posts to GitHub, installs tools or logs in for you. The Claude session driving it (the orchestrator) may open a PR, push, merge or post only when you ask it to.
- Let the breaker change your branch: it proves attacks in a throwaway worktree, and crossfire refuses its result, every time, while the working tree or HEAD differs from the builder's commit. In a loop, a review starts only on the commit the builder's last round recorded and its proof commands passed on (a loop without proof commands reviews it unproven), and verdicts are discarded if HEAD moved while the reviewers read the live checkout; do not change the checkout during a review. `crossfire check` runs no proof commands: it reviews the branch as it is, with the same HEAD comparison.
- Let a reviewer write: Codex and Grok run read-only.
- Guess: when something is ambiguous, the referee escalates to you instead of looping again.

### Codex and Grok on Linux

Both reviewers run read-only inside a bubblewrap sandbox on Linux: Codex ships its own copy, Grok Build needs `bubblewrap` installed (`sudo apt install -y bubblewrap`). On Ubuntu 23.10 and later, AppArmor blocks the user namespaces bubblewrap needs (`kernel.apparmor_restrict_unprivileged_userns = 1`):

- **Codex** cannot run `git` in its sandbox (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`). It still answers when the diff is small enough to be handed to it inline, but on a real change it reviews blind and says the review was blocked. Crossfire treats that as a failed review, never as a finding, and `crossfire doctor` marks Codex NOT READY on such a host.
- **Grok** refuses to start (`bwrap: setting up uid map: Permission denied`).

Allowing it is a host security decision: the usual fix is an AppArmor profile that grants `userns` to the specific bubblewrap binaries only (Codex's bundled one and `/usr/bin/bwrap`), the way Ubuntu does for other sandboxing apps. macOS is not affected.

## Use

In a git repository, ask Claude for a change and say "crossfire", or run `/crossfire:loop <what to build>`. Claude will:

1. Check the reviewers (`crossfire doctor`).
2. Gather context and plan through superpowers: `brainstorming` explores the repository (its docs for the area, existing patterns, callers; for someone else's PR, the PR conversation), then `writing-plans` writes a plan for a zero-context engineer with a **Review Focus** of likely failure modes. Crossfire adds this repository's **memory**: the kinds of problems reviewers found here before. Spec and plan stay out of git.
3. **Prove the spec** (`crossfire spec-review`): Codex and Grok review the spec and plan as a design before any code exists. Claude revises the spec for their findings and records a response to each. **You approve the revised spec**, with the findings and responses in front of you; after that the loop runs on its own.
4. Make a branch or worktree and `crossfire init`.
5. Loop, every round:
   1. The builder implements and commits (or stops with `SPEC_MISMATCH` when the spec cannot be built as written).
   2. Crossfire runs the proof commands itself (G0), and refuses a round that weakens tests.
   3. When it is on (a `**Risk:** high` spec, `--breaker on`, or a loop without a current spec review), the internal **breaker** tries to break the change and proves each attack with a failing test; proven attacks go back to the builder once (harden).
   4. Codex reviews the branch; Grok too on the first code pass.
   5. Valid findings go straight back to the builder for the next round; the gates below decide when it stops.
6. Stop on **SHIP** (report of what was found and fixed) or **ESCALATE** (the gate, the reason, the open findings, and your options). It never pushes or merges unless you ask.

## Prove the spec

Most of what reviewers find, they find on their first pass; later passes mostly check fixes. So 1.4.0 spends the cross-vendor attack where it is cheapest, on the spec before any code exists, and keeps the code reviews after it lean:

```bash
crossfire spec-review --slug <slug> --spec <spec> --plan <plan> --base <base>
```

Codex (and Grok, unless it is off or skipped on this machine) review the spec and plan **as a design against the repository's current code**: gaps, contradictions, untestable or ambiguous acceptance criteria, missing failure modes, conflicts with the code the spec names, and cheaper ways to the same goal. Severities: high (the builder would build the wrong thing, or a hole would ship), medium (an ambiguity that would cost a round), low (wording). Crossfire commits the spec and plan at `crossfire-spec-review/<slug>.md` in a throwaway worktree on the base, so the reviewers read them as a diff; your branch, working tree and index are never touched, and the worktree and its branch are removed afterwards, also when a reviewer fails. The review is saved as `.crossfire/specs/<slug>.review.json` (findings, reviewers, when, the base commit, and a sha256 of the spec and the plan) and a readable `.review.md`.

Claude revises the spec for the findings and writes `.crossfire/specs/<slug>.review-response.md`, one line per finding. Then `crossfire init` compares the spec and plan with what was reviewed:

| `init` prints | when | defaults |
|---|---|---|
| `SPEC REVIEW: current` | the same bytes were reviewed | lean |
| `SPEC REVIEW: revised after review` | they changed, and the response file is newer than the review | lean |
| `SPEC REVIEW: stale` | they changed with no recorded response | full, with a warning |
| `SPEC REVIEW: none` | no spec review | full, with a warning |

| Default | lean | full (as in 1.3) |
|---|---|---|
| `--grok auto` | Grok on the spec review and the first code review pass (with `--from-check`, the first pass crossfire runs) | Grok on every pass |
| `--breaker` | off; on when the spec has a `**Risk:** high` line | on |
| `--max-rounds` | 2 | 3 |

Flags always win. A loop stores the settings it decided; a loop started on 1.3 keeps its own (Grok on every pass under auto).

**Grok on a broken host.** Under `--grok auto`, when Grok's last 3 attempts on this machine all failed and the latest is under 7 days old, crossfire skips it without calling it (`grok: skipped (...)`); `crossfire doctor` shows why, and `--grok on` calls it anyway.

**Precedents.** `crossfire precedent add "<ruling>"` records a question the owner settled (one dated line in `<git common dir>/crossfire/precedents.md`); builder and breaker briefs and every reviewer's focus carry the latest 30 under "Settled by the owner; do not raise these again". The loop skill adds one only on the person's explicit words. `crossfire precedents` lists them.

For the delivery habits around the loop (small PRs, what "done" means after SHIP, CI as the gate, rollback, runbooks, worktrees), see [docs/workflow.md](docs/workflow.md). A complete example run is in [docs/example/](docs/example/README.md).

## Review a PR without building anything

`/crossfire:review <PR number, URL or branch>` reviews what already exists: Claude checks the PR out into its own worktree and runs `crossfire check`, which asks Codex (and Grok when it can run) for one review against the base. No spec, no builder, no loop. You get the `REVIEWERS:` line, the verdict and the findings, with a report in `.crossfire/checks/<id>/`. Nothing is posted to GitHub unless you ask.

If you want the findings fixed, the same findings start a loop at its fix round, with no builder round first:

```bash
crossfire init --slug <slug> --spec <spec> --base <base> --from-check <check id>
```

The check counts as the loop's first review pass.

**Watching a PR.** After a review with findings, `/crossfire:review` can watch the PR for the author's changes: `crossfire watch --pr <n>` waits (polling `git ls-remote`, cheap, no GitHub login needed) until the PR's head moves, or it is merged or closed. On each push Claude updates its review worktree and re-checks with `crossfire check --since <last check>`; the reviewers get the earlier findings tagged, and you get the delta: which were fixed, which are still open, what is new. It stops when the review approves, the PR closes, or you say so. The watcher lives in the Claude session.

## The gates

| Gate | Stops the loop when |
|---|---|
| SPEC | the builder returned `SPEC_MISMATCH`: the spec cannot be built as written. No proof command runs; the report carries its handoff (severity, summary, what it tried, the situation, its synthesis) and suggests a revised spec (`crossfire respec`) |
| G0 proof | the spec's E2E and invariant commands fail (the builder gets the output and tries again; review only starts on green) |
| G1 malformed | the builder's result or the Codex review is malformed twice in a row; a round that weakens tests is malformed: existing test files are not changed unless the spec allows it; add new tests in new files. A test file is known by its name: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*.py`, or under `__tests__/`; helpers and fixtures are not test files. Only the commits after the head the loop started from count (a `--from-check` pull request's own commits do not), and only on loops started on 1.4; a loop started on 1.3 keeps the 1.3 rules (a file the "Allowed test changes" of the spec as approved at init names may change; renames with no content change pass; a new test file may not call a skip or focus API) |
| G2 round cap | findings are still open after `--max-rounds` builder legs crossfire ran (default 2 with a current spec review, 3 without; with `--from-check`, the pull request's own code is not one) |
| G3 convergence | a reviewer re-flags a finding the builder said it fixed, or the builder disputes a non-nit |
| G4 suspect | a new finding lands where a fix was just claimed |
| G5 regression | a brand-new blocker appears at review pass 2 or later |
| G6 budget | `--max-minutes` (default 45) is spent when a new builder leg would start; a finished fix still gets its review (over budget, the breaker leg is skipped), and an approval still ships |
| G7 nits | only nits are left: one fix pass, then ship without another review |

**Before a review pass, the breaker, where it pays.** A cold `crossfire:breaker` subagent attacks the round (transactions and rollback, stale in-memory state, concurrency, retries, ordering, missing data) and must prove each attack with a failing test in a throwaway worktree; it never touches the branch. Proven attacks get one harden round before the reviewers see the branch. It is internal: it never escalates, and a builder's dispute goes to the reviewers to judge. It overlaps the reviewers most of the time, so with a current spec review it is off unless the spec's `**Risk:** high` line or `--breaker on` turns it on; without one it runs as in 1.3.

**Size.** When a review pass starts on a diff over about 400 changed lines or 10 files (lockfiles excluded), crossfire prints `WARNING: this change is <N> lines in <M> files; past about 400 lines or 10 files, split it` and notes it in the report's Evidence. It does not block.

**What the referee requires of each round:** the spec has a "How this could fail" section (at least 3 items); every fixed BLOCKER or CHANGES finding names the broadest rule the fix enforces and at least 3 tested variants of it.

Blockers never downgrade. Anything ambiguous escalates instead of looping again. When reviewers disagree, the stricter one wins: a blocker from either reviewer must be fixed.

Severity mapping from the reviewers' shared output schema: `critical`/`high` → BLOCKER, `medium` → CHANGES, `low` → NIT.

## The referee CLI

`crossfire` is on Claude's PATH while the plugin is enabled.

```
crossfire doctor                     reviewers installed, official, logged in?
crossfire spec-review --slug <s> --spec <file> [--plan <file>] [--base <ref>] [--grok auto|on|off]
                                     prove the spec: Codex (+ Grok) review it as a design, before any code
crossfire precedent add "<ruling>"   record the owner's ruling; crossfire precedents lists them
crossfire check [--base <ref>] [--focus <text>] [--spec <file>] [--name <id>]   one review of the current branch, no loop
crossfire checks                     list this repository's checks
crossfire memory                     what reviewers found in this repository before (local, never committed)
crossfire check --since <id> --name <new id>   re-check after changes: fixed, still open, new
crossfire watch --pr <n> | --branch <name> [--interval-sec 120] [--timeout-min 720]   wait for the PR to move
crossfire init --slug <s> --spec <file> [--base <ref>] [--e2e <cmd>]... [--invariant <cmd>]...
               [--max-rounds 2|3] [--max-minutes 45] [--grok auto|on|off] [--breaker on|off]
crossfire built --slug <s>           record the builder's result, run the proof commands
crossfire attacked --slug <s>        record the breaker's result
crossfire proof --slug <s> --e2e <cmd>... [--invariant <cmd>]...   replace a loop's proof commands
crossfire review --slug <s>          run Codex (+ Grok), record findings
crossfire status [--slug <s>]        where a loop is and what comes next
crossfire report --slug <s>          the SHIP or ESCALATE report
crossfire ladder --slug <s>          after SHIP: pushed, PR, CI, merged (reads only; never pushes, merges or posts)
crossfire respec --from-loop <s> --slug <new>   start over: a new spec with every finding as a known failure mode
```

Every command prints a `NEXT ACTION`. Exit codes: 0 ok, 2 usage, 3 malformed (re-ask; nothing advanced), 4 loop already finished, 5 environment (a reviewer is missing or not logged in).

Loop files (state, briefs, builder results, raw reviews, the report) and specs live in `.crossfire/` at the repository root. Crossfire adds it to `.git/info/exclude`, so it is never committed and never reaches a reviewer's diff. Reviews cover committed work only (`base...HEAD`), so the builder commits every round.

## How the reviewers are called

Claude cannot run the vendors' review slash commands itself (they are user-only), so crossfire calls the same scripts those commands call, found through `claude plugin list --json` and verified against `claude plugin marketplace list --json`:

- Codex: `node <codex plugin>/scripts/codex-companion.mjs adversarial-review --wait --json --base <base sha> --cwd <repo> "<focus>"`
- Grok Build: `node <grok-build plugin>/scripts/grok-bridge.mjs critique --wait --json --base <base sha> --cwd <repo> "<focus>"`

Both run read-only and return the same review schema. The focus text carries the spec and the list of earlier findings with their tags, so a reviewer can say "[F2] still not fixed" and the referee can tell a repeat from a new problem. For `crossfire spec-review`, `--cwd` is a throwaway worktree on the base with the spec committed in it, and the focus asks for a design review instead.

## Before running many loops

Crossfire runs one change per loop. Running many at once is a plan, not a default:

- **One active loop per checkout:** `crossfire init` refuses while another loop is active in the same checkout (decided under the lock `.crossfire/runs/.init.lock`, so two inits at once cannot both start), and prints the commands that start the new loop in a worktree of its own, for example `git worktree add ../<repo>-<slug> -b <slug> main`, a copy of `.crossfire/specs/<slug>.*`, and the init line. There is no flag to skip it. `init --force` restarts only a loop that finished or has recorded nothing since its init.
- **A stuck loop:** when init says a loop looks stuck (no step for 3 hours and no crossfire command running), the person can end it with `crossfire abandon --slug <slug>`: it escalates at gate `ABANDONED` with a report. Crossfire never ends a loop by itself.
- **2 concurrent agents per loop:** the one following it, plus a builder or breaker. With a limit of N concurrent agents, run at most N/2 loops.
- **Merging:** decide how the branches merge before starting them (one at a time, or a batch tested once), how long CI takes per pull request, and how many PRs will be open at once.
- **Proof commands:** each says what it proves for its change; the full suite belongs to CI.
- **Liveness:** check `crossfire status` at least hourly. `STALLED` means a builder or breaker finished and nobody recorded it.
- **Start over instead of patching:** when an escalation says "Consider starting over" (findings clustering in one place across passes, fixes re-flagged), `crossfire respec` drafts a new spec with every finding as a known failure mode, and the new loop starts from the base.

## Known issues

- **`crossfire spec-review` and a concurrent local process.** spec-review refuses to write its review documents through a symlink, including a symlinked `.crossfire` or `.crossfire/specs`, and replaces files without following one. Another process running on the same machine at the same moment could still swap one of those directories for a symlink between the check and the write. Closing that needs no-follow directory handles that Node does not provide; a process able to do that already has easier ways in.
- **Watch lock takeover under a long pause.** One watcher per PR is enforced with a lock file and a takeover protocol for stale locks. If a watcher is suspended for more than 10 seconds in the middle of taking over a stale lock, a second watcher can take it too (found by a crossfire review, reproduced in simulation). It needs a stale lock, two watchers started for the same PR, and a pause at that instant. An OS-backed exclusive lock would remove it.

## Develop

```bash
npm test                                        # unit and end-to-end tests, no network, fake reviewers
claude plugin validate plugins/crossfire        # manifest check
claude --plugin-dir plugins/crossfire           # try it in a session without installing
```

The end-to-end tests run the real CLI in a throwaway git repository against a fake `claude` CLI and fake official plugins (`tests/fixtures/`).

## License

Apache-2.0. Copyright 2026 Javier Tomas Zon.
