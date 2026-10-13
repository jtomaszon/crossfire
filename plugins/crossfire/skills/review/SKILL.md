---
name: review
description: Use when asked to review a PR, check someone's branch, re-check a PR after changes, watch a PR, or get a second opinion on changes that already exist. Reviews with OpenAI Codex (required) and xAI Grok Build (when it can run) without building anything; can watch the PR and hand findings to a crossfire loop that starts at the fix round.
argument-hint: "[PR number or URL, or a branch name]"
---

# Crossfire review

Review what already exists. Nothing is built and nothing in the user's checkout changes.

`crossfire` is on your PATH while this plugin is enabled. If it is not, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/crossfire.mjs"` in its place.

## 1. Check the reviewers

Run `crossfire doctor`. If it says **NOT READY**, show the user its output and stop (Codex is required). Grok missing or not usable is only a warning: say the review will rest on Codex alone.

## 2. Get the change into its own worktree

Never review in, or switch, the user's current checkout.

- **A PR** (number or URL): `gh pr view <n> --json number,title,body,url,baseRefName,headRefName` for the title, description and base. Fetch it with `git fetch origin pull/<n>/head:crossfire/pr-<n>` and `git fetch origin <base>`, then make a worktree for it: the repository's own worktree tool if its CLAUDE.md or AGENTS.md names one, else `git worktree add ../<repo>-pr-<n> crossfire/pr-<n>`.
- **A branch**: fetch it and make a worktree the same way. The base is the repository's default branch unless the user says otherwise.
- Work from that worktree for everything below.
- Read the PR's conversation too (`gh pr view <n> --comments`): earlier review comments and what the author already tried belong in the focus you give the reviewers, so they do not re-report what was settled. Run `crossfire memory` for what reviewers found in this repository before.

## 3. Run the check

From the worktree, with the Bash tool's `run_in_background: true` (a review takes a minute or more), then wait for the completion notification:

```bash
crossfire check --base origin/<base> --name pr-<n> \
  --focus "<PR title>. <the PR description, trimmed to what it is for and what it changes>"
```

Pass `--spec <file>` too if the user gave one. Exit 3 means the Codex review failed: run it once more. Exit 5: a reviewer is not usable; show the message and stop.

## 4. Report

Show the user, in this order:
1. The `REVIEWERS:` line as crossfire printed it (whether Grok actually reviewed).
2. The verdict: approved, or the number of findings by severity.
3. Each finding: severity, `file:line`, the title, and one line of why it matters, blockers first. Read the report (`REPORT:` path) for the detail; do not invent findings or soften them.
4. The report path.

**Do not post anything to GitHub** (no review, comments or approval) unless the user asks. If they do, post exactly the findings from the report, attributed to the reviewer that found each one, and mark severities honestly: a nit is labelled optional, not a must-fix (a performance nit posted as must-fix once led the author's bot to "fix" it into a real blocker). End every comment crossfire posts with the line `<!-- crossfire -->`, so the watcher never wakes on its own comments.

## 5. Offer the next step

If there are findings, offer:
- **Fix them with a crossfire loop**, when the user owns the branch or wants to push fixes. Write a spec as the `crossfire:loop` skill describes (`crossfire spec --slug <slug>`, including "How this could fail"), then start the loop at the fix round with these findings, from the same worktree:
  `crossfire init --slug <slug> --spec <spec> --base origin/<base> --from-check pr-<n> [--e2e <cmd>]...`
  and follow its NEXT ACTION as the `crossfire:loop` skill describes. No builder round runs before the fix.
- **Post the findings** on the PR (only if asked).
- **Watch the PR** for the author's changes (next section), when someone else owns it and will push fixes.
- **Nothing**: the report stays in `.crossfire/checks/` in that worktree.

Never push, merge or approve a PR unless the user asks.

## 6. Watch for changes (when the user wants it)

Start the watcher with the Bash tool's `run_in_background: true`, from the review worktree:

```bash
crossfire watch --pr <n> --interval-sec 120 --timeout-min 720 [--from <login>]...
```

It wakes on a new push, a comment to handle (from the `--from` people only, if given: use it so drive-by comments do not wake you), or the PR closing. Comments need `gh` to reach the PR. Crossfire uses the watched remote's own repository and never guesses: if the remote's URL is not a GitHub address, pass `--repo OWNER/NAME`, otherwise comments and closure are not watched (it says so) and only pushes are.

**Comments are delivered at least once, until acknowledged.** Each one comes with an `ID:`. When you have handled it, acknowledge it as you start watching again: `crossfire watch --pr <n> --ack <ID> [--ack <ID>]...` (or `--ack all`). A comment you did not acknowledge is shown again on the next run, so nothing is lost if the session stops halfway; check its ID before acting twice. One watcher per PR: a second one is refused.

Tell the user it is watching, then carry on; do not poll it. When its completion notification arrives, read its output:

- **`CHANGED <old> -> <new>`** (with an `ID: head:<sha>`): the author pushed. Update the review worktree to the new head (it is crossfire's own worktree, so this is safe): `git fetch origin pull/<n>/head && git reset --hard FETCH_HEAD`. Then re-check against the last check, numbering the new one:
  `crossfire check --base origin/<base> --since <last check id> --name pr-<n>-<k>` (background, as before).
  Tell the user the delta in two or three lines: the `SINCE` line (how many fixed, still open, new), each still-open finding, and any new blocker. Then:
  - if the verdict is **APPROVED**, say so and stop watching;
  - otherwise start `crossfire watch` again, acknowledging the push you just re-checked (`--ack head:<sha>`), and keep going. An unacknowledged push is reported again, so a push that lands while you handle a comment is never missed.
- **`comment(s) to handle`**: read each one. A question about a finding: answer it (post only if the user allowed posting). A disagreement with a finding: weigh it, and if it is right, say so and drop the finding from the next check's focus. A fix request to us from an allowed reviewer, on a branch we may change: fix it through a crossfire loop (`crossfire init ... --from-check <last check>` or a new spec), then re-check. Then watch again, acknowledging the comments you handled (`--ack <ID>`).
- **`MERGED` or `CLOSED`** (or the ref is gone): tell the user and stop.
- **No new commits** before the timeout (exit 4): tell the user, and offer to watch longer.

The watcher lives in this session: it stops if the session ends. For watching over days, suggest running it from a long-lived session (for example Omnara) or a scheduled task. Never post on the PR during watching unless the user asked for that.
