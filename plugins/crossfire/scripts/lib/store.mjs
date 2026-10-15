// Where a loop's files live: <repo>/.crossfire/runs/<slug>/ (specs in .crossfire/specs/).
// Inside the working tree, so Claude and the builder can write there without
// leaving the project, and listed in .git/info/exclude so it is never committed,
// never shows as uncommitted work, and never reaches a reviewer's diff.
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir, repoRoot } from "./git.mjs";
import { atomicWriteText, readJsonFile, withFileLock, CrossfireError, EXIT, SLUG_RE } from "./util.mjs";

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

// The state.json text each state object was read from or last saved as: a command records only
// over the state it read, never over one that changed under it (abandoned, restarted, archived).
const readAs = new WeakMap();

export function loadState(dir) {
  const file = files.state(dir);
  if (!fs.existsSync(file)) throw new CrossfireError(`no crossfire loop at ${dir}; start one with \`crossfire init\``);
  const text = fs.readFileSync(file, "utf8");
  const state = JSON.parse(text);
  readAs.set(state, text);
  return state;
}

export function saveState(dir, state) {
  const file = files.state(dir);
  if (readAs.has(state)) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (now !== readAs.get(state)) {
      let phase = "removed";
      try {
        phase = now === null ? phase : JSON.parse(now).phase;
      } catch {
        phase = "unreadable";
      }
      throw new CrossfireError(`the state of loop ${state.slug} changed while this command ran (now ${phase}); nothing was recorded. Run \`crossfire status --slug ${state.slug}\``, EXIT.TERMINAL);
    }
  }
  const text = `${JSON.stringify(state, null, 2)}\n`;
  atomicWriteText(file, text);
  readAs.set(state, text);
}

/** One crossfire command per loop at a time: held while its process runs, never taken over. */
export function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  return withFileLock(files.lock(dir), fn, { busy: "another crossfire command is running for this loop", unlock: `crossfire unlock --slug ${path.basename(dir)}` });
}

export function listRuns(cwd) {
  const root = runsRoot(cwd);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, "state.json")))
    .map((name) => readJsonFile(path.join(root, name, "state.json")));
}
