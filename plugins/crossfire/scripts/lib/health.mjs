// Two small judgments crossfire makes about the environment, not the code:
// 1. Reviewer health across loops on this machine, so a reviewer that keeps
//    failing (e.g. a sandbox that cannot start) is visible in `doctor` and reports.
// 2. Whether a failing proof command failed because it cannot run here at all
//    (wrong toolchain, missing binary) rather than because the code is wrong.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson } from "./util.mjs";

const KEEP = 20; // most recent attempts kept per reviewer

/** Per machine, outside every repository: never committed. */
export function healthFile(env = process.env) {
  if (env.CROSSFIRE_STATE_DIR) return path.join(env.CROSSFIRE_STATE_DIR, "reviewers.json");
  const base = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state");
  return path.join(base, "crossfire", "reviewers.json");
}

export function readHealth(file = healthFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Record one reviewer attempt. Errors are cut to one line; no code or findings are stored. */
export function recordAttempt(reviewer, { ok, at, seconds, error }, file = healthFile()) {
  const health = readHealth(file);
  const list = health[reviewer] ?? [];
  list.push({ ok, at, seconds, error: ok ? undefined : String(error ?? "").split("\n")[0].slice(0, 300) });
  health[reviewer] = list.slice(-KEEP);
  try {
    atomicWriteJson(file, health);
  } catch {
    /* health is advisory; never fail a review over it */
  }
}

/** { attempts, consecutiveFailures, lastError, lastOkAt } for a reviewer. */
export function summarize(health, reviewer) {
  const list = health[reviewer] ?? [];
  let consecutiveFailures = 0;
  for (let i = list.length - 1; i >= 0 && !list[i].ok; i -= 1) consecutiveFailures += 1;
  const lastFail = [...list].reverse().find((a) => !a.ok);
  const lastOk = [...list].reverse().find((a) => a.ok);
  return { attempts: list.length, consecutiveFailures, lastError: lastFail?.error ?? null, lastFailAt: lastFail?.at ?? null, lastOkAt: lastOk?.at ?? null };
}

export const AUTO_SKIP_FAILURES = 3;
export const AUTO_SKIP_DAYS = 7;

/**
 * `--grok auto` on a host where the reviewer keeps failing: its last 3 attempts on this machine
 * all failed and the latest failure is under 7 days old. Returns { failures, line } (skip it,
 * without calling it), or null (call it). Skips are never recorded as attempts, so the 7 days run out.
 */
export function autoSkip(health, reviewer, now = Date.now()) {
  const s = summarize(health, reviewer);
  if (s.consecutiveFailures < AUTO_SKIP_FAILURES) return null;
  const last = Date.parse(s.lastFailAt ?? "");
  if (!Number.isFinite(last) || now - last >= AUTO_SKIP_DAYS * 24 * 60 * 60 * 1000) return null;
  return {
    failures: s.consecutiveFailures,
    line: `${reviewer}: skipped (failed the last ${s.consecutiveFailures} times on this machine; crossfire doctor shows why; it is tried again after ${AUTO_SKIP_DAYS} days or with --${reviewer} on)`,
  };
}

// Output that means the command could not run in this environment at all.
// Deliberately narrow: a missing spec file ("cannot load such file") is NOT here,
// because the builder may be about to create it.
const ENV_PATTERNS = [
  /command not found/i,
  /: not found$/m,
  /No such file or directory.*(?:\/bin\/|exec|bundle|node|python|ruby|go|cargo|npm|yarn|pnpm)/i,
  /Could not find '[^']+' \([^)]+\) required by your .*Gemfile\.lock/i,
  /Gem::GemNotFoundException/,
  /rbenv: version `[^']+' is not installed/i,
  /mise .*(?:not installed|missing)/i,
  /asdf: No version is set/i,
  /executable file not found in \$PATH/i,
  /Unknown command|unknown command/,
  /permission denied.*(?:exec|\/bin\/)/i,
];

/**
 * "environment" when a failed proof command could not run here at all, else "code".
 * Exit 126/127 (cannot execute / not found) always count as environment.
 */
export function classifyProofFailure({ status, output }) {
  if (status === 126 || status === 127) return "environment";
  const text = String(output ?? "");
  return ENV_PATTERNS.some((re) => re.test(text)) ? "environment" : "code";
}

/** On macOS, Grok's review sandbox has refused to start when the Docker socket is a symlink (Docker Desktop, OrbStack). */
export function grokSocketHint(platform = process.platform) {
  if (platform !== "darwin") return null;
  try {
    const target = fs.readlinkSync("/var/run/docker.sock");
    return `/var/run/docker.sock is a symlink to ${target} (Docker Desktop or OrbStack); Grok Build's sandbox has refused to start in this setup ("socket deny resolution failed")`;
  } catch {
    return null;
  }
}
