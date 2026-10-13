# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's **"Report a vulnerability"** button on this repository's Security tab, rather than in a public issue. If that is not available, open an issue that only asks for a private contact, without details.

Useful to include: the crossfire version (`crossfire version`), your OS, which reviewers were installed (`crossfire doctor`), and the smallest steps that show the problem.

## What crossfire is trusted with

Crossfire is a referee script plus Claude Code skills and agents. It runs commands on your machine: your proof commands (`--e2e`, `--invariant`), git, `gh`, and the official Codex and Grok Build plugins' scripts. Treat a spec's proof commands like any script you run: crossfire executes them as written.

Things it is designed never to do: push, merge, rebase onto another branch, force-push or delete branches; post to GitHub unless you ask; install tools or log in for you; send telemetry. The breaker works only in a throwaway worktree, and the reviewers run read-only. A way to make crossfire do any of these is a vulnerability: please report it.

## What leaves your machine

Crossfire itself sends nothing. The tools it drives do, under their own terms:

| Destination | What | When |
|---|---|---|
| OpenAI (Codex) | crossfire's focus text (spec or plan excerpt, the PR description you give it, earlier findings); Codex's agent reads the branch diff and any repository files it chooses, read-only | every review pass and `crossfire check` |
| xAI (Grok Build) | the same as Codex | every review pass, when Grok Build is installed and usable |
| Anthropic (Claude Code) | the builder, breaker and orchestrator are ordinary Claude Code sessions | every loop |
| GitHub | `gh` reads the PR's state, comments and reviews | `crossfire watch --pr`, and `/crossfire:review` |

Never sent or committed: `.crossfire/` (specs, plans, loop runs, checks, the watcher's inbox; git ignores it through `.git/info/exclude`), `.git/crossfire/memory.md` (titles and rules of past findings, no code), and `~/.local/state/crossfire/reviewers.json` (one-line reviewer errors).

If a repository holds code you may not send to OpenAI or xAI, do not run crossfire's reviews on it.
