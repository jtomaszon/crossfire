---
name: setup
description: Check that crossfire's reviewers are installed, official and logged in - OpenAI Codex (required) and xAI Grok Build (optional) - and show the exact commands to fix whatever is missing. Use after installing crossfire, when a crossfire loop reports a reviewer is not usable, or when the user asks whether crossfire is ready.
---

# Crossfire setup

Run:

```bash
crossfire doctor
```

(If `crossfire` is not on PATH: `node "${CLAUDE_PLUGIN_ROOT}/scripts/crossfire.mjs" doctor`.)

Show the user its output as it is, then explain only what is not `ok`:

- **codex FAIL** blocks every loop. Crossfire only uses OpenAI's own plugin (`codex@openai-codex`, from the `openai/codex-plugin-cc` marketplace) and the Codex CLI. The doctor prints the commands. Logging in is interactive, so the user runs it themselves in this session by typing `! codex login` (or `! codex login --device-auth` without a browser). Never run a login for them and never ask for a key.
- **grok warn** is optional. With xAI's own plugin (`grok-build@xai-grok-build`, from `xai-org/grok-build-plugin-cc`) and the Grok Build CLI logged in, every review pass gets a second, independent reviewer. Grok Build needs an xAI subscription that includes it.
- **superpowers warn**: the loop still runs, but spec writing, worktrees and the builder's test-driven discipline are better with it: `claude plugin install superpowers@claude-plugins-official`.
- A plugin found but **not official** (it came from a different marketplace): crossfire refuses it on purpose. Tell the user to uninstall that copy and install the vendor's own.

After installing a plugin, the user runs `/reload-plugins`, then you run `crossfire doctor` again. Only report crossfire as ready when it prints **READY**.
