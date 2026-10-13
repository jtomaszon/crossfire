// Builder briefs (what the builder subagent reads) and validation of what it returns.
import { itemsOwed } from "./referee.mjs";

export const BUILD_STATUSES = ["DONE", "PARTIAL", "FAILED"];
export const FIX_STATUSES = ["FIXED", "DISPUTED", "WONTFIX"];

function where(e) {
  return e.file ? `${e.file}${e.lineStart ? `:${e.lineStart}${e.lineEnd && e.lineEnd !== e.lineStart ? `-${e.lineEnd}` : ""}` : ""}` : "(no location)";
}

function findingBlock(e) {
  return [
    `### ${e.id} · ${e.severity} · ${where(e)} · from ${e.reviewers.join(" + ")}`,
    `**${e.title}**`,
    "",
    e.body || "(no detail)",
    e.recommendation ? `\nReviewer's recommendation: ${e.recommendation}` : "",
  ].join("\n");
}

export const MIN_VARIANTS = 3;

/** One or more file:line cites, a line or a range, e.g. "lib/app.rb:120, spec/app_spec.rb:40-52". */
export const WHERE_RE = /^\s*[^\s,:]+:\d+(-\d+)?(\s*,\s*[^\s,:]+:\d+(-\d+)?)*\s*$/;

/** A `where` value: one or more file:line or file:start-end, lines from 1, ranges in order. */
export function validWhere(value) {
  const s = String(value ?? "");
  if (!WHERE_RE.test(s)) return false;
  return s.split(",").every((part) => {
    const [, a, b] = /:(\d+)(?:-(\d+))?\s*$/.exec(part.trim()) ?? [];
    const start = Number(a);
    const end = b === undefined ? start : Number(b);
    return start >= 1 && end >= start;
  });
}

/** Fixing a real (non-nit) finding must name the rule and test its variants. */
export function needsRule(entry) {
  return entry && entry.severity !== "NIT";
}

export function resultExample(owed) {
  return JSON.stringify(
    {
      status: "DONE",
      summary: "one or two sentences: what changed and why",
      commit: "<full sha of HEAD after your final commit>",
      tests: [{ name: "test_name_as_in_the_tree", command: "how to run it", passed: true }],
      fixes: owed.map((e) =>
        needsRule(e)
          ? {
              id: e.id,
              status: "FIXED",
              note: "what you changed",
              where: "lib/app.rb:120, spec/app_spec.rb:40-52",
              rule: "the broadest rule that still holds, e.g. 'a post-commit decision reads committed state, never the in-memory object'",
              variants: [
                { scenario: "the reported case", test: "test name in the tree" },
                { scenario: "another way the same rule breaks", test: "test name" },
                { scenario: "a third way", test: "test name" },
              ],
            }
          : { id: e.id, status: "FIXED", note: "what you changed, or why not" },
      ),
    },
    null,
    2,
  );
}

export const FAILURE_CATEGORIES = [
  "transactions, rollback and nested transactions (savepoints), callbacks that run after commit or rollback",
  "stale in-memory state: objects, caches or flags that do not match what was committed",
  "concurrency: two requests, jobs or processes at once; races between check and act",
  "retries and idempotency: the same job, webhook or request twice; partial failure halfway",
  "ordering: events, callbacks or jobs arriving in a different order, or not at all",
  "missing or unexpected data: nil, empty, deleted, archived, very large, other tenants",
  "the boundaries the spec names: limits, permissions, time, money, external services failing",
];

export function renderBrief(state, { resultFile, branch, failures, lessons = [] }) {
  const owed = itemsOwed(state);
  const kind = state.next.brief;
  const title = {
    initial: "Build the spec",
    fix: "Fix the review findings",
    g0: "Make the proof commands pass",
    nits: "Nit pass (no further review)",
    harden: "Harden against the breaker's attacks",
  }[kind];

  const out = [
    `# Crossfire builder brief: ${state.slug}, round ${state.round} of ${state.maxRounds}: ${title}`,
    "",
    "## Read first",
    `- The spec: \`${state.spec}\` (read all of it; it is the contract).`,
    ...(state.plan ? [`- The plan: \`${state.plan}\` (its tasks, the exact files each one touches, and its Review Focus: write those tests first).`] : []),
    `- Repository: \`${state.repo}\`, branch \`${branch ?? "current"}\`, compared against \`${state.base}\`.`,
    "- Any document the spec names, by the absolute path it gives.",
    "",
    "## Before you edit: depth first",
    "Inside a crossfire round, depth beats brevity. Any instruction elsewhere to keep reads brief or to delegate exploration applies to the main session, not to you.",
    "- Read every document the spec lists, in full, and the repository's own notes for this area (its CLAUDE.md or AGENTS.md usually has a topic map: follow it to the area's docs).",
    "- Read every file you will change in full, not line ranges, and the callers of every method you change.",
    "- Look for how the repository already solves the same problem (an existing callback, job, lock or pattern) before inventing one.",
    "- Before writing code, list for yourself how this change could fail (the spec's \"How this could fail\" section is the start, not the end), and write those tests first.",
    "",
    ...lessons,
    "",
    "## Rules for every round",
    "- Work only in this repository and branch. Never push, merge, rebase onto another branch, or force-push.",
    "- Test first: write or extend a failing test, then make it pass (superpowers:test-driven-development if it is available).",
    "- Every claim in your result maps to a named test that exists in the tree. A claim you cannot point to a test for does not go in the result.",
    "- Every shortcut fails closed. If something is unfinished, it refuses or errors loudly; it never silently succeeds.",
    "- Never edit, weaken, skip or delete an E2E test or invariant the spec defines. You may add tests.",
    "- Files the spec marks as owner-built get small targeted fixes only: no rewrites, restyling or restructuring.",
    "- Finish by committing everything (`git add -A && git commit`), so `git status` is clean. Reviewers only see committed work.",
  ];

  if (state.e2e.length || state.invariants.length) {
    out.push("", "## Commands crossfire runs itself after your round (gate G0)", "Your round only reaches review if all of these exit 0:");
    for (const c of [...state.e2e, ...state.invariants]) out.push(`- \`${c}\``);
  }

  if (kind === "initial") {
    out.push("", "## This round", "Build what the spec asks for, nothing more. Note adjacent work in the summary; do not do it.");
  }

  if (kind === "g0") {
    out.push("", "## This round", "The proof commands failed after your last round. Fix the code (not the tests) until they pass. Output:");
    for (const f of failures ?? []) out.push("", `### \`${f.command}\` exited ${f.status}`, "```", f.output, "```");
  }

  if (kind === "fix" || kind === "harden") {
    out.push(
      "",
      "## This round",
      kind === "harden"
        ? "An internal breaker attacked your round and proved each attack below with a failing test. The reviewers have not seen the branch yet: make these unbreakable first."
        : "The reviewers found the problems below.",
      "Each one is evidence of a rule being broken, not a list of lines to patch. For each one:",
      `1. Name the **broadest** rule that still holds. Not "re-check the flag after the second save" but "a post-commit decision reads committed state, never the in-memory object". A rule that only covers the cited case is too narrow: the next review will find the next case.`,
      `2. Write at least ${MIN_VARIANTS} variants of that rule being broken (the reported case plus other ways it can break), each as a test that fails before your fix.`,
      "3. Find every other place in the code that breaks the same rule mechanically (grep, AST, call graph), not just the line cited, and fix them all.",
      "",
      kind === "harden"
        ? "Answer every attack in `fixes`: FIXED (with `where`, the file:line of your fix, plus `rule` and `variants`), or DISPUTED with a concrete reason (the reviewers will see your reason and decide). WONTFIX is only allowed for NIT."
        : "Answer every finding in `fixes`: FIXED (with `where`, the file:line of your fix, plus `rule` and `variants`), or DISPUTED with your reason (that stops the loop and goes to the owner). WONTFIX is only allowed for NIT.",
      "",
      ...owed.map(findingBlock),
    );
  }

  if (kind === "nits") {
    out.push(
      "",
      "## This round",
      "Only nits are left. Fix each one, or mark it WONTFIX with a reason. There is no further review after this round: crossfire runs the proof commands and ships.",
      "",
      ...owed.map(findingBlock),
    );
  }

  out.push(
    "",
    "## Your result",
    `When you are done, write this JSON to \`${resultFile}\` (exactly this shape; \`fixes\` must answer ${owed.length ? owed.map((e) => e.id).join(", ") : "nothing this round, so leave it empty"}):`,
    "",
    "```json",
    resultExample(owed),
    "```",
    "",
    "`status` is DONE when the work is complete and committed, PARTIAL or FAILED otherwise (both stop the loop and go to the owner). Then reply with one line: the path of the result file.",
  );
  return `${out.join("\n")}\n`;
}

/**
 * Validate a builder result against the state and the repository.
 * `repoFacts` = { head, dirty: string[], ahead: number }
 * Returns a list of problems; empty means valid.
 */
export function validateBuildResult(result, state, repoFacts) {
  const problems = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) return ["the result is not a JSON object"];
  if (!BUILD_STATUSES.includes(result.status)) problems.push(`status must be one of ${BUILD_STATUSES.join(", ")}`);
  if (typeof result.summary !== "string" || !result.summary.trim()) problems.push("summary is required");
  if (!Array.isArray(result.tests)) problems.push("tests must be an array");
  else {
    result.tests.forEach((t, i) => {
      if (!t || typeof t.name !== "string" || !t.name.trim()) problems.push(`tests[${i}].name is required`);
      if (typeof t?.passed !== "boolean") problems.push(`tests[${i}].passed must be true or false`);
    });
  }
  const fixes = result.fixes ?? [];
  if (!Array.isArray(fixes)) problems.push("fixes must be an array");
  else {
    const owed = itemsOwed(state);
    const answered = new Map();
    fixes.forEach((f, i) => {
      if (!f || typeof f.id !== "string") return problems.push(`fixes[${i}].id is required`);
      if (!FIX_STATUSES.includes(f.status)) problems.push(`fixes[${i}].status must be one of ${FIX_STATUSES.join(", ")}`);
      const entry = state.ledger.find((e) => e.id === f.id);
      if (!entry) problems.push(`fixes[${i}].id ${f.id} is not a finding crossfire knows`);
      else if (f.status === "WONTFIX" && entry.severity !== "NIT") problems.push(`${f.id} is ${entry.severity}: WONTFIX is only for NIT (use DISPUTED with a reason)`);
      else if (f.status === "FIXED" && needsRule(entry)) {
        if (typeof f.rule !== "string" || f.rule.trim().length < 15) problems.push(`${f.id}: FIXED needs \`rule\`, the broadest rule the fix enforces (one sentence)`);
        const variants = Array.isArray(f.variants) ? f.variants.filter((v) => v && typeof v.test === "string" && v.test.trim()) : [];
        if (variants.length < MIN_VARIANTS) problems.push(`${f.id}: FIXED needs at least ${MIN_VARIANTS} \`variants\` of the rule, each with the \`test\` that covers it (got ${variants.length})`);
        if (!validWhere(f.where)) problems.push(`${f.id}: FIXED needs \`where\`, the file:line of the fix (e.g. "lib/app.rb:120" or "lib/app.rb:15-20"; several separated by commas; lines start at 1)`);
      }
      answered.set(f.id, f);
    });
    const missing = owed.filter((e) => !answered.has(e.id)).map((e) => e.id);
    if (missing.length) problems.push(`fixes must answer ${missing.join(", ")}`);
  }

  if (result.status === "DONE") {
    if (typeof result.commit !== "string" || !result.commit.trim()) problems.push("commit is required when status is DONE");
    else if (repoFacts.head && !repoFacts.head.startsWith(result.commit.trim())) problems.push(`commit ${result.commit} is not HEAD (${repoFacts.head})`);
    if (repoFacts.dirty.length) problems.push(`the working tree is not clean (${repoFacts.dirty.length} path(s), e.g. ${repoFacts.dirty[0]}); commit everything`);
    if (repoFacts.ahead < 1) problems.push(`no commits on top of ${state.base}; reviewers would see an empty diff`);
    if (Array.isArray(result.tests) && result.tests.some((t) => t && t.passed === false)) problems.push("a test in tests[] did not pass, so status cannot be DONE");
  }
  return problems;
}

// ---- breaker ---------------------------------------------------------------

export function renderBreakerBrief(state, { resultFile, branch, head, lessons = [] }) {
  const earlier = state.ledger.filter((e) => e.source !== "breaker");
  const out = [
    `# Crossfire breaker brief: ${state.slug}, round ${state.round}`,
    "",
    "You are the **breaker**. A builder just finished this round and its proof commands pass. Independent reviewers from another vendor will review the branch next. Your job is to find what they would find, first: **assume the change is wrong and prove it.**",
    "",
    "## What to read",
    `- The spec: \`${state.spec}\` (its acceptance criteria and its "How this could fail" section).`,
    `- The change: \`git diff ${state.baseSha}...HEAD\` in \`${state.repo}\` (branch \`${branch ?? "current"}\`, HEAD \`${head}\`). Read every changed file in full, and the code it calls and that calls it.`,
    ...(state.plan ? [`- The plan: \`${state.plan}\` (its Review Focus lists the failure modes the planner expected).`] : []),
    "- Do not read the builder's notes or result files: review the code cold.",
    ...lessons,
    "",
    "## How to attack",
    "Go through each category and try to construct a concrete scenario where the change does the wrong thing:",
    ...FAILURE_CATEGORIES.map((c) => `- ${c}`),
    "",
    "**Prove every attack with a failing test, and never change the branch:**",
    `1. Make a throwaway worktree: \`git -C ${state.repo} worktree add --detach "$(mktemp -d)/crossfire-breaker" HEAD\`.`,
    "2. Write the test there, with the repository's own test framework and conventions, and run it. It must fail because of the bug, not because of a typo or setup.",
    "3. Remove the worktree when done (`git worktree remove --force <path>`). Leave the real working tree exactly as you found it: no edits, no commits, no stashes.",
    "",
    "Report only attacks you proved with a failing test, each with the `file` and `line` the bug is at. Ideas you could not prove go in `summary`, one line each. One proven, real bug beats ten guesses.",
  ];
  if (earlier.length) {
    out.push("", "## Already found by the reviewers in earlier passes (do not report these again)", ...earlier.map((e) => `- [${e.id}] ${e.title} (${e.status})`));
  }
  out.push(
    "",
    "## Your result",
    `Write this JSON to \`${resultFile}\`, then reply with that path:`,
    "",
    "```json",
    JSON.stringify(
      {
        status: "DONE",
        summary: "what you tried, and unproven ideas (one line each)",
        attacks: [
          {
            title: "short statement of the bug",
            category: "transactions",
            severity: "BLOCKER or CHANGES",
            file: "path/to/file",
            line: 120,
            scenario: "the exact sequence that breaks it",
            rule: "the broadest rule the code breaks",
            test: "the test you wrote: its name and its code",
            command: "how you ran it",
            output: "the failing output (last lines)",
            proven: true,
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "`attacks` is empty when you could not break it. `status` is FAILED only if you could not do the job at all (say why in `summary`).",
  );
  return `${out.join("\n")}\n`;
}

/** Validate a breaker result: { problems, attacks } with only proven attacks, normalised. */
export function validateBreakerResult(result) {
  const problems = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) return { problems: ["the result is not a JSON object"], attacks: [] };
  if (!["DONE", "FAILED"].includes(result.status)) problems.push("status must be DONE or FAILED");
  if (!Array.isArray(result.attacks)) problems.push("attacks must be an array (empty if nothing broke)");
  const attacks = [];
  (Array.isArray(result.attacks) ? result.attacks : []).forEach((a, i) => {
    if (!a || a.proven !== true) return;
    for (const k of ["title", "scenario", "test", "file"]) {
      if (typeof a[k] !== "string" || !a[k].trim()) problems.push(`attacks[${i}].${k} is required for a proven attack`);
    }
    if (!Number.isInteger(a.line) || a.line < 1) problems.push(`attacks[${i}].line is required for a proven attack: the line the bug is at`);
    const line = Number.isInteger(a.line) ? a.line : null;
    attacks.push({
      title: String(a.title ?? "").trim(),
      category: a.category ?? null,
      severity: String(a.severity ?? "").toUpperCase() === "BLOCKER" ? "BLOCKER" : "CHANGES",
      file: a.file ?? null,
      lineStart: line,
      lineEnd: line,
      scenario: String(a.scenario ?? ""),
      rule: String(a.rule ?? ""),
      test: String(a.test ?? "").slice(0, 2000),
    });
  });
  return { problems, attacks: result.status === "FAILED" ? [] : attacks };
}
