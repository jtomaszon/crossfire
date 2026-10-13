# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's **"Report a vulnerability"** button on this repository's Security tab, rather than in a public issue. If that is not available, open an issue that only asks for a private contact, without details.

Useful to include: the crossfire version (`crossfire version`), your OS, which reviewers were installed (`crossfire doctor`), and the smallest steps that show the problem.

## What crossfire is trusted with

Crossfire is a referee script plus Claude Code skills and agents. It runs commands on your machine: your proof commands (`--e2e`, `--invariant`), git, `gh`, and the official Codex and Grok Build plugins' scripts. Treat a spec's proof commands like any script you run: crossfire executes them as written.

The `crossfire` script never pushes, merges, rebases onto another branch, force-pushes, deletes branches, posts to GitHub, installs tools or logs in for you. The Claude session driving it (the orchestrator) may open a PR, push, merge or post only when you ask it to. Crossfire sends no telemetry. The breaker works only in a throwaway worktree (crossfire refuses its result while the branch differs from the builder's commit), only a commit the proof commands verified is reviewed, and the reviewers run read-only. A way to make the `crossfire` script do any of these, or to get an unverified commit reviewed, is a vulnerability: please report it.

## What leaves your machine

Crossfire itself sends nothing. The tools it drives do, under their own terms:

| Destination | What | When |
|---|---|---|
| OpenAI (Codex) | crossfire's focus text: an excerpt of the spec (up to 12,000 characters), the PR description you give it, earlier findings and the builder's answers to them. Codex's agent reads the branch diff and any repository files it chooses, read-only | every loop review pass and every `crossfire check` (including `/crossfire:review`) |
| xAI (Grok Build) | the same as Codex | the same as Codex, whenever Grok Build is usable (the default `--grok auto`; `--grok off` stops it) |
| Anthropic (Claude Code) | the orchestrator, builder and breaker are ordinary Claude Code sessions; they read the spec, plan, briefs and the repository's memory | every loop and review |
| GitHub | `gh` reads the PR's state, comments and reviews | `crossfire watch --pr`, and `/crossfire:review` |

Kept out of git and stored only on your machine: `.crossfire/` (specs, plans, loop runs, checks, the watcher's inbox; ignored through `.git/info/exclude`), `.git/crossfire/memory.md` (titles and rules of past findings, no code), and `~/.local/state/crossfire/reviewers.json` (one-line reviewer errors). Out of git does not mean never sent: parts of the specs, plans, findings and memory reach the services above as the table says.

If a repository holds code you may not send to OpenAI or xAI, do not run crossfire's reviews on it.
