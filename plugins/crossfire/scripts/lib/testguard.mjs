// The builder never weakens tests: existing test files are not changed unless the approved spec
// allows it, and new tests go in new files. Read from the branch diff against the loop's base (with
// rename detection), not from what the builder says.
import { run } from "./util.mjs";

/**
 * A test file, by its name only: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*.py`, or any
 * file under a `__tests__/` directory. Helpers and fixtures are not test files.
 */
export function isTestFile(file) {
  const parts = String(file ?? "").split("/").filter(Boolean);
  if (!parts.length) return false;
  const name = parts.at(-1);
  if (parts.slice(0, -1).includes("__tests__")) return true;
  return /^.+(?:\.test|_test|\.spec|_spec)\..+$/.test(name) || /^test_.+\.py$/.test(name);
}

// Calls that skip or focus tests, also taken by reference (`const later = test.skip`). A
// `{ skip: <condition> }` option is not one of them.
const SKIP_RE = /\.(?:skip|only)\b|\bx(?:it|describe)\b|@pytest\.mark\.skip|@unittest\.skip|@Disabled|\bt\.Skip(?:Now|f)?\(/;

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

const firstLine = (r) => (r.stderr || `exit ${r.status}`).trim().split("\n")[0];

/** [{ status, old, new }] from `git diff -M --name-status -z`, or { error } when git fails. */
function changedEntries(repo, range) {
  const r = git(repo, ["diff", "-M", "--name-status", "-z", "--no-ext-diff", range]);
  if (r.status !== 0) return { error: firstLine(r) };
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
  if (r.status !== 0) return { error: firstLine(r) };
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
  }
  return { removed, added };
}

/** The blob id of `file` at `rev`, or { error }. */
function blob(repo, rev, file) {
  const r = git(repo, ["rev-parse", "--verify", "-q", `${rev}:${file}`]);
  return r.status === 0 ? { id: r.stdout.trim() } : { error: firstLine(r) };
}

const quote = (t) => JSON.stringify(t.length > 120 ? `${t.slice(0, 117)}...` : t);

/**
 * Every way the branch weakens tests against `baseSha`: an existing test file (one on the base)
 * that is deleted, renamed to a name that is not a test file, or changed in any line; and a skip or
 * focus call in a new test file. Files the spec's "## Allowed test changes" section names are
 * exempt. { problems: string[] }; a diff that cannot be read is a problem too (fail closed).
 */
export function testChanges(repo, baseSha, specText) {
  const range = `${baseSha}...HEAD`;
  const listed = changedEntries(repo, range);
  if (listed.error) return { problems: [`could not read the branch diff to check the test files (${listed.error}); nothing is accepted until it can be read`] };
  const allowed = new Set(allowedTestFiles(specText));
  const problems = [];
  let mergeBase;
  const findMergeBase = () => {
    if (mergeBase === undefined) {
      const mb = git(repo, ["merge-base", baseSha, "HEAD"]);
      mergeBase = mb.status === 0 ? mb.stdout.trim() : null;
    }
    return mergeBase;
  };
  for (const e of listed.entries) {
    const oldTest = Boolean(e.old) && e.status !== "A" && e.status !== "C" && isTestFile(e.old);
    const newTest = Boolean(e.new) && isTestFile(e.new);
    if (!oldTest && !newTest) continue;
    if (allowed.has(e.old) || allowed.has(e.new)) continue;
    if (oldTest) {
      // An existing test file: not deleted, not renamed away, not changed in any byte.
      if (e.status === "D") {
        problems.push(`${e.old}: deletes a test file`);
        continue;
      }
      if (!newTest) {
        problems.push(`${e.old} -> ${e.new}: renames a test file to a name that is not a test file`);
        continue;
      }
      const mb = findMergeBase();
      if (!mb) {
        problems.push(`${e.new}: could not find the merge base to compare it with the base`);
        continue;
      }
      const before = blob(repo, mb, e.old);
      const after = blob(repo, "HEAD", e.new);
      if (before.error || after.error) {
        problems.push(`${e.new}: could not read it to compare with the base (${before.error ?? after.error})`);
        continue;
      }
      if (before.id === after.id) continue; // a rename with no content change, or a mode change
      const lines = fileLines(repo, range, [...new Set([e.old, e.new])]);
      const renamed = e.new !== e.old ? ` (renamed to ${e.new})` : "";
      const found = [];
      if (!lines.error) {
        for (const l of lines.removed) found.push(`${e.old}:${l.line}: removes a line from an existing test file${renamed}: ${quote(l.text)}`);
        for (const l of lines.added) found.push(`${e.new}:${l.line}: adds a line to an existing test file: ${quote(l.text)}`);
      }
      problems.push(...(found.length ? found : [`${e.new}: changes an existing test file${renamed}`]));
      continue;
    }
    // A new test file (added, or renamed or copied from a file that was not a test file): every
    // line in it is new as test code, so none may skip or focus tests.
    const shown = git(repo, ["show", `HEAD:${e.new}`]);
    if (shown.status !== 0) {
      problems.push(`${e.new}: could not read it to check for skip or focus calls (${firstLine(shown)})`);
      continue;
    }
    shown.stdout.split("\n").forEach((text, i) => {
      if (skipCallIn(text)) problems.push(`${e.new}:${i + 1}: adds a skip or focus call: ${quote(text)}`);
    });
  }
  return { problems };
}
