# crossfire

A Claude Code plugin that runs a change through a **spec-first build → review → fix loop** with reviewers from other AI vendors, until it ships or needs a human.

- **Claude builds.** A builder subagent implements the spec test-first and commits each round.
- **Other vendors review.** **OpenAI Codex reviews every round (required).** **xAI Grok Build adds a second, independent review** when it is installed. Both run read-only, through their vendors' own official Claude Code plugins.
- **A referee decides.** The `crossfire` script, not the model, decides every next step and stops the loop at hard gates: round cap, a finding that keeps coming back, a regression, a time budget. You hear about it only when it ships or when it needs your call.

It pairs with [superpowers](https://github.com/obra/superpowers): superpowers brings the habits (brainstorming, plans, red/green TDD, worktrees, debugging), crossfire brings the independent reviewers and the referee. The design is ported from the JARVIS builder-reviewer loop, including the gates and the lessons that produced them.

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

While the repository is private, add the marketplace by its SSH address instead (your GitHub SSH key must have access): `claude plugin marketplace add git@github.com:jtomaszon/crossfire.git`.

Then, in Claude Code: `/reload-plugins` and `/crossfire:setup`. It must say **READY**.

**Optional, recommended: Grok Build as a second reviewer.** Install xAI's Grok Build CLI and log in (`grok models` must work; Grok Build needs an xAI subscription that includes it), then:

```bash
claude plugin marketplace add xai-org/grok-build-plugin-cc
claude plugin install grok-build@xai-grok-build
```

Requirements: Claude Code with plugin dependencies support, Node.js 18.18+, git.

### Moving from the old `scaledb-crossfire` marketplace

Versions up to 0.7.0 were installed as `crossfire@scaledb-crossfire`. To switch to 1.0.0:

```bash
# remove the old one
claude plugin uninstall crossfire@scaledb-crossfire
claude plugin marketplace remove scaledb-crossfire

# install the new one (SSH address while the repository is private)
claude plugin marketplace add git@github.com:jtomaszon/crossfire.git
claude plugin install crossfire@jtomaszon
```

Codex, Grok Build and superpowers stay installed; nothing else changes. Then `/reload-plugins` (or a new session) and `/crossfire:setup`. Your loops, checks and memory carry over: they live in each repository (`.crossfire/` and `.git/crossfire/`), not in the plugin.

### Codex and Grok on Linux

Both reviewers run read-only inside a bubblewrap sandbox on Linux: Codex ships its own copy, Grok Build needs `bubblewrap` installed (`sudo apt install -y bubblewrap`). On Ubuntu 23.10 and later, AppArmor blocks the user namespaces bubblewrap needs (`kernel.apparmor_restrict_unprivileged_userns = 1`):

- **Codex** cannot run `git` in its sandbox (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`). It still answers when the diff is small enough to be handed to it inline, but on a real change it reviews blind and says the review was blocked. Crossfire treats that as a failed review, never as a finding, and `crossfire doctor` marks Codex NOT READY on such a host.
- **Grok** refuses to start (`bwrap: setting up uid map: Permission denied`).

Allowing it is a host security decision: the usual fix is an AppArmor profile that grants `userns` to the specific bubblewrap binaries only (Codex's bundled one and `/usr/bin/bwrap`), the way Ubuntu does for other sandboxing apps. macOS is not affected.

## Use

In a git repository, ask Claude for a change and say "crossfire", or run `/crossfire:loop <what to build>`. Claude will:

1. Check the reviewers (`crossfire doctor`).
2. Gather context and plan through superpowers: `brainstorming` explores the repository (its docs for the area, existing patterns, callers; for someone else's PR, the PR conversation), then `writing-plans` writes a plan for a zero-context engineer with a **Review Focus** of likely failure modes. Crossfire adds this repository's **memory**: the kinds of problems reviewers found here before. Spec and plan stay out of git. **You approve them**; after that the loop runs on its own.
3. Make a branch or worktree and `crossfire init`.
4. Loop: builder round → crossfire runs the proof commands itself (G0) → an internal **breaker** subagent tries to break the change, proving each attack with a failing test, and the builder hardens → Codex (and Grok) review → valid findings go straight back to the builder → ...
5. Stop on **SHIP** (report of what was found and fixed) or **ESCALATE** (the gate, the reason, the open findings, and your options). It never pushes or merges unless you ask.

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
| G0 proof | the spec's E2E and invariant commands fail (the builder gets the output and tries again; review only starts on green) |
| G1 malformed | the builder's result or the Codex review is malformed twice in a row |
| G2 round cap | findings are still open after `--max-rounds` builder rounds (default 5) |
| G3 convergence | a reviewer re-flags a finding the builder said it fixed, or the builder disputes a non-nit |
| G4 suspect | a new finding lands where a fix was just claimed |
| G5 regression | a brand-new blocker appears at review pass 2 or later |
| G6 budget | the loop runs past `--max-minutes` (default 45) |
| G7 nits | only nits are left: one fix pass, then ship without another review |

**Before every review pass, the breaker.** A cold `crossfire:breaker` subagent attacks the round (transactions and rollback, stale in-memory state, concurrency, retries, ordering, missing data) and must prove each attack with a failing test in a throwaway worktree; it never touches the branch. Proven attacks get one harden round before the reviewers see the branch. It is internal: it never escalates, and a builder's dispute goes to the reviewers to judge. The goal is that the cross-vendor review becomes a formality; every report shows whether the first review pass approved. `--breaker off` disables it.

**What the referee requires of each round:** the spec has a "How this could fail" section (at least 3 items); every fixed BLOCKER or CHANGES finding names the broadest rule the fix enforces and at least 3 tested variants of it.

Blockers never downgrade. Anything ambiguous escalates instead of looping again. When reviewers disagree, the stricter one wins: a blocker from either reviewer must be fixed.

Severity mapping from the reviewers' shared output schema: `critical`/`high` → BLOCKER, `medium` → CHANGES, `low` → NIT.

## The referee CLI

`crossfire` is on Claude's PATH while the plugin is enabled.

```
crossfire doctor                     reviewers installed, official, logged in?
crossfire check [--base <ref>] [--focus <text>] [--spec <file>] [--name <id>]   one review of the current branch, no loop
crossfire checks                     list this repository's checks
crossfire memory                     what reviewers found in this repository before (local, never committed)
crossfire check --since <id> --name <new id>   re-check after changes: fixed, still open, new
crossfire watch --pr <n> | --branch <name> [--interval-sec 120] [--timeout-min 720]   wait for the PR to move
crossfire init --slug <s> --spec <file> [--base <ref>] [--e2e <cmd>]... [--invariant <cmd>]...
               [--max-rounds 5] [--max-minutes 45] [--grok auto|on|off]
crossfire built --slug <s>           record the builder's result, run the proof commands
crossfire attacked --slug <s>        record the breaker's result
crossfire proof --slug <s> --e2e <cmd>... [--invariant <cmd>]...   replace a loop's proof commands
crossfire review --slug <s>          run Codex (+ Grok), record findings
crossfire status [--slug <s>]        where a loop is and what comes next
crossfire report --slug <s>          the SHIP or ESCALATE report
```

Every command prints a `NEXT ACTION`. Exit codes: 0 ok, 2 usage, 3 malformed (re-ask; nothing advanced), 4 loop already finished, 5 environment (a reviewer is missing or not logged in).

Loop files (state, briefs, builder results, raw reviews, the report) and specs live in `.crossfire/` at the repository root. Crossfire adds it to `.git/info/exclude`, so it is never committed and never reaches a reviewer's diff. Reviews cover committed work only (`base...HEAD`), so the builder commits every round.

## How the reviewers are called

Claude cannot run the vendors' review slash commands itself (they are user-only), so crossfire calls the same scripts those commands call, found through `claude plugin list --json` and verified against `claude plugin marketplace list --json`:

- Codex: `node <codex plugin>/scripts/codex-companion.mjs adversarial-review --wait --json --base <base sha> --cwd <repo> "<focus>"`
- Grok Build: `node <grok-build plugin>/scripts/grok-bridge.mjs critique --wait --json --base <base sha> --cwd <repo> "<focus>"`

Both run read-only and return the same review schema. The focus text carries the spec and the list of earlier findings with their tags, so a reviewer can say "[F2] still not fixed" and the referee can tell a repeat from a new problem.

## Known issues

- **Watch lock takeover under a long pause.** One watcher per PR is enforced with a lock file and a takeover protocol for stale locks. If a watcher is suspended for more than 10 seconds in the middle of taking over a stale lock, a second watcher can take it too (found by a crossfire review, reproduced in simulation). It needs a stale lock, two watchers started for the same PR, and a pause at that instant. An OS-backed exclusive lock would remove it.
- **"Still open" by place.** A re-check counts an earlier finding as still open when a new finding of the same severity lands within a few lines of it, even if the earlier one was fixed. Read the finding before acting on a "still open" that matched by place.

## Develop

```bash
npm test                                        # unit and end-to-end tests, no network, fake reviewers
claude plugin validate plugins/crossfire        # manifest check
claude --plugin-dir plugins/crossfire           # try it in a session without installing
```

The end-to-end tests run the real CLI in a throwaway git repository against a fake `claude` CLI and fake official plugins (`tests/fixtures/`).

## License

Apache-2.0. Copyright 2026 Javier Tomas Zon.
