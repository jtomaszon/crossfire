// The owner's rulings: questions settled by the person who owns the repository, one dated
// line each, so builders, the breaker and reviewers stop raising them again. Kept in
// <git common dir>/crossfire/precedents.md: shared by every worktree, never committed.
// Added only by `crossfire precedent add`, which the loop skill runs only on the person's
// explicit words.
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir } from "./git.mjs";
import { CrossfireError, withFileLock } from "./util.mjs";

export const PRECEDENTS_IN_PROMPTS = 30;
export const PRECEDENT_MAX_CHARS = 500;
export const PRECEDENTS_HEADING = "Settled by the owner; do not raise these again";
const HEADER = "# Settled by the owner\n\nRulings added with `crossfire precedent add`; local only, never committed. Newest last.\n";

export function precedentsFile(cwd) {
  return path.join(gitCommonDir(cwd), "crossfire", "precedents.md");
}

/** The latest `max` rulings, oldest first, each "- YYYY-MM-DD · ruling". */
export function readPrecedents(cwd, max = PRECEDENTS_IN_PROMPTS) {
  const file = precedentsFile(cwd);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- ")).slice(-max);
}

/** Append one ruling as one dated line. Refuses an empty ruling or one over 500 characters. */
export function appendPrecedent(cwd, ruling, date = new Date().toISOString().slice(0, 10)) {
  const text = String(ruling ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new CrossfireError("the ruling is empty: crossfire precedent add \"<the person's ruling, in one sentence>\"");
  if (text.length > PRECEDENT_MAX_CHARS) throw new CrossfireError(`the ruling is ${text.length} characters; keep it to one sentence of at most ${PRECEDENT_MAX_CHARS}`);
  const file = precedentsFile(cwd);
  const line = `- ${date} · ${text}`;
  try {
    withFileLock(`${file}.lock`, () => {
      if (!fs.existsSync(file)) fs.writeFileSync(file, `${HEADER}\n`);
      const current = fs.readFileSync(file, "utf8");
      fs.appendFileSync(file, `${current.endsWith("\n") ? "" : "\n"}${line}\n`);
    });
  } catch (e) {
    if (e.lockBusy) throw new CrossfireError(`the precedent was not added: ${e.message}; run crossfire precedent add again`, e.exitCode);
    throw e;
  }
  return line;
}

/** The block a builder or breaker brief includes (markdown), empty when there are none. */
export function precedentsBlock(cwd, max = PRECEDENTS_IN_PROMPTS) {
  const lines = readPrecedents(cwd, max);
  if (!lines.length) return [];
  return ["", `## ${PRECEDENTS_HEADING}`, ...lines];
}

/** The lines a reviewer focus includes, empty when there are none. */
export function precedentsFocus(lines = []) {
  if (!lines.length) return [];
  return ["", `${PRECEDENTS_HEADING}:`, ...lines.slice(-PRECEDENTS_IN_PROMPTS)];
}
