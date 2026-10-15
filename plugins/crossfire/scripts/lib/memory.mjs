// Per-repository memory: the kinds of problems reviewers and the breaker found here
// before, one line each, so the next builder and breaker start from them instead of
// cold. Kept in <git common dir>/crossfire/memory.md: shared by every worktree of the
// repository, never committed, written only by the crossfire script. Rules and titles
// only: no code, no diffs.
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir } from "./git.mjs";
import { atomicWriteText, withFileLock } from "./util.mjs";

const MAX_LINES = 200;
const HEADER = "# What reviewers found in this repository\n\nWritten by crossfire after each loop and check; local only, never committed. Newest last.\n";

export function memoryFile(cwd) {
  return path.join(gitCommonDir(cwd), "crossfire", "memory.md");
}

function key(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
}

/** The lines of the memory file (without the header), oldest first. */
export function readLessons(cwd, max = 30) {
  const file = memoryFile(cwd);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- "));
  return lines.slice(-max);
}

/**
 * Append lessons, skipping ones whose rule/title is already there. Each entry:
 * { date, severity, file, lesson, source } where lesson is the broadest rule the fix
 * enforced (preferred) or the finding's title.
 */
export function appendLessons(cwd, entries) {
  if (!entries.length) return 0;
  const file = memoryFile(cwd);
  try {
    return withFileLock(`${file}.lock`, () => appendLocked(file, entries));
  } catch (e) {
    if (!e.lockBusy) throw e;
    process.stderr.write(`crossfire: WARNING: memory not updated: ${e.message}\n`); // advisory
    return 0;
  }
}

function appendLocked(file, entries) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- ")) : [];
  const seen = new Set(existing.map((l) => key(l.split(" · ").slice(3).join(" · ").replace(/\s*\([^)]*\)\s*$/, ""))));
  const added = [];
  for (const e of entries) {
    const lesson = String(e.lesson ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!lesson || seen.has(key(lesson))) continue;
    seen.add(key(lesson));
    const where = e.file ? String(e.file).split("/").slice(-3).join("/") : "-";
    added.push(`- ${e.date} · ${e.severity} · ${where} · ${lesson} (${e.source})`);
  }
  if (!added.length) return 0;
  const all = [...existing, ...added].slice(-MAX_LINES);
  atomicWriteText(file, `${HEADER}\n${all.join("\n")}\n`);
  return added.length;
}

/** Lessons from a finished loop: fixed findings with the rule the builder named, else the title. */
export function lessonsFromLoop(state) {
  const date = (state.terminal?.at ?? new Date().toISOString()).slice(0, 10);
  return state.ledger
    .filter((e) => e.severity !== "NIT")
    .map((e) => {
      const rule = [...(e.history ?? [])].reverse().find((h) => h.rule)?.rule;
      return { date, severity: e.severity, file: e.file, lesson: rule || e.title, source: `${e.reviewers.join("+")}, loop ${state.slug}` };
    });
}

/** Lessons from a review-only check: reported, not yet fixed, so marked as such. */
export function lessonsFromCheck(check) {
  const date = check.at.slice(0, 10);
  return check.findings
    .filter((f) => f.severity !== "NIT")
    .map((f) => ({ date, severity: f.severity, file: f.file, lesson: f.title, source: `${f.reviewers.join("+")}, reported in check ${check.id}` }));
}

/** The block a brief includes. */
export function lessonsBlock(cwd, max = 30) {
  const lines = readLessons(cwd, max);
  if (!lines.length) return [];
  return [
    "",
    "## What reviewers found in this repository before",
    "Earlier loops and reviews here found these kinds of problems. Check whether this change could have any of them, and test for the ones that apply:",
    ...lines,
  ];
}
