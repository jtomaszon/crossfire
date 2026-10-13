# Contributing

Thanks for looking. Small, focused changes are easiest to review and merge.

## Run the tests

```bash
npm test                                       # node --test, offline, no real reviewers
claude plugin validate --strict plugins/crossfire
claude plugin validate --strict .
```

The tests drive the real CLI in throwaway git repositories against fakes: `tests/fixtures/fake-claude.mjs` (the `claude` CLI), `fake-reviewer.mjs` (the Codex and Grok plugins' scripts) and `fake-gh.mjs` (`gh`). Tests must never call the real `claude`, `codex`, `grok`, `gh` or touch per-machine state: inject fakes through the environment variables in `tests/helpers.mjs`.

## How changes are made here

- **One change, one branch, one small PR.** Roughly 400 changed lines or 10 files at most; split anything bigger.
- **Tests with the change.** A behaviour change comes with a test that fails without it.
- **Crossfire reviews crossfire.** Before a change merges, run `crossfire check --base origin/main` on its branch (or a full `/crossfire:loop`) and fix what it finds; mention the result in the PR.
- **Commit messages say why.** `<area>: <what>` on the first line, then why, and which finding or issue it closes.
- **Never weaken a gate to make something pass.** If a gate is wrong, say so in an issue.
- **Keep it dependency-free.** The CLI uses the Node.js standard library only.

## Releases

The version lives in three places that must match: `plugins/crossfire/.claude-plugin/plugin.json`, `package.json`, and `VERSION` in `plugins/crossfire/scripts/crossfire.mjs`. Add a CHANGELOG entry, then tag with `claude plugin tag` (tags are `crossfire--v<version>`).
