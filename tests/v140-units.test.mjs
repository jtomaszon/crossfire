// 1.4.0 units: Grok's auto skip on a broken host, the test guard, SPEC_MISMATCH, precedents,
// spec-review focus and status, size. The CLI-level tests are in v140-cli.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { autoSkip } from "../plugins/crossfire/scripts/lib/health.mjs";
import { isTestFile, skipCallIn, allowedTestFiles, testChanges } from "../plugins/crossfire/scripts/lib/testguard.mjs";
import { BUILD_STATUSES, validateBuildResult, renderBrief, renderBreakerBrief } from "../plugins/crossfire/scripts/lib/briefs.mjs";
import { ACTIONS, afterBuild, afterReview, newState } from "../plugins/crossfire/scripts/lib/referee.mjs";
import { buildFocus, buildCheckFocus } from "../plugins/crossfire/scripts/lib/reviewers.mjs";
import { buildSpecFocus, specReviewStatus, riskHigh, diffSize, sha256 } from "../plugins/crossfire/scripts/lib/specreview.mjs";
import { appendPrecedent, precedentsFile, readPrecedents, precedentsBlock } from "../plugins/crossfire/scripts/lib/precedents.mjs";
import { renderReport, statusLine } from "../plugins/crossfire/scripts/lib/report.mjs";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-14T12:00:00Z");
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const fail = (msAgo) => ({ ok: false, at: iso(msAgo), seconds: 1, error: "sandbox could not start" });
const ok = (msAgo) => ({ ok: true, at: iso(msAgo), seconds: 1 });

// The skip and focus calls the guard looks for, built so this file does not contain them literally.
const SKIP = "." + "skip(";
const ONLY = "." + "only(";

const BIG = Array.from({ length: 12 }, (_, i) => `test('t${i + 1}', () => assert.equal(${i + 1}, ${i + 1}));\n`).join("");

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crossfire-guard-"));
  const g = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write("tests/app.test.mjs", "test('a', () => {\n  assert.equal(1, 1);\n  assert.equal(2, 2);\n});\n");
  write("src/app.mjs", "export const a = 1;\nexport const b = 2;\n");
  write("tests/big.test.mjs", BIG);
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  g("switch", "-qc", "feature");
  const commit = () => {
    g("add", "-A");
    g("commit", "-qm", "change", "--allow-empty");
  };
  return { dir, base, write, g, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---- R3: Grok on a broken host ------------------------------------------------

test("AC-8: Grok's last 3 attempts failed, the latest under 7 days ago: auto skips it, with the reason", () => {
  const s = autoSkip({ grok: [ok(30 * DAY), fail(3 * DAY), fail(2 * DAY), fail(1 * DAY)] }, "grok", now);
  assert.equal(s.failures, 3);
  assert.equal(s.line, "grok: skipped (failed the last 3 times on this machine; crossfire doctor shows why; it is tried again after 7 days or with --grok on)");
});

test("FM-3: 3 failures older than 7 days do not skip; 2 failures do not skip; one success resets; another reviewer's failures do not count", () => {
  assert.equal(autoSkip({ grok: [fail(9 * DAY), fail(8 * DAY), fail(7 * DAY + 1000)] }, "grok", now), null, "older than 7 days");
  assert.equal(autoSkip({ grok: [fail(2 * DAY), fail(1 * DAY)] }, "grok", now), null, "only 2");
  assert.equal(autoSkip({ grok: [fail(4 * DAY), fail(3 * DAY), fail(2 * DAY), ok(1 * DAY)] }, "grok", now), null, "a success resets");
  assert.equal(autoSkip({ grok: [fail(5 * DAY), fail(4 * DAY), ok(3 * DAY), fail(2 * DAY), fail(1 * DAY)] }, "grok", now), null, "only the failures after the success count");
  assert.equal(autoSkip({ codex: [fail(3 * DAY), fail(2 * DAY), fail(1 * DAY)] }, "grok", now), null, "codex's failures are not grok's");
  assert.equal(autoSkip({}, "grok", now), null, "no history");
  assert.equal(autoSkip({ grok: [fail(3 * DAY), fail(2 * DAY), { ok: false, at: "garbage" }] }, "grok", now), null, "an unreadable latest time is not a recent failure");
});

// ---- R4: tests are not weakened -------------------------------------------------

test("AC-9: a test file is known by its name only; helpers and fixtures are not test files", () => {
  for (const p of ["spec/models/user_spec.rb", "src/__tests__/a.js", "pkg/a_test.go", "src/a.test.ts", "src/a.spec.js", "lib/a_spec.rb", "tests/test_app.py", "test_x.py", "a.test.ts.snap"]) assert.ok(isTestFile(p), p);
  for (const p of ["src/app.mjs", "tests/a.mjs", "tests/helpers.mjs", "tests/fixtures/fake.mjs", "deep/tests/fixtures/f.json", "test/x.rb", "testing/a.js", "docs/spec.md", "latest/a.js", "contest.js", "tests", "test_x.rb", "__tests__"]) assert.ok(!isTestFile(p), p);
});

test("AC-9: skip and focus calls are found; a { skip: condition } option is not", () => {
  // Assembled from parts: written out, these lines would trip the guard on this repository's own tests.
  const k = (...parts) => parts.join("");
  for (const line of [`test${SKIP}"x", () => {})`, `describe${ONLY}"x", () => {})`, k("  x", "it('x', () => {})"), k("x", "describe('x')"), k("@pytest.mark.", "skip(reason='x')"), k("@pytest", ".mark.skipif(True)"), k("@unittest.", "skip('x')"), k("  @Dis", "abled"), k("\tt", ".Skip(\"later\")")]) assert.ok(skipCallIn(line), line);
  for (const line of ['test("x", { skip: process.platform !== "linux" }, () => {})', "process.exit(1)", "const skipped = 0;", "it('x', () => {})"]) assert.ok(!skipCallIn(line), line);
});

test("AC-9: the spec's Allowed test changes section names files", () => {
  const spec = "# S\n\n## Allowed test changes\n\n- `tests/old.test.mjs`: replaced by tests/new.test.mjs\n- spec/legacy_spec.rb\n\n## Out of bounds\n\n- `tests/never.test.mjs`\n";
  assert.ok(allowedTestFiles(spec).includes("tests/old.test.mjs"));
  assert.ok(allowedTestFiles(spec).includes("spec/legacy_spec.rb"));
  assert.ok(!allowedTestFiles(spec).includes("tests/never.test.mjs"), "only the section's own lines");
  assert.deepEqual(allowedTestFiles("# S\n"), []);
});

test("FM-4: a deleted test file and a removed assertion are flagged with file and line", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  r.write("tests/app.test.mjs", "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  r.commit();
  let res = testChanges(r.dir, r.base, "");
  assert.equal(res.problems.length, 1, JSON.stringify(res));
  assert.match(res.problems[0], /^tests\/app\.test\.mjs:3: removes a line from an existing test file: "  assert\.equal\(2, 2\);"/);
  fs.rmSync(path.join(r.dir, "tests/app.test.mjs"));
  r.commit();
  res = testChanges(r.dir, r.base, "");
  assert.deepEqual(res.problems, ["tests/app.test.mjs: deletes a test file"]);
});

test("FM-4: a new skip or focus call is flagged: as a change in an existing test file, and in a new test file", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  r.write("tests/app.test.mjs", `test('a', () => {\n  assert.equal(1, 1);\n  assert.equal(2, 2);\n});\ntest${SKIP}'b', () => {});\n`);
  r.write("tests/new.test.mjs", `describe${ONLY}'n', () => {});\n`);
  r.commit();
  const res = testChanges(r.dir, r.base, "");
  assert.deepEqual(res.problems.sort(), [`tests/app.test.mjs:5: adds a line to an existing test file: "test${SKIP}'b', () => {});"`, `tests/new.test.mjs:1: adds a skip or focus call: "describe${ONLY}'n', () => {});"`].sort());
});

test("FM-4: a rename with no content change, a non-test file, a { skip: condition } option and a new test file all pass", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  r.g("mv", "tests/app.test.mjs", "tests/renamed.test.mjs");
  r.write("src/app.mjs", "export const a = 3;\n");
  r.write("tests/linux.test.mjs", 'test("x", { skip: process.platform !== "linux" }, () => {});\n');
  r.commit();
  const res = testChanges(r.dir, r.base, "");
  assert.deepEqual(res.problems, []);
});

test("FM-4: a test file renamed to a name that is not a test file counts as deleted; a renamed file with a removed line is flagged", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  r.g("mv", "tests/app.test.mjs", "src/app-check.mjs");
  r.commit();
  assert.deepEqual(testChanges(r.dir, r.base, "").problems, ["tests/app.test.mjs -> src/app-check.mjs: renames a test file to a name that is not a test file"]);
  const r2 = gitRepo();
  t.after(() => r2.cleanup());
  r2.g("mv", "tests/big.test.mjs", "tests/moved.test.mjs");
  r2.write("tests/moved.test.mjs", BIG.replace("test('t3', () => assert.equal(3, 3));\n", ""));
  r2.commit();
  const res = testChanges(r2.dir, r2.base, "");
  assert.equal(res.problems.length, 1, JSON.stringify(res));
  assert.match(res.problems[0], /^tests\/big\.test\.mjs:3: removes a line from an existing test file \(renamed to tests\/moved\.test\.mjs\): "test\('t3', \(\) => assert\.equal\(3, 3\)\);"/);
});

test("FM-4: the spec's Allowed test changes section lets a named file shrink or go", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  fs.rmSync(path.join(r.dir, "tests/app.test.mjs"));
  r.commit();
  assert.deepEqual(testChanges(r.dir, r.base, "# S\n\n## Allowed test changes\n\n- `tests/app.test.mjs`: obsolete\n").problems, []);
  assert.equal(testChanges(r.dir, r.base, "# S\n\n## Allowed test changes\n\n- `tests/other.test.mjs`\n").problems.length, 1);
});

test("AC-9: a diff the guard cannot read fails closed", () => {
  const res = testChanges(os.tmpdir(), "0".repeat(40), "");
  assert.equal(res.problems.length, 1);
  assert.match(res.problems[0], /could not read the branch diff/);
});

// ---- R5: spec does not fit --------------------------------------------------

const handoff = { severity: "high", summary: "AC-3 contradicts AC-5", tried: "read both twice", situation: "nothing built yet", synthesis: "pick one of the two" };
const facts = { head: "abc", dirty: [], ahead: 1 };

function stateWithOwed() {
  const s = newState({ slug: "x", repo: "/r", spec: "/s.md", base: "main", baseSha: "abc", startedAt: "2026-10-14T00:00:00Z", breaker: false });
  afterBuild(s, { status: "DONE", summary: "ok", fixes: [] }, { passed: true, failures: [] }, { at: "2026-10-14T00:01:00Z", minutesElapsed: 1 });
  afterReview(s, [{ reviewer: "codex", ok: true, verdict: "needs-attention", summary: "", findings: [{ severity: "BLOCKER", title: "race", body: "", file: "a.js", lineStart: 1, lineEnd: 1 }] }], { at: "2026-10-14T00:02:00Z", minutesElapsed: 2 });
  return s;
}

test("AC-10: SPEC_MISMATCH is a build status; it needs a valid handoff, and not tests, fixes, a commit or a clean tree", () => {
  assert.ok(BUILD_STATUSES.includes("SPEC_MISMATCH"));
  const s = stateWithOwed();
  assert.equal(s.next.brief, "fix", "a fix round with F1 owed");
  assert.deepEqual(validateBuildResult({ status: "SPEC_MISMATCH", summary: "the spec does not fit", handoff }, s, { head: "abc", dirty: ["M x"], ahead: 0 }), []);
  for (const k of Object.keys(handoff)) {
    const bad = { ...handoff };
    delete bad[k];
    assert.ok(validateBuildResult({ status: "SPEC_MISMATCH", summary: "s", handoff: bad }, s, facts).some((p) => p.includes(`handoff.${k}`)), k);
  }
  assert.ok(validateBuildResult({ status: "SPEC_MISMATCH", summary: "s" }, s, facts).some((p) => /handoff/.test(p)), "no handoff");
  assert.ok(validateBuildResult({ status: "SPEC_MISMATCH", summary: "s", handoff: { ...handoff, severity: "urgent" } }, s, facts).some((p) => /handoff\.severity/.test(p)));
  assert.ok(validateBuildResult({ status: "SPEC_MISMATCH", summary: "s", handoff: { ...handoff, tried: "x".repeat(2001) } }, s, facts).some((p) => /handoff\.tried .*2,000/.test(p)));
  assert.ok(validateBuildResult({ status: "SPEC_MISMATCH", summary: "s", handoff: { ...handoff, synthesis: "   " } }, s, facts).some((p) => /handoff\.synthesis/.test(p)));
  assert.ok(validateBuildResult({ status: "SPEC_MISMATCH", summary: " ", handoff }, s, facts).some((p) => /summary/.test(p)));
});

test("AC-11: the referee escalates a SPEC_MISMATCH at gate SPEC, before BUILDER, with no ledger change, even with findings owed and red proof", () => {
  const s = stateWithOwed();
  const ledger = JSON.stringify(s.ledger);
  const next = afterBuild(s, { status: "SPEC_MISMATCH", summary: "does not fit", handoff }, null, { at: "2026-10-14T00:03:00Z", minutesElapsed: 3 });
  assert.equal(next.action, ACTIONS.ESCALATE);
  assert.equal(next.gate, "SPEC");
  assert.equal(JSON.stringify(s.ledger), ledger, "the ledger is untouched");
  assert.deepEqual(s.terminal.handoff, handoff);
  const s2 = stateWithOwed();
  assert.equal(afterBuild(s2, { status: "SPEC_MISMATCH", summary: "x", handoff }, { passed: false, failures: [{ command: "x", status: 1, output: "" }] }, { at: "2026-10-14T00:03:00Z", minutesElapsed: 3 }).gate, "SPEC");
  const report = renderReport(s, { minutesElapsed: 3 });
  assert.match(report, /escalated at gate SPEC/);
  assert.match(report, /## The builder's handoff: the spec does not fit/);
  assert.match(report, /- Severity: high/);
  assert.match(report, /- Tried: read both twice/);
  assert.match(report, /- Situation: nothing built yet/);
  assert.match(report, /- Synthesis: pick one of the two/);
  assert.match(report, /crossfire respec --from-loop x --slug <new-slug>/);
});

test("AC-11: a SPEC_MISMATCH on a harden round (breaker attacks owed) escalates at SPEC too, and is valid without answering them", async () => {
  const { afterBreak } = await import("../plugins/crossfire/scripts/lib/referee.mjs");
  const s = newState({ slug: "x", repo: "/r", spec: "/s.md", base: "main", baseSha: "abc", startedAt: "2026-10-14T00:00:00Z", breaker: true });
  afterBuild(s, { status: "DONE", summary: "ok", fixes: [] }, { passed: true, failures: [] }, { at: "2026-10-14T00:01:00Z", minutesElapsed: 1 });
  afterBreak(s, [{ severity: "BLOCKER", title: "two writers", scenario: "x", file: "a.js", lineStart: 3 }], { at: "2026-10-14T00:02:00Z", minutesElapsed: 2 });
  assert.equal(s.next.brief, "harden");
  assert.deepEqual(validateBuildResult({ status: "SPEC_MISMATCH", summary: "does not fit", handoff }, s, facts), []);
  const next = afterBuild(s, { status: "SPEC_MISMATCH", summary: "does not fit", handoff }, null, { at: "2026-10-14T00:03:00Z", minutesElapsed: 3 });
  assert.equal(next.gate, "SPEC");
  assert.equal(s.ledger[0].status, "open", "the attack is left as it was");
});

test("AC-10: the builder brief's result section shows the SPEC_MISMATCH shape", () => {
  const s = newState({ slug: "x", repo: "/r", spec: "/s.md", base: "main", baseSha: "abc", startedAt: "2026-10-14T00:00:00Z" });
  const brief = renderBrief(s, { resultFile: "/tmp/r.json", branch: "b" });
  assert.match(brief, /"status": "SPEC_MISMATCH"/);
  assert.match(brief, /"handoff": \{/);
  for (const k of ["severity", "summary", "tried", "situation", "synthesis"]) assert.match(brief, new RegExp(`"${k}":`));
  assert.match(brief, /SPEC_MISMATCH when the spec cannot be built as written/);
});

// ---- R2: max-rounds counts the builder legs crossfire runs ---------------------

test("AC-7: with an offset (a from-check loop), the round cap counts only crossfire's builder legs", () => {
  const s = newState({ slug: "x", repo: "/r", spec: "/s.md", base: "main", baseSha: "abc", startedAt: "2026-10-14T00:00:00Z", breaker: false, maxRounds: 2 });
  s.roundOffset = 1;
  s.phase = "review";
  afterReview(s, [{ reviewer: "codex", ok: true, verdict: "needs-attention", summary: "", findings: [{ severity: "BLOCKER", title: "race", body: "", file: "a.js", lineStart: 1, lineEnd: 1 }] }], { at: "2026-10-14T00:00:00Z", minutesElapsed: 1 });
  assert.equal(s.round, 2);
  assert.match(statusLine(s, 1), /round 1\/2/, "the PR's own code is not a builder leg");
  const red = { passed: false, failures: [{ command: "make e2e", status: 1, output: "boom" }] };
  let next = afterBuild(s, { status: "DONE", summary: "ok", fixes: [{ id: "F1", status: "FIXED" }] }, red, { at: "2026-10-14T00:01:00Z", minutesElapsed: 2 });
  assert.equal(next.action, ACTIONS.SEND_BUILDER, "first leg red: back to the builder");
  assert.equal(next.brief, "g0");
  next = afterBuild(s, { status: "DONE", summary: "ok", fixes: [] }, red, { at: "2026-10-14T00:02:00Z", minutesElapsed: 3 });
  assert.equal(next.gate, "G2", "second leg red: the cap");
  assert.match(next.reason, /after 2 builder legs/);
});

// ---- R6: precedents ---------------------------------------------------------------

test("AC-12/FM-8: precedents are dated lines in the git common dir; prompts carry the latest 30", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  assert.equal(precedentsFile(r.dir), path.join(r.dir, ".git", "crossfire", "precedents.md"));
  assert.deepEqual(readPrecedents(r.dir), []);
  assert.deepEqual(precedentsBlock(r.dir), []);
  for (let i = 1; i <= 35; i += 1) appendPrecedent(r.dir, `ruling ${i}`, "2026-10-14");
  const all = readPrecedents(r.dir, 1000);
  assert.equal(all.length, 35);
  assert.equal(all[0], "- 2026-10-14 · ruling 1");
  const block = precedentsBlock(r.dir);
  assert.equal(block.filter((l) => l.startsWith("- ")).length, 30);
  assert.ok(block.includes("- 2026-10-14 · ruling 35"));
  assert.ok(!block.includes("- 2026-10-14 · ruling 5"), "older ones are left out of prompts");
  assert.ok(block.some((l) => /Settled by the owner; do not raise these again/.test(l)));
  assert.throws(() => appendPrecedent(r.dir, "   ", "2026-10-14"), /empty/);
  assert.throws(() => appendPrecedent(r.dir, "x".repeat(501), "2026-10-14"), /500/);
  appendPrecedent(r.dir, "two\nlines", "2026-10-14");
  assert.equal(readPrecedents(r.dir, 1000).at(-1), "- 2026-10-14 · two lines", "one line per ruling");
});

test("AC-13: builder briefs, breaker briefs and the loop and check focus carry the precedents", () => {
  const s = newState({ slug: "x", repo: "/r", spec: "/s.md", base: "main", baseSha: "abc", startedAt: "2026-10-14T00:00:00Z" });
  const precedents = ["- 2026-10-14 · the cache may be stale for 5 s"];
  const block = ["", "## Settled by the owner; do not raise these again", ...precedents];
  assert.match(renderBrief(s, { resultFile: "/tmp/r.json", branch: "b", precedents: block }), /## Settled by the owner; do not raise these again\n- 2026-10-14 · the cache may be stale for 5 s/);
  assert.match(renderBreakerBrief(s, { resultFile: "/tmp/r.json", branch: "b", head: "abc", precedents: block }), /## Settled by the owner; do not raise these again\n- 2026-10-14 · the cache may be stale for 5 s/);
  assert.match(buildFocus(s, { specText: "spec", precedents }), /Settled by the owner; do not raise these again:\n- 2026-10-14 · the cache may be stale for 5 s/);
  assert.match(buildCheckFocus({ base: "main", precedents }), /Settled by the owner; do not raise these again:\n- 2026-10-14 · the cache may be stale for 5 s/);
  assert.doesNotMatch(buildFocus(s, { specText: "spec" }), /Settled by the owner/, "nothing when there are none");
});

// ---- R1: spec review ---------------------------------------------------------------

test("AC-1b: the spec review focus is a design review, not the pull-request focus", () => {
  const focus = buildSpecFocus({ slug: "demo", base: "main", hasPlan: true, precedents: ["- 2026-10-14 · keep the CLI dependency-free"] });
  assert.match(focus, /crossfire-spec-review\/demo\.md/);
  assert.match(focus, /crossfire-spec-review\/demo\.plan\.md/);
  assert.match(focus, /as a design against the repository's current code/);
  for (const w of ["gaps", "contradictions", "untestable or ambiguous acceptance criteria", "missing failure modes", "conflicts with the code it names", "cheaper ways to the same goal"]) assert.match(focus, new RegExp(w), w);
  assert.match(focus, /cites the heading where it belongs/);
  assert.match(focus, /high = the builder would build the wrong thing or a hole would ship/);
  assert.match(focus, /medium = an ambiguity that would cost a round/);
  assert.match(focus, /low = wording/);
  assert.match(focus, /keep the CLI dependency-free/);
  assert.ok(!focus.includes("Only report a finding you can tie to a file and line in this diff"));
  assert.doesNotMatch(buildSpecFocus({ slug: "demo", base: "main", hasPlan: false }), /demo\.plan\.md/);
});

test("AC-3: spec review status from the saved review and the spec and plan bytes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crossfire-sr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec = Buffer.from("# Spec v1\n");
  const plan = Buffer.from("# Plan\n");
  const at = "2026-10-14T10:00:00.000Z";
  const review = { version: 1, at, specSha256: sha256(spec), planSha256: sha256(plan), findings: [{}, {}] };
  const responseFile = path.join(dir, "demo.review-response.md");
  assert.equal(specReviewStatus({ review: null, spec, plan, responseFile }).status, "none");
  let s = specReviewStatus({ review, spec, plan, responseFile });
  assert.equal(s.status, "current");
  assert.equal(s.line, `SPEC REVIEW: current (${at}, 2 findings)`);
  s = specReviewStatus({ review, spec: Buffer.from("# Spec v2\n"), plan, responseFile });
  assert.equal(s.status, "stale");
  assert.equal(s.line, `SPEC REVIEW: stale (the spec changed after ${at} with no recorded response)`);
  assert.equal(specReviewStatus({ review, spec, plan: null, responseFile }).status, "stale", "the plan is part of what was reviewed");
  assert.equal(specReviewStatus({ review, spec, plan: Buffer.from("# Plan 2\n"), responseFile }).status, "stale");
  fs.writeFileSync(responseFile, "- F1: fixed in AC-3\n");
  const before = new Date(Date.parse(at) - 60_000);
  fs.utimesSync(responseFile, before, before);
  assert.equal(specReviewStatus({ review, spec: Buffer.from("# Spec v2\n"), plan, responseFile }).status, "stale", "a response older than the review does not count");
  const after = new Date(Date.parse(at) + 60_000);
  fs.utimesSync(responseFile, after, after);
  s = specReviewStatus({ review, spec: Buffer.from("# Spec v2\n"), plan, responseFile });
  assert.equal(s.status, "revised");
  assert.equal(s.line, `SPEC REVIEW: revised after review (${at}, 2 findings; responses in ${responseFile})`);
  fs.writeFileSync(responseFile, "  \n");
  fs.utimesSync(responseFile, after, after);
  assert.equal(specReviewStatus({ review, spec: Buffer.from("# Spec v2\n"), plan, responseFile }).status, "stale", "an empty response is no response");
  assert.equal(specReviewStatus({ review: { at, findings: [] }, spec, plan, responseFile }).status, "none", "a review without hashes is not a review");
  assert.equal(specReviewStatus({ review: { ...review, at: "never" }, spec, plan, responseFile }).status, "none");
});

test("AC-6: the spec's Risk line", () => {
  assert.equal(riskHigh("# S\n\n**Risk:** high (touches git)\n"), true);
  assert.equal(riskHigh("# S\n\n**Risk:** High\n"), true);
  assert.equal(riskHigh("# S\n\n**Risk:** low\n"), false);
  assert.equal(riskHigh("# S\n\nthe risk is high\n"), false);
  assert.equal(riskHigh("# S\n"), false);
});

test("AC-15: diff size counts changed lines and files, lockfiles excluded", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  r.write("src/big.mjs", "x\n".repeat(300));
  r.write("package-lock.json", "{}\n".repeat(5000));
  r.write("sub/yarn.lock", "y\n".repeat(5000));
  r.commit();
  const size = diffSize(r.dir, r.base);
  assert.deepEqual(size, { lines: 300, files: 1 });
});

// ---- R4: an existing test file is not changed --------------------------------------------
// Rule: a builder cannot weaken an existing test: existing test files are unchanged unless the
// approved spec allows it, and new tests go in new files.

function changed(base, branch, file = "tests/app.test.mjs", spec = "") {
  const r = gitRepo();
  r.write(file, base);
  r.commit();
  const base2 = r.g("rev-parse", "HEAD");
  r.write(file, branch);
  r.commit();
  const res = testChanges(r.dir, base2, spec);
  r.cleanup();
  return res.problems;
}

const APP = "test('a', () => {\n  assert.equal(compute(), 42);\n});\n";

test("breaker: commenting out an existing assertion with added lines only is a weakened test", () => {
  const p = changed(APP, "test('a', () => {\n  /*\n  assert.equal(compute(), 42);\n  */\n});\n");
  assert.deepEqual(p, ['tests/app.test.mjs:2: adds a line to an existing test file: "  /*"', 'tests/app.test.mjs:4: adds a line to an existing test file: "  */"']);
});

test("R4: removing an assertion from an existing test file is refused, with file and line", () => {
  const p = changed(APP, "test('a', () => {\n});\n");
  assert.deepEqual(p, ['tests/app.test.mjs:2: removes a line from an existing test file: "  assert.equal(compute(), 42);"']);
});

test("R4: editing an assertion in an existing test file is refused", () => {
  const p = changed(APP, "test('a', () => {\n  assert.ok(compute());\n});\n");
  assert.deepEqual(p, ['tests/app.test.mjs:2: removes a line from an existing test file: "  assert.equal(compute(), 42);"', 'tests/app.test.mjs:2: adds a line to an existing test file: "  assert.ok(compute());"']);
});

test("R4: any added line in an existing test file is refused: an early return, a rebound assertion, even a new test", () => {
  assert.equal(changed(APP, "test('a', () => {\n  return;\n  assert.equal(compute(), 42);\n});\n").length, 1, "an early return");
  assert.equal(changed(APP, `assert.equal = () => {};\n${APP}`).length, 1, "assert.equal reassigned");
  assert.equal(changed(APP, `${APP}test('b', () => {\n  assert.ok(true);\n});\n`).length, 3, "a new test goes in a new file");
  assert.equal(changed("def test_a():\n    assert compute() == 42\n", 'def test_a():\n    """\n    assert compute() == 42\n    """\n', "tests/test_app.py").length, 2, "a Python docstring");
  assert.equal(changed("it 'a' do\n  expect(compute).to eq(42)\nend\n", "it 'a' do\n=begin\n  expect(compute).to eq(42)\n=end\nend\n", "spec/app_spec.rb").length, 2, "a Ruby =begin block");
});

test("R4: a change with no line diff (only whitespace at the end, or binary) is still refused", () => {
  const p = changed(APP, APP.replace(/\n$/, ""));
  assert.ok(p.length > 0, JSON.stringify(p));
  const bin = changed("\u0000\u0001base", "\u0000\u0001weakened", "tests/data.test.bin");
  assert.deepEqual(bin, ["tests/data.test.bin: changes an existing test file"]);
});

test("R4: the approved spec's Allowed test changes lets a named existing file change; another file stays refused", () => {
  const allow = "# S\n\n## Allowed test changes\n\n- `tests/app.test.mjs`: the old check is replaced\n";
  assert.deepEqual(changed(APP, "test('a', () => {\n});\n", "tests/app.test.mjs", allow), []);
  assert.equal(changed(APP, "test('a', () => {\n});\n", "tests/app.test.mjs", "# S\n\n## Allowed test changes\n\n- `tests/other.test.mjs`\n").length, 1);
});

test("R4: helpers and fixtures are not test files and may change; a new test file is free but may not skip or focus", (t) => {
  assert.deepEqual(changed("export const load = 1;\n", "export const load = 2;\n", "tests/helpers.mjs"), [], "a helper");
  assert.deepEqual(changed('{"a": 1}\n', '{"a": 2}\n', "tests/fixtures/data.json"), [], "a fixture");
  const r = gitRepo();
  t.after(() => r.cleanup());
  r.write("tests/new.test.mjs", `test('n', () => {\n  assert.ok(true);\n});\nconst later = test${"." + "skip"};\n`);
  r.write("tests/clean.test.mjs", "test('c', () => {\n  assert.ok(true);\n});\n");
  r.commit();
  const res = testChanges(r.dir, r.base, "");
  assert.deepEqual(res.problems, [`tests/new.test.mjs:4: adds a skip or focus call: "const later = test${"." + "skip"};"`]);
});

test("R4: a file renamed from a non-test name to a test name is a new test file: its whole content is checked for skip calls", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  r.write("src/later.mjs", `${BIG}test${SKIP}'z', () => {});\n`);
  r.commit();
  const base2 = r.g("rev-parse", "HEAD");
  r.g("mv", "src/later.mjs", "src/later.test.mjs");
  r.commit();
  const res = testChanges(r.dir, base2, "");
  assert.deepEqual(res.problems, [`src/later.test.mjs:13: adds a skip or focus call: "test${SKIP}'z', () => {});"`]);
});
