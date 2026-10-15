// Small shared helpers: process execution, exit codes, errors. Node stdlib only.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  MALFORMED: 3, // re-ask the agent; the loop state did not advance
  TERMINAL: 4, // the loop already shipped or escalated
  ENVIRONMENT: 5, // a required tool (git, codex) is missing or failed
});

export class CrossfireError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message);
    this.name = "CrossfireError";
    this.exitCode = exitCode;
  }
}

/** Run a command without a shell. Never throws on a non-zero exit. */
export function run(cmd, args = [], options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

/** Run a user-declared shell command (E2E or invariant). */
export function runShell(command, options = {}) {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  return run(shell, args, options);
}

export function tail(text, maxChars = 4000) {
  const s = String(text ?? "");
  return s.length <= maxChars ? s : `[... ${s.length - maxChars} chars cut ...]\n${s.slice(-maxChars)}`;
}

export function atomicWriteJson(file, value) {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `fn` holding `lock`, a file created exclusively with a unique token. Retried for up to `waitMs`.
 * A lock older than `staleMs` (left by a crashed process) is taken over. Whoever creates the claim file
 * `<lock>.takeover-<id of that lock>` is the only process that may remove that lock: its holder
 * releasing it, or one waiter that re-checks the claimed lock is still the exact one it judged stale.
 * Nothing else ever moves or removes a lock. When it cannot be taken in time, throws a
 * CrossfireError with `lockBusy` set (`busyMessage` replaces the default text).
 */
export function withFileLock(lock, fn, { waitMs = 10_000, staleMs = 60_000, busyMessage } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (createExclusive(lock, token)) break;
    const seen = peekLock(lock);
    let claimed = null;
    if (seen && Date.now() - seen.mtimeMs > staleMs) {
      const claim = claimFile(lock, seen);
      if (createExclusive(claim, token)) {
        try {
          const now = peekLock(lock); // nobody else may remove it while we hold its claim
          if (now && now.text === seen.text && now.mtimeMs === seen.mtimeMs) fs.rmSync(lock, { force: true });
        } finally {
          fs.rmSync(claim, { force: true });
        }
        continue;
      }
      claimed = claim;
    }
    if (Date.now() >= deadline) {
      const why = claimed ? `; it is stale and ${claimed} claims it (a takeover or release that did not finish): if no crossfire process is running, remove both files` : "";
      const err = new CrossfireError(`${busyMessage ?? `${lock} is held by another crossfire process (waited ${Math.round(waitMs / 1000)} s)`}${why}`, EXIT.ENVIRONMENT);
      err.lockBusy = true;
      throw err;
    }
    sleepMs(50);
  }
  try {
    return fn();
  } finally {
    const claim = claimFile(lock, { text: token });
    // If a waiter holds our claim, our lock went stale and that waiter removes it.
    if (createExclusive(claim, token)) {
      try {
        if (peekLock(lock)?.text === token) fs.rmSync(lock, { force: true });
      } finally {
        fs.rmSync(claim, { force: true });
      }
    }
  }
}

function createExclusive(file, text) {
  try {
    fs.writeFileSync(file, text, { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

/** Content and mtime of one and the same lock file, or null when there is none. */
function peekLock(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    const { mtimeMs } = fs.fstatSync(fd);
    return { text: fs.readFileSync(fd, "utf8"), mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function claimFile(lock, { text, mtimeMs }) {
  const id = crypto.createHash("sha256").update(text ? text : `empty ${mtimeMs}`).digest("hex").slice(0, 16);
  return `${lock}.takeover-${id}`;
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function nowIso(clock = Date.now) {
  return new Date(clock()).toISOString();
}

export function minutesBetween(startIso, clock = Date.now) {
  return (clock() - Date.parse(startIso)) / 60000;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
