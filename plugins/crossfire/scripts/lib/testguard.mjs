// The builder never weakens tests: existing test files may only grow. Read from the branch
// diff against the loop's base (with rename detection), not from what the builder says.
import { run } from "./util.mjs";

const TEST_DIRS = new Set(["test", "tests", "spec", "__tests__"]);

/** A path under a test/, tests/, spec/ or __tests__/ directory, or named *_test.*, *.test.*, *.spec.* or *_spec.*. */
export function isTestFile(file) {
  const parts = String(file ?? "").split("/").filter(Boolean);
  if (!parts.length) return false;
  const name = parts.at(-1);
  if (parts.slice(0, -1).some((d) => TEST_DIRS.has(d))) return true;
  return /^.+(?:_test|\.test|\.spec|_spec)\.[^./]+$/.test(name);
}

// Calls that skip or focus tests. A `{ skip: <condition> }` option is not one of them.
const SKIP_RE = /\.skip\(|\.only\(|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|@unittest\.skip|@Disabled|\bt\.Skip\(/;

export function skipCallIn(line) {
  return SKIP_RE.test(String(line ?? ""));
}

/** The files the spec's "## Allowed test changes" section names (backticked, or a bare list item). */
export function allowedTestFiles(specText) {
  const lines = String(specText ?? "").split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s*allowed test changes\b/i.test(l.trim()));
  if (start === -1) return [];
  const out = new Set();
  const clean = (p) => p.trim().replace(/^\.\//, "");
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l)) break;
    const ticks = [...l.matchAll(/`([^`]+)`/g)].map((m) => clean(m[1]));
    if (ticks.length) ticks.forEach((p) => out.add(p));
    else {
      const bare = /^\s*(?:[-*]|\d+[.)])\s+(\S+)/.exec(l)?.[1];
      if (bare) out.add(clean(bare.replace(/[:,;]$/, "")));
    }
  }
  return [...out].filter(Boolean);
}

function git(repo, args) {
  return run("git", ["-c", "core.quotePath=false", ...args], { cwd: repo });
}

/** [{ status, old, new }] from `git diff -M --name-status -z`, or null when git fails. */
function changedEntries(repo, range) {
  const r = git(repo, ["diff", "-M", "--name-status", "-z", "--no-ext-diff", range]);
  if (r.status !== 0) return { error: (r.stderr || `exit ${r.status}`).trim().split("\n")[0] };
  const tokens = r.stdout.split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (!status) {
      i += 1;
      continue;
    }
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      entries.push({ status: letter, old: tokens[i + 1], new: tokens[i + 2] });
      i += 3;
    } else {
      entries.push({ status: letter, old: letter === "A" ? null : tokens[i + 1], new: letter === "D" ? null : tokens[i + 1] });
      i += 2;
    }
  }
  return { entries };
}

/** Removed and added lines of one file (or one renamed pair), with their line numbers. */
function fileLines(repo, range, paths) {
  const r = git(repo, ["diff", "-M", "--unified=0", "--no-color", "--no-ext-diff", range, "--", ...paths]);
  if (r.status !== 0) return { error: (r.stderr || `exit ${r.status}`).trim().split("\n")[0] };
  const removed = [];
  const added = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      inHunk = true;
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) removed.push({ line: oldLine++, text: line.slice(1) });
    else if (line.startsWith("+")) added.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { removed, added };
}

const quote = (t) => JSON.stringify(t.length > 120 ? `${t.slice(0, 117)}...` : t);

/**
 * Every way the branch weakens tests against `baseSha`: a deleted test file (or one moved out of
 * the test paths), a removed line in an existing test file, an added skip or focus call. Files the
 * spec's "## Allowed test changes" section names are exempt. { problems: string[] }; a diff that
 * cannot be read is a problem too (fail closed).
 */
export function testChanges(repo, baseSha, specText) {
  const range = `${baseSha}...HEAD`;
  const listed = changedEntries(repo, range);
  if (listed.error) return { problems: [`could not read the branch diff to check the test files (${listed.error}); nothing is accepted until it can be read`] };
  const allowed = new Set(allowedTestFiles(specText));
  const problems = [];
  for (const e of listed.entries) {
    const oldTest = Boolean(e.old) && isTestFile(e.old);
    const newTest = Boolean(e.new) && isTestFile(e.new);
    if (!oldTest && !newTest) continue;
    if (allowed.has(e.old) || allowed.has(e.new)) continue;
    if (e.status === "D") {
      problems.push(`${e.old}: deletes a test file`);
      continue;
    }
    if (e.status === "R" && oldTest && !newTest) {
      problems.push(`${e.old} -> ${e.new}: moves a test file out of the test paths`);
      continue;
    }
    const paths = [...new Set([e.old, e.new].filter(Boolean))];
    const lines = fileLines(repo, range, paths);
    if (lines.error) {
      problems.push(`${e.new ?? e.old}: could not read its diff (${lines.error})`);
      continue;
    }
    const shown = e.new ?? e.old;
    // A test file that existed on the base may only grow.
    const renamed = e.new && e.new !== e.old ? ` (renamed to ${e.new})` : "";
    if (oldTest && e.status !== "A") for (const l of lines.removed) problems.push(`${e.old}:${l.line}: removes a line from an existing test file${renamed}: ${quote(l.text)}`);
    if (newTest) for (const l of lines.added) if (skipCallIn(l.text)) problems.push(`${shown}:${l.line}: adds a skip or focus call: ${quote(l.text)}`);
  }
  return { problems };
}
