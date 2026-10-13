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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
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
