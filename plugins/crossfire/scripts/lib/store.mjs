// Where a loop's files live: <repo>/.crossfire/runs/<slug>/ (specs in .crossfire/specs/).
// Inside the working tree, so Claude and the builder can write there without
// leaving the project, and listed in .git/info/exclude so it is never committed,
// never shows as uncommitted work, and never reaches a reviewer's diff.
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir, repoRoot } from "./git.mjs";
import { atomicWriteJson, readJsonFile, CrossfireError, EXIT, SLUG_RE } from "./util.mjs";

export const EXCLUDE_LINE = "/.crossfire/";

/** Make sure .crossfire/ is ignored by git for every worktree of the repository. */
export function ensureExcluded(cwd) {
  const file = path.join(gitCommonDir(cwd), "info", "exclude");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, `${sep}# crossfire loop files (never committed)\n${EXCLUDE_LINE}\n`);
}

export function crossfireRoot(cwd) {
  return path.join(repoRoot(cwd), ".crossfire");
}

export function runsRoot(cwd) {
  return path.join(crossfireRoot(cwd), "runs");
}

export function runDir(cwd, slug) {
  if (!SLUG_RE.test(slug)) throw new CrossfireError(`invalid slug "${slug}": use lowercase letters, digits, ".", "_" or "-" (max 64)`);
  return path.join(runsRoot(cwd), slug);
}

export const files = {
  state: (dir) => path.join(dir, "state.json"),
  brief: (dir, round, kind) => path.join(dir, `brief-r${round}-${kind}.md`),
  result: (dir, round, kind) => path.join(dir, `build-r${round}-${kind}.json`),
  review: (dir, pass, reviewer) => path.join(dir, `review-p${pass}-${reviewer}.json`),
  g0: (dir, round) => path.join(dir, `g0-r${round}.log`),
  breakerBrief: (dir, round) => path.join(dir, `breaker-r${round}.md`),
  breakerResult: (dir, round) => path.join(dir, `breaker-r${round}.json`),
  report: (dir) => path.join(dir, "report.md"),
  specSnapshot: (dir) => path.join(dir, "spec-approved.md"),
  lock: (dir) => path.join(dir, ".lock"),
};

export function loadState(dir) {
  const file = files.state(dir);
  if (!fs.existsSync(file)) throw new CrossfireError(`no crossfire loop at ${dir}; start one with \`crossfire init\``);
  return readJsonFile(file);
}

export function saveState(dir, state) {
  atomicWriteJson(files.state(dir), state);
}

/** One crossfire command per loop at a time. A lock older than 2 hours is stale. */
export function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = files.lock(dir);
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 2 * 60 * 60 * 1000) throw new CrossfireError(`another crossfire command is running for this loop (${lock}); wait for it`, EXIT.ENVIRONMENT);
    fs.writeFileSync(lock, String(process.pid));
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function listRuns(cwd) {
  const root = runsRoot(cwd);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, "state.json")))
    .map((name) => readJsonFile(path.join(root, name, "state.json")));
}
