#!/usr/bin/env node
// Stands in for `gh`. Without FAKE_GH_DIR it behaves like a gh that is not logged in.
// With it: repo is "acme/app"; PR state from <dir>/state (default OPEN); comments from
// <dir>/{comment,inline,review}.jsonl, one JSON object per line in the shape crossfire's
// --jq produces ({id, user, at, body, url}).
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
if (!dir) {
  process.stderr.write("To get started with GitHub CLI, please run: gh auth login\n");
  process.exit(4);
}
if (fs.existsSync(path.join(dir, "fail"))) {
  const msg = fs.readFileSync(path.join(dir, "fail"), "utf8").trim() || "HTTP 502: Bad Gateway (https://api.github.com/)";
  process.stderr.write(`${msg}\n`); // a transient outage
  process.exit(1);
}
fs.appendFileSync(path.join(dir, "calls.log"), `${args.join(" ")}\n`);
const read = (f, fallback = "") => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : fallback);
if (args[0] === "repo" && args[1] === "view") process.stdout.write("acme/app\n");
else if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid,state")) {
  const pr = JSON.parse(read("prs.json", "[]")).find((p) => String(p.number) === args[2]);
  const moved = read("moved-head", "").trim();
  process.stdout.write(JSON.stringify(pr ? { headRefOid: moved || pr.headRefOid, state: read("view-state", "").trim() || pr.state } : null));
} else if (args[0] === "pr" && args[1] === "view") process.stdout.write(`${read("state", "OPEN").trim()}\n`);
else if (args[0] === "pr" && args[1] === "list") process.stdout.write(read("prs.json", "[]"));
else if (args[0] === "api" && args[1].includes("/check-runs")) process.stdout.write(read("check-runs.jsonl"));
else if (args[0] === "api" && /\/commits\/[^/]+\/status/.test(args[1])) process.stdout.write(read("statuses.jsonl"));
else if (args[0] === "api") {
  const endpoint = args[1];
  const kind = endpoint.endsWith("/reviews") ? "review" : endpoint.includes("/pulls/") ? "inline" : "comment";
  process.stdout.write(read(`${kind}.jsonl`));
} else {
  process.stderr.write(`fake-gh: unexpected ${args.join(" ")}\n`);
  process.exit(2);
}
