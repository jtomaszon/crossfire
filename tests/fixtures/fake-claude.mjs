#!/usr/bin/env node
// Stands in for the `claude` CLI: answers `plugin list --json` and
// `plugin marketplace list --json` from files named in the environment.
import fs from "node:fs";

const args = process.argv.slice(2).join(" ");
const read = (envName) => fs.readFileSync(process.env[envName], "utf8");
if (args === "plugin list --json") process.stdout.write(read("FAKE_CLAUDE_PLUGINS"));
else if (args === "plugin marketplace list --json") process.stdout.write(read("FAKE_CLAUDE_MARKETS"));
else {
  process.stderr.write(`fake-claude: unexpected args: ${args}\n`);
  process.exit(2);
}
