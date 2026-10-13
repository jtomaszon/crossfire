// Find the official reviewer plugins through Claude Code itself, and refuse
// anything that did not come from the vendor's own marketplace repository.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./util.mjs";

function onPath(bin, envPath = process.env.PATH ?? "") {
  return envPath.split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, bin)));
}

/**
 * The environment to run a reviewer plugin's script with. Sessions started by
 * launchers (desktop app, daemons) often lack the shell PATH the vendor's
 * installer edited, so when `grok` is not on PATH, point xAI's plugin at the
 * installer's standard location through GROK_BINARY (which the plugin documents).
 */
export function reviewerEnv(key, env = process.env) {
  if (key !== "grok" || env.GROK_BINARY || onPath("grok", env.PATH)) return env;
  const home = env.HOME || os.homedir();
  const candidates = [path.join(home, ".grok", "bin", "grok"), path.join(home, ".local", "bin", "grok")];
  const found = candidates.find((c) => fs.existsSync(c));
  return found ? { ...env, GROK_BINARY: found } : env;
}

export const OFFICIAL = Object.freeze({
  codex: {
    key: "codex",
    label: "OpenAI Codex",
    id: "codex@openai-codex",
    marketplace: "openai-codex",
    repo: "openai/codex-plugin-cc",
    script: "scripts/codex-companion.mjs",
    reviewCommand: "adversarial-review",
    readyCommand: ["setup", "--json"],
    minVersion: "1.0.6",
    required: true,
    install: [
      "npm install -g @openai/codex",
      "codex login",
      "claude plugin marketplace add openai/codex-plugin-cc",
      "claude plugin install codex@openai-codex",
    ],
  },
  grok: {
    key: "grok",
    label: "xAI Grok Build",
    id: "grok-build@xai-grok-build",
    marketplace: "xai-grok-build",
    repo: "xai-org/grok-build-plugin-cc",
    script: "scripts/grok-bridge.mjs",
    reviewCommand: "critique",
    readyCommand: ["check", "--json"],
    minVersion: "0.2.0",
    required: false,
    install: [
      "install the Grok Build CLI from xAI and log in, so `grok models` works (Grok Build needs an xAI plan that includes the Grok Build CLI; on a free plan it stops after a review or two (usage limit))",
      "claude plugin marketplace add xai-org/grok-build-plugin-cc",
      "claude plugin install grok-build@xai-grok-build",
    ],
  },
  superpowers: {
    key: "superpowers",
    label: "superpowers",
    id: "superpowers@claude-plugins-official",
    marketplace: "claude-plugins-official",
    repo: "anthropics/claude-plugins-official",
    script: null,
    minVersion: null,
    required: false,
    install: ["claude plugin install superpowers@claude-plugins-official"],
  },
});

export function claudeBin() {
  return process.env.CROSSFIRE_CLAUDE_BIN || "claude";
}

function claudeJson(args) {
  const r = run(claudeBin(), args, { timeoutMs: 60_000 });
  if (r.error?.code === "ENOENT") return { ok: false, error: "the `claude` CLI is not on PATH" };
  if (r.status !== 0) return { ok: false, error: `\`claude ${args.join(" ")}\` failed: ${r.stderr.trim() || r.status}` };
  try {
    return { ok: true, value: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, error: `\`claude ${args.join(" ")}\` did not return JSON` };
  }
}

/** -1, 0 or 1. Compares the leading numeric x.y.z only (a "-<commit>" suffix is ignored). */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? "0").replace(/^v/, "").split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function sameRepo(entry, repo) {
  const want = repo.toLowerCase();
  const fields = [entry.repo, entry.url, entry.source?.repo, entry.source?.url].filter(Boolean).map((s) => String(s).toLowerCase());
  return fields.some((f) => f === want || f.replace(/\.git$/, "").endsWith(`github.com/${want}`) || f.replace(/\.git$/, "").endsWith(`:${want}`));
}

/**
 * Locate every official plugin crossfire knows about. Each result:
 * { key, found, official, enabled, version, versionOk, root, script, problems[] }
 */
export function locatePlugins() {
  const list = claudeJson(["plugin", "list", "--json"]);
  const markets = claudeJson(["plugin", "marketplace", "list", "--json"]);
  const out = {};
  for (const spec of Object.values(OFFICIAL)) {
    const res = { key: spec.key, label: spec.label, required: spec.required, found: false, official: false, enabled: false, version: null, versionOk: false, root: null, script: null, problems: [] };
    out[spec.key] = res;
    if (!list.ok) {
      res.problems.push(list.error);
      continue;
    }
    const entry = (Array.isArray(list.value) ? list.value : []).find((p) => p.id === spec.id);
    if (!entry) {
      const impostor = (Array.isArray(list.value) ? list.value : []).find((p) => String(p.id).split("@")[0] === spec.id.split("@")[0]);
      if (impostor) res.problems.push(`found ${impostor.id}, which is not the official ${spec.id}; crossfire only uses the vendor's own plugin`);
      continue;
    }
    res.found = true;
    res.enabled = entry.enabled !== false;
    res.version = entry.version ?? null;
    res.root = entry.installPath ?? null;
    const market = markets.ok ? (Array.isArray(markets.value) ? markets.value : []).find((m) => m.name === spec.marketplace) : null;
    if (!markets.ok) res.problems.push(markets.error);
    else if (!market) res.problems.push(`marketplace ${spec.marketplace} is not registered`);
    else if (!sameRepo(market, spec.repo)) res.problems.push(`marketplace ${spec.marketplace} points at ${market.repo ?? market.url ?? "an unknown source"}, not the official ${spec.repo}`);
    else res.official = true;
    if (!res.enabled) res.problems.push(`${spec.id} is installed but disabled`);
    res.versionOk = !spec.minVersion || compareVersions(res.version, spec.minVersion) >= 0;
    if (!res.versionOk) res.problems.push(`${spec.id} ${res.version} is older than the tested ${spec.minVersion}`);
    if (spec.script) {
      const script = res.root ? path.join(res.root, spec.script) : null;
      if (script && fs.existsSync(script)) res.script = script;
      else res.problems.push(`${spec.script} not found under ${res.root ?? "the install path"}`);
    }
  }
  // The crossfire install Claude Code knows about, to spot a session still running an older one.
  const self = list.ok && Array.isArray(list.value) ? list.value.find((p) => String(p.id).startsWith("crossfire@")) : null;
  out.installedSelf = self ? { id: self.id, version: self.version ?? null } : null;
  return out;
}

export function usable(plugin) {
  return plugin.found && plugin.official && plugin.enabled && plugin.versionOk && (plugin.script !== null || OFFICIAL[plugin.key].script === null);
}

/** Ask the vendor's own readiness check (node + CLI + login). */
export function readiness(plugin, cwd) {
  const spec = OFFICIAL[plugin.key];
  if (!plugin.script || !spec.readyCommand) return { ready: plugin.found, detail: null };
  const r = run(process.execPath, [plugin.script, ...spec.readyCommand, "--cwd", cwd], { cwd, env: reviewerEnv(plugin.key), timeoutMs: 120_000 });
  try {
    const report = JSON.parse(r.stdout);
    return { ready: Boolean(report.ready), detail: report };
  } catch {
    return { ready: false, detail: { error: (r.stderr || r.stdout).trim().slice(0, 500) } };
  }
}

/** One line when the running crossfire is not the installed one (an old session), else null. */
export function versionSkew(running, installed) {
  if (!installed?.version || !running || compareVersions(running, installed.version) === 0) return null;
  return `this session runs crossfire ${running}, but ${installed.id} ${installed.version} is installed: run /reload-plugins (or start a new session) to use it`;
}
