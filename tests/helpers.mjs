// Test sandbox: a throwaway git repo, fake `claude` CLI and fake official reviewer plugins.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const CLI = path.join(ROOT, "plugins", "crossfire", "scripts", "crossfire.mjs");
const FIX = path.join(here, "fixtures");

export function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function gitc(cwd, ...args) {
  return sh(cwd, "git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
}

export const OFFICIAL_MARKETS = [
  { name: "openai-codex", source: "github", repo: "openai/codex-plugin-cc" },
  { name: "xai-grok-build", source: "github", repo: "xai-org/grok-build-plugin-cc" },
  { name: "claude-plugins-official", source: "github", repo: "anthropics/claude-plugins-official" },
];

/**
 * Build a sandbox. `opts.plugins` overrides the plugin list; `opts.markets` the marketplaces;
 * `opts.grok` false leaves Grok Build out.
 */
export function sandbox(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crossfire-test-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  sh(repo, "git", ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "app.txt"), "v1\n");
  gitc(repo, "add", "-A");
  gitc(repo, "commit", "-q", "-m", "base");
  sh(repo, "git", ["switch", "-q", "-c", "feature"]);

  const spec = path.join(tmp, "spec.md");
  fs.writeFileSync(spec, "# Spec\n\nWhen the app starts, it shall print v2.\n\n## How this could fail\n\n- the file is missing\n- two writers at once\n- a stale cached value\n");

  const reviewDir = path.join(tmp, "reviews");
  fs.mkdirSync(reviewDir);
  const install = (name, script) => {
    const dir = path.join(tmp, "plugins", name, "scripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(FIX, "fake-reviewer.mjs"), path.join(dir, script));
    fs.writeFileSync(path.join(reviewDir, `${name}-queue.json`), "[]");
    return path.dirname(dir);
  };
  const codexRoot = install("codex", "codex-companion.mjs");
  const grokRoot = install("grok", "grok-bridge.mjs");

  const plugins = opts.plugins ?? [
    { id: "codex@openai-codex", version: "1.0.6", scope: "user", enabled: true, installPath: codexRoot },
    ...(opts.grok === false ? [] : [{ id: "grok-build@xai-grok-build", version: "0.2.1", scope: "user", enabled: true, installPath: grokRoot }]),
    { id: "superpowers@claude-plugins-official", version: "5.0.0", scope: "user", enabled: true, installPath: path.join(tmp, "plugins", "superpowers") },
  ];
  const pluginsFile = path.join(tmp, "plugins.json");
  const marketsFile = path.join(tmp, "markets.json");
  fs.writeFileSync(pluginsFile, JSON.stringify(plugins));
  fs.writeFileSync(marketsFile, JSON.stringify(opts.markets ?? OFFICIAL_MARKETS));

  const env = {
    ...process.env,
    CROSSFIRE_CLAUDE_BIN: path.join(FIX, "fake-claude.mjs"),
    FAKE_CLAUDE_PLUGINS: pluginsFile,
    FAKE_CLAUDE_MARKETS: marketsFile,
    FAKE_REVIEW_DIR: reviewDir,
    CROSSFIRE_ASSUME_BWRAP: "1",
    CROSSFIRE_ASSUME_CODEX_SANDBOX: "1",
    CROSSFIRE_STATE_DIR: path.join(tmp, "state"), // never the real per-machine reviewer health
    CROSSFIRE_GH_BIN: path.join(FIX, "fake-gh.mjs"), // a gh that is not logged in, unless FAKE_GH_DIR is set
    ...(opts.env ?? {}),
  };

  return {
    tmp,
    repo,
    spec,
    codexRoot,
    grokRoot,
    env,
    /** Queue review answers (objects in the shared schema, or raw strings) for a reviewer. */
    queue(name, ...answers) {
      const file = path.join(reviewDir, `${name}-queue.json`);
      const q = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify([...q, ...answers]));
    },
    calls(name) {
      const file = path.join(reviewDir, `${name}-calls.jsonl`);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    },
    cf(...args) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
    },
    /** Commit a change and write the builder result the brief asks for. */
    build(resultFile, { fixes = [], status = "DONE", content = "v2\n", tests = [{ name: "test_prints_v2", command: "true", passed: true }], commit = true } = {}) {
      if (commit) {
        fs.writeFileSync(path.join(repo, "app.txt"), `${content}${Math.random()}\n`);
        gitc(repo, "add", "-A");
        gitc(repo, "commit", "-q", "-m", "round");
      }
      const head = sh(repo, "git", ["rev-parse", "HEAD"]);
      const full = fixes
        .map((f) => (f.status === "FIXED" && f.rule === undefined ? { ...f, rule: "every write goes through the one versioned writer", variants: [{ scenario: "a", test: "t_a" }, { scenario: "b", test: "t_b" }, { scenario: "c", test: "t_c" }] } : f))
        .map((f) => (f.status === "FIXED" && f.where === undefined ? { ...f, where: "app.txt:1" } : f));
      fs.writeFileSync(resultFile, JSON.stringify({ status, summary: "did the thing", commit: head, tests, fixes: full }));
    },
    cleanup() {
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export const approve = { verdict: "approve", summary: "Looks right.", findings: [], next_steps: [] };

export function finding(severity, title, file = "app.txt", line = 1) {
  return { severity, title, body: `${title} (body)`, file, line_start: line, line_end: line, confidence: 0.9, recommendation: "fix it" };
}

export function needs(...findings) {
  return { verdict: "needs-attention", summary: "Problems found.", findings, next_steps: [] };
}
