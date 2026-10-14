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
  const hunks = [];
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
      hunks.push({ removed: 0, added: [] });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) {
      removed.push({ line: oldLine++, text: line.slice(1) });
      hunks.at(-1).removed += 1;
    } else if (line.startsWith("+")) {
      const a = { line: newLine++, text: line.slice(1) };
      added.push(a);
      hunks.at(-1).added.push(a);
    }
    else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { removed, added, hunks };
}

// ---- Growth that disables existing lines ------------------------------------------------
// Lines added to an existing test file may add code, but not change whether its existing lines
// run: every existing line keeps its text outside comments and strings and its bracket depth (so
// no added comment, string, heredoc or block wraps it), no unconditional exit is added before
// existing lines, and no assertion API is rebound. Only source files are parsed; fixture data is
// not code. A lexer per language family, not a parser: it finds these by how the file reads.

const JS_EXT = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"]);
const C_LIKE_EXT = new Set([...JS_EXT, "java", "kt", "kts", "scala", "cs", "swift", "go", "rs", "php", "c", "cc", "cpp", "cxx", "h", "hpp", "m", "mm", "dart", "groovy"]);
const HASH_EXT = new Set(["py", "rb", "sh", "bash", "pl", "r", "ex", "exs", "cr", "jl", "coffee"]);

/** How to read a source file's comments and strings, or null for a file that is not code. */
export function codeMode(file) {
  const name = String(file ?? "").split("/").at(-1);
  const ext = name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
  if (C_LIKE_EXT.has(ext)) return { lineComment: "//", blockComment: true, backtick: JS_EXT.has(ext) || ext === "go", singleQuote: ext !== "rs", triple: false, rubyBlock: false, regex: JS_EXT.has(ext), depth: true };
  if (HASH_EXT.has(ext)) return { lineComment: "#", blockComment: false, backtick: false, singleQuote: true, triple: ext === "py", rubyBlock: ext === "rb", regex: ext === "rb", depth: ext === "py" };
  return null;
}

const OPEN = { "(": ")", "[": "]", "{": "}" };

// A slash starts a regular expression (not a division) after an operator, an opening bracket, a
// separator, a keyword like return, or at the start of the line.
function regexMayStart(maskedSoFar) {
  const before = maskedSoFar.join("").trimEnd();
  if (!before) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(before)) return true;
  return /\b(?:return|typeof|case|do|else|in|of|void|yield|await|throw|delete|new)$/.test(before);
}
const CLOSE = new Set([")", "]", "}"]);

/**
 * Scan lines as one fragment of code: { selfContained, lines: [{ masked, depth[] }] }. `masked` is
 * the line with comments and strings blanked; `depth[i]` is the bracket depth (from the fragment's
 * start) at column i. Single- and double-quoted strings end with their line.
 */
export function scanFragment(lines, mode) {
  let stack = [];
  let bad = false;
  let inBlock = false;
  let inTriple = null;
  let inBacktick = false;
  let inRuby = false;
  const heredocs = [];
  const out = [];
  for (const text of lines) {
    const startDepth = stack.length;
    const masked = [];
    const depth = [];
    const blank = (n) => {
      for (let k = 0; k < n; k += 1) {
        masked.push(" ");
        depth.push(stack.length);
      }
    };
    if (heredocs.length) {
      // Inside a Ruby heredoc: text, up to the line that is its terminator.
      if (text.trim() === heredocs[0]) heredocs.shift();
      blank(text.length);
      out.push({ masked: masked.join(""), depth, startDepth });
      continue;
    }
    if (mode.rubyBlock && (inRuby || /^=begin\b/.test(text))) {
      inRuby = !/^=end\b/.test(text);
      blank(text.length);
      out.push({ masked: masked.join(""), depth, startDepth });
      continue;
    }
    let i = 0;
    while (i < text.length) {
      if (inBlock) {
        const end = text.indexOf("*/", i);
        if (end === -1) {
          blank(text.length - i);
          i = text.length;
        } else {
          blank(end + 2 - i);
          i = end + 2;
          inBlock = false;
        }
        continue;
      }
      if (inTriple) {
        const end = text.indexOf(inTriple, i);
        if (end === -1) {
          blank(text.length - i);
          i = text.length;
        } else {
          blank(end + 3 - i);
          i = end + 3;
          inTriple = null;
        }
        continue;
      }
      if (inBacktick) {
        let j = i;
        while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
        if (j >= text.length) {
          blank(text.length - i);
          i = text.length;
        } else {
          blank(j + 1 - i);
          i = j + 1;
          inBacktick = false;
        }
        continue;
      }
      const ch = text[i];
      if (text.startsWith(mode.lineComment, i)) {
        blank(text.length - i);
        break;
      }
      if (mode.blockComment && text.startsWith("/*", i)) {
        inBlock = true;
        blank(2);
        i += 2;
        continue;
      }
      if (mode.triple && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        inTriple = text.slice(i, i + 3);
        blank(3);
        i += 3;
        continue;
      }
      if (mode.backtick && ch === "`") {
        inBacktick = true;
        blank(1);
        i += 1;
        continue;
      }
      if (mode.regex && ch === "/" && regexMayStart(masked)) {
        // A JavaScript regular expression literal: to its closing slash (outside a [class]) on this line.
        let j = i + 1;
        let cls = false;
        while (j < text.length && (cls || text[j] !== "/")) {
          if (text[j] === "\\") j += 1;
          else if (text[j] === "[") cls = true;
          else if (text[j] === "]") cls = false;
          j += 1;
        }
        const end = Math.min(j + 1, text.length);
        blank(end - i);
        i = end;
        continue;
      }
      if (ch === '"' || (ch === "'" && mode.singleQuote)) {
        let j = i + 1;
        while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
        const end = Math.min(j + 1, text.length);
        blank(end - i);
        i = end;
        continue;
      }
      if (OPEN[ch]) {
        masked.push(ch);
        depth.push(stack.length);
        stack.push(OPEN[ch]);
      } else if (CLOSE.has(ch)) {
        if (stack.at(-1) === ch) stack.pop();
        else {
          bad = true;
          stack = [];
        }
        masked.push(ch);
        depth.push(stack.length);
      } else {
        masked.push(ch);
        depth.push(stack.length);
      }
      i += 1;
    }
    const code = masked.join("");
    if (mode.rubyBlock) for (const m of text.matchAll(/<<[~-]?(['"]?)([A-Za-z_]\w*)\1/g)) if (code[m.index] === "<") heredocs.push(m[2]);
    out.push({ masked: code, depth, startDepth });
  }
  return { selfContained: !bad && !stack.length && !inBlock && !inTriple && !inBacktick && !inRuby && !heredocs.length, lines: out };
}

const indentOf = (t) => /^\s*/.exec(t)[0].replace(/\t/g, "    ").length;
const EXIT_RE = /\b(?:return|throw|raise|continue|break)\b|\b(?:process\.exit|sys\.exit|os\.Exit|exit)\s*\(/g;
// What may precede an exit on its line and still leave it unconditional (or behind a constant).
const UNCONDITIONAL_BEFORE = /^(?:|.*[;{}]|.*\belse\s*:?|if\s*\(\s*(?:true|1|!0|!false)\s*\)|if\s+(?:True|1|not\s+False)\s*:)$/;
const CLOSERS_ONLY = /^[\s)\]};,]*$|^\s*end\b/;

/** Exits at the fragment's own top level that are unconditional: [{ index, text }]. */
function topLevelExits(lines, scan, mode) {
  const exitRe = mode.rubyBlock ? new RegExp(`${EXIT_RE.source}|\\bnext\\b`, "g") : EXIT_RE;
  const indents = lines.filter((t) => t.trim()).map(indentOf);
  const min = indents.length ? Math.min(...indents) : 0;
  const exits = [];
  scan.lines.forEach(({ masked, depth }, idx) => {
    if (!lines[idx].trim() || indentOf(lines[idx]) !== min) return;
    for (const m of masked.matchAll(exitRe)) {
      if (depth[m.index] !== 0) continue;
      if (UNCONDITIONAL_BEFORE.test(masked.slice(0, m.index).trim())) {
        exits.push({ index: idx, text: lines[idx] });
        break;
      }
    }
  });
  return exits;
}

// Rebinding or patching an assertion API (`assert.equal = ...`, `Object.assign(assert, ...)`,
// `self.assertEqual = ...`); `const assert = require(...)` and `await import(...)` are imports.
const REBIND_RE = /(?:^|[^.\w$])(?:assert|expect|should)(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])*\s*=(?![=>])(?!\s*(?:require\s*\(|await\s+import\s*\())|\.assert\w*\s*=(?![=>])|\b(?:Object\.(?:assign|defineProperty|defineProperties|setPrototypeOf)|mock\.method|jest\.spyOn|sinon\.(?:stub|replace))\s*\(\s*(?:assert|expect)\b/;

export function rebindsAssertion(line) {
  return REBIND_RE.test(String(line ?? ""));
}

function showFile(repo, rev, file) {
  const r = git(repo, ["show", `${rev}:${file}`]);
  return r.status === 0 ? { lines: r.stdout.split("\n") } : { error: (r.stderr || `exit ${r.status}`).trim().split("\n")[0] };
}

/**
 * Problems with how an existing test file grew from `oldFile` at `mergeBase` to `file` at HEAD.
 * Every line it kept must keep its place: the same text outside comments and strings, at the same
 * bracket depth. That holds however git aligns the added lines.
 */
function growthProblems(repo, { mergeBase, oldFile, file, removed, added, hunks }) {
  const problems = [];
  const mode = codeMode(file);
  if (!mode || !added.length) return problems;
  for (const l of added) if (rebindsAssertion(scanFragment([l.text], mode).lines[0].masked)) problems.push(`${file}:${l.line}: rebinds an assertion API: ${quote(l.text)}`);
  if (removed.length) return problems; // a file that lost lines is flagged already
  const before = showFile(repo, mergeBase, oldFile);
  const after = showFile(repo, "HEAD", file);
  if (before.error || after.error) return [...problems, `${file}: could not read it to check its added lines (${before.error ?? after.error})`];
  const oldScan = scanFragment(before.lines, mode).lines;
  const newScan = scanFragment(after.lines, mode).lines;
  const gone = new Set(removed.map((l) => l.line - 1));
  const fresh = new Set(added.map((l) => l.line - 1));
  for (let i = 0, j = 0; i < before.lines.length && j < after.lines.length; i += 1, j += 1) {
    while (gone.has(i)) i += 1;
    while (fresh.has(j)) j += 1;
    if (i >= before.lines.length || j >= after.lines.length) break;
    const o = oldScan[i];
    const n = newScan[j];
    if (o.masked !== n.masked || (mode.depth && o.startDepth !== n.startDepth)) {
      problems.push(`${file}:${j + 1}: added lines put an existing line inside a comment, string or block it was not in: ${quote(after.lines[j])}`);
      break; // one per file: the rest follow from it
    }
  }
  for (const h of hunks) {
    if (!h.added.length) continue;
    const texts = h.added.map((l) => l.text);
    const exit = topLevelExits(texts, scanFragment(texts, mode), mode)[0];
    if (!exit) continue;
    let next = h.added.at(-1).line; // 0-based index of the line after the hunk
    while (next < after.lines.length && !after.lines[next].trim()) next += 1;
    const following = after.lines[next];
    if (following === undefined || CLOSERS_ONLY.test(following) || indentOf(following) < indentOf(exit.text)) continue;
    problems.push(`${file}:${h.added[exit.index].line}: adds an exit before existing test code: ${quote(exit.text)}`);
  }
  return problems;
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
  let mergeBase;
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
    // ...and what it grows by may not stop its existing lines from running.
    if (oldTest && newTest && e.status !== "A") {
      if (mergeBase === undefined) {
        const mb = git(repo, ["merge-base", baseSha, "HEAD"]);
        mergeBase = mb.status === 0 ? mb.stdout.trim() : null;
      }
      if (!mergeBase) problems.push(`${shown}: could not find the merge base to check its added lines`);
      else problems.push(...growthProblems(repo, { mergeBase, oldFile: e.old, file: e.new, ...lines }));
    }
  }
  return { problems };
}
