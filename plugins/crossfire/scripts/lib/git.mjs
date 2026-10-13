// Git queries the loop depends on. All read-only.
import path from "node:path";
import { run, CrossfireError, EXIT } from "./util.mjs";

function git(cwd, args) {
  const r = run("git", args, { cwd });
  if (r.error?.code === "ENOENT") throw new CrossfireError("git is not installed", EXIT.ENVIRONMENT);
  return r;
}

export function repoRoot(cwd) {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) throw new CrossfireError(`not inside a git repository: ${cwd}`, EXIT.USAGE);
  return r.stdout.trim();
}

/** The shared .git directory (the same for every worktree of a repository). */
export function gitCommonDir(cwd) {
  const r = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (r.status !== 0) throw new CrossfireError(`not inside a git repository: ${cwd}`, EXIT.USAGE);
  return path.resolve(cwd, r.stdout.trim());
}

export function head(cwd) {
  const r = git(cwd, ["rev-parse", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function branch(cwd) {
  const r = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function resolveRef(cwd, ref) {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Uncommitted changes, untracked files included. Empty array means clean. */
export function dirtyPaths(cwd) {
  const r = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (r.status !== 0) return ["<git status failed>"];
  return r.stdout.split("\n").filter(Boolean);
}

export function commitsAhead(cwd, base) {
  const r = git(cwd, ["rev-list", "--count", `${base}..HEAD`]);
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

export function changedFiles(cwd, base) {
  const r = git(cwd, ["diff", "--name-only", `${base}...HEAD`]);
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

/** Default base: the remote default branch if known, else main, else master. */
export function defaultBase(cwd) {
  const sym = git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (sym.status === 0) return sym.stdout.trim().replace(/^refs\/remotes\//, "");
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    if (resolveRef(cwd, candidate)) return candidate;
  }
  return null;
}
