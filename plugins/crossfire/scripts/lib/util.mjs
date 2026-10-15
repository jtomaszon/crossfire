// Small shared helpers: process execution, exit codes, errors. Node stdlib only.
import { spawnSync } from "node:child_process";
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
 * Run `fn` holding `lock`, a file created exclusively. Retried for up to `waitMs`; a lock older
 * than `staleMs` (left by a crashed process) is moved aside and taken over. When it cannot be
 * taken in time, throws a CrossfireError with `lockBusy` set. Released only if still ours.
 */
export function withFileLock(lock, fn, { waitMs = 10_000, staleMs = 60_000 } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age > staleMs) {
      // Only one process can move it aside; if what it moved is fresh after all, it goes back.
      const aside = `${lock}.stale-${token}`;
      try {
        fs.renameSync(lock, aside);
      } catch {
        continue;
      }
      try {
        if (Date.now() - fs.statSync(aside).mtimeMs <= staleMs) fs.linkSync(aside, lock);
      } catch {
        /* someone else holds it now; retry */
      }
      fs.rmSync(aside, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const err = new CrossfireError(`${lock} is held by another crossfire process (waited ${Math.round(waitMs / 1000)} s)`, EXIT.ENVIRONMENT);
      err.lockBusy = true;
      throw err;
    }
    sleepMs(50);
  }
  try {
    return fn();
  } finally {
    let held = "";
    try {
      held = fs.readFileSync(lock, "utf8");
    } catch {
      /* already gone */
    }
    if (held === token) fs.rmSync(lock, { force: true });
  }
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
