// Small shared helpers: process execution, exit codes, errors. Node stdlib only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
 * Run `fn` holding `lock`: a file created exclusively (`tryCreate`) with `<pid> <hostname>` and the time.
 * It is held while its process is alive on this host, however old; a live holder is waited for up to
 * `waitMs`. Nothing takes a lock over: one whose process is gone, from another host or unreadable is
 * refused, naming `unlock`. The holder removes it only while it still holds the content it wrote.
 */
export function withFileLock(lock, fn, { waitMs = 0, busy = `${lock} is held`, unlock = "crossfire unlock", refuse = null } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const mine = `${process.pid} ${os.hostname()}\n${new Date().toISOString()}\n`;
  const deadline = Date.now() + waitMs;
  while (!tryCreate(lock, mine)) {
    const seen = readLock(lock); // never empty: a lock is created with its contents already in it
    if (!seen) continue; // released in between
    if (refuse) throw new CrossfireError(refuse(seen, describeLock(seen)), EXIT.ENVIRONMENT);
    if (!seen.alive || Date.now() >= deadline) {
      const fix = seen.alive ? `wait for it; if that process is stuck, stop it, then the person runs ${unlock}` : seen.here ? `nothing takes a lock over: if the person confirms no crossfire command is running, run ${unlock}` : !seen.parsed ? `nothing takes a lock over: if the person confirms no crossfire command is running, run ${unlock} (it removes an unreadable lock older than 60 seconds)` : `nothing takes a lock over, and ${unlock} removes only the lock of a gone process on this host: the person checks no crossfire command uses it and deletes ${lock} by hand`;
      throw new CrossfireError(`${busy}: ${describeLock(seen)}; ${fix}`, EXIT.ENVIRONMENT);
    }
    sleepMs(50);
  }
  try {
    return fn();
  } finally {
    if (readLock(lock)?.text === mine) fs.rmSync(lock, { force: true });
  }
}

/** A lock file's text, age, pid and host, and whether its process runs on this host (EPERM: it runs); null if none. */
export function readLock(file) {
  let text;
  let mtimeMs;
  try {
    const fd = fs.openSync(file, "r");
    try {
      ({ mtimeMs } = fs.fstatSync(fd));
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const m = /^([1-9]\d*) (\S+)(?:\n|$)/.exec(text);
  const here = Boolean(m) && m[2] === os.hostname();
  let alive = here;
  try {
    if (here) process.kill(Number(m[1]), 0);
  } catch (e) {
    alive = e.code === "EPERM";
  }
  return { file, text, ageMs: Date.now() - mtimeMs, pid: m ? Number(m[1]) : null, host: m?.[2] ?? null, parsed: Boolean(m), here, alive };
}

export function ageText(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function describeLock(seen) {
  const why = !seen.parsed ? "it cannot be read as `<pid> <hostname>`" : !seen.here ? `it was written on another host (${seen.host}), where this host cannot see whether its process runs` : `process ${seen.pid} on this host is ${seen.alive ? "running" : "gone"}`;
  return `${seen.file} (contents ${JSON.stringify(seen.text.trim())}, ${ageText(seen.ageMs)} old); ${why}`;
}

/** An unreadable lock (not `<pid> <hostname>`) older than this may be removed by unlock; a younger one may be a writer from before 1.5. */
export const UNREADABLE_LOCK_MS = 60_000;

/**
 * Remove `lock` only if it is still `judged` (same full contents) and that is the lock of a gone process
 * on this host, or an unreadable lock older than 60 seconds; returns it. The caller holds the unlock marker.
 */
export function unlockDead(lock, judged = readLock(lock)) {
  if (!judged) throw new CrossfireError(`no lock at ${lock}; nothing was removed`);
  const removable = (judged.here && !judged.alive) || (!judged.parsed && judged.ageMs > UNREADABLE_LOCK_MS);
  if (!removable) throw new CrossfireError(`${describeLock(judged)}; crossfire unlock removes only the lock of a gone process on this host, or an unreadable one older than 60 seconds; nothing was removed`);
  if (readLock(lock)?.text !== judged.text) throw new CrossfireError(`${lock} changed after it was judged; nothing was removed`);
  fs.rmSync(lock, { force: true });
  return judged;
}

/**
 * Create `file` holding `content`, atomically: it never exists empty or half-written. A uniquely named
 * temporary file next to it is written, then linked to `file` (which fails if it exists), then removed.
 * Returns false when `file` exists; any other error is thrown.
 */
export function tryCreate(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
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
