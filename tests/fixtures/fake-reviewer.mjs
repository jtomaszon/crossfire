#!/usr/bin/env node
// Stands in for codex-companion.mjs / grok-bridge.mjs. Each call is logged to
// <queue dir>/<name>-calls.jsonl; review answers are popped from <name>-queue.json.
import fs from "node:fs";
import path from "node:path";

const name = path.basename(path.dirname(path.dirname(process.argv[1]))); // <name>/scripts/<script>
const dir = process.env.FAKE_REVIEW_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, `${name}-calls.jsonl`), `${JSON.stringify(argv)}\n`);

if (argv[0] === "setup" || argv[0] === "check") {
  process.stdout.write(JSON.stringify({ ready: process.env[`FAKE_${name.toUpperCase()}_READY`] !== "0", nextSteps: ["Run `codex login`."] }));
  process.exit(0);
}
if (process.env.FAKE_REVIEW_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_REVIEW_DELAY_MS));
// Test hook: commit in the repository while "reviewing", as another process might.
if (process.env.FAKE_REVIEW_COMMIT_IN) {
  const { execFileSync } = await import("node:child_process");
  const repo = process.env.FAKE_REVIEW_COMMIT_IN;
  fs.appendFileSync(path.join(repo, "moved.txt"), "x\n");
  execFileSync("git", ["-c", "user.name=M", "-c", "user.email=m@example.com", "commit", "-qam", "moved during review", "--allow-empty"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=M", "-c", "user.email=m@example.com", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=M", "-c", "user.email=m@example.com", "commit", "-qm", "moved during review (2)", "--allow-empty"], { cwd: repo });
}
const queueFile = path.join(dir, `${name}-queue.json`);
const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
const next = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (next === undefined) {
  process.stderr.write("fake-reviewer: queue empty\n");
  process.exit(1);
}
if (typeof next === "string") {
  process.stdout.write(next); // raw (possibly broken) output
  process.exit(next.startsWith("{") ? 0 : 1);
}
process.stdout.write(JSON.stringify({ review: "Adversarial Review", result: next, parseError: null }));
