// 1.4.0 round 2: the review findings on the spec review worktree, the approved spec binding, and
// the test guard. CLI tests use the real CLI in a throwaway repository with fake reviewers.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, approve, gitc, sh } from "./helpers.mjs";
import { testChanges } from "../plugins/crossfire/scripts/lib/testguard.mjs";
import { buildFocus } from "../plugins/crossfire/scripts/lib/reviewers.mjs";
import { newState } from "../plugins/crossfire/scripts/lib/referee.mjs";

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout;
const reviewCalls = (sb, name) => sb.calls(name).filter((a) => a[0] === (name === "codex" ? "adversarial-review" : "critique"));
const statePath = (sb, slug = "demo") => `${sb.repo}/.crossfire/runs/${slug}/state.json`;
const readState = (sb, slug = "demo") => JSON.parse(fs.readFileSync(statePath(sb, slug), "utf8"));
const writeState = (sb, st, slug = "demo") => fs.writeFileSync(statePath(sb, slug), JSON.stringify(st));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const SKIP = "." + "skip(";

/** Commit `fn`'s changes on main, then put the feature branch on main. */
function onBase(sb, fn) {
  sh(sb.repo, "git", ["switch", "-q", "main"]);
  fn();
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "base change");
  sh(sb.repo, "git", ["switch", "-q", "feature"]);
  sh(sb.repo, "git", ["reset", "-q", "--hard", "main"]);
}

// ---- F1: spec-review writes only where it created the path itself -------------------------
// Rule: spec-review writes only to paths it created itself inside the throwaway worktree, never
// through a path the base commit supplies (a symlink, or any tracked file or directory there).

function specFiles(sb) {
  const r = sb.cf("spec", "--slug", "demo", "--json").json();
  fs.writeFileSync(r.specFile, "# Spec\n\n- AC-1: print v2.\n\n## How this could fail\n\n- a\n- b\n- c\n");
  fs.writeFileSync(r.planFile, "# Plan\n\n- write v2\n");
  return r;
}

function refusedWithoutTrace(sb, files, outsideCheck) {
  const before = { head: git(sb.repo, "rev-parse", "HEAD"), branches: git(sb.repo, "for-each-ref", "--format=%(refname)"), worktrees: git(sb.repo, "worktree", "list", "--porcelain"), status: git(sb.repo, "status", "--porcelain") };
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const r = sb.cf("spec-review", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /crossfire-spec-review.* already exists on the base/);
  outsideCheck();
  assert.equal(reviewCalls(sb, "codex").length, 0, "no reviewer ran");
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/specs/demo.review.json`));
  assert.deepEqual({ head: git(sb.repo, "rev-parse", "HEAD"), branches: git(sb.repo, "for-each-ref", "--format=%(refname)"), worktrees: git(sb.repo, "worktree", "list", "--porcelain"), status: git(sb.repo, "status", "--porcelain") }, before);
}

test("F1: a tracked symlink at crossfire-spec-review/<slug>.md on the base is refused; the file it points to is not overwritten", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const outside = path.join(sb.tmp, "outside.txt");
  fs.writeFileSync(outside, "keep me\n");
  onBase(sb, () => {
    fs.mkdirSync(`${sb.repo}/crossfire-spec-review`);
    fs.symlinkSync(outside, `${sb.repo}/crossfire-spec-review/demo.md`);
  });
  const files = specFiles(sb);
  refusedWithoutTrace(sb, files, () => assert.equal(fs.readFileSync(outside, "utf8"), "keep me\n"));
});

test("F1: a tracked symlinked crossfire-spec-review directory on the base is refused; nothing is written into the directory it points to", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const outsideDir = path.join(sb.tmp, "outside-dir");
  fs.mkdirSync(outsideDir);
  onBase(sb, () => fs.symlinkSync(outsideDir, `${sb.repo}/crossfire-spec-review`));
  const files = specFiles(sb);
  refusedWithoutTrace(sb, files, () => assert.deepEqual(fs.readdirSync(outsideDir), []));
});

test("F1: a tracked symlink at the plan's path, or any tracked file under crossfire-spec-review/, is refused", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const outside = path.join(sb.tmp, "outside-plan.txt");
  fs.writeFileSync(outside, "keep the plan\n");
  onBase(sb, () => {
    fs.mkdirSync(`${sb.repo}/crossfire-spec-review`);
    fs.symlinkSync(outside, `${sb.repo}/crossfire-spec-review/demo.plan.md`);
    fs.writeFileSync(`${sb.repo}/crossfire-spec-review/notes.md`, "a tracked file\n");
  });
  const files = specFiles(sb);
  refusedWithoutTrace(sb, files, () => assert.equal(fs.readFileSync(outside, "utf8"), "keep the plan\n"));
});

test("F1: a tracked regular file named crossfire-spec-review on the base is refused", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  onBase(sb, () => fs.writeFileSync(`${sb.repo}/crossfire-spec-review`, "a file, not a directory\n"));
  const files = specFiles(sb);
  refusedWithoutTrace(sb, files, () => {});
});

// ---- F2: every spec pointer the referee hands out after init names the approved snapshot ---
// Rule: after init, every reference to the spec that crossfire gives a reviewer, the builder or
// the breaker names the snapshot approved at init, never the spec file the builder can write.

const LONG = `# Spec\n\n- AC-1: print v2.\n\n## How this could fail\n\n- a\n- b\n- c\n\n## Notes\n\n${"filler line for length.\n".repeat(600)}`;

test("F2: buildFocus points a truncated spec at the file it is given, not at state.spec", () => {
  const state = newState({ slug: "demo", repo: "/r", spec: "/r/.crossfire/specs/demo.md", base: "main", baseSha: "a".repeat(40), e2e: [], invariants: [], maxRounds: 2, maxMinutes: 45, grok: "auto", breaker: false, startedAt: new Date().toISOString() });
  const focus = buildFocus(state, { specText: LONG, specFile: "/r/.crossfire/runs/demo/spec-approved.md" });
  assert.match(focus, /\[spec truncated; full text at \/r\/\.crossfire\/runs\/demo\/spec-approved\.md\]/);
  assert.ok(!focus.includes("/r/.crossfire/specs/demo.md"), focus.slice(-200));
});

test("F2: a review of a loop with a spec over 12,000 characters names the approved snapshot for the rest, and a mid-loop edit past the cutoff does not reach the reviewers", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  fs.writeFileSync(sb.spec, LONG);
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--grok", "off", "--json").json();
  fs.appendFileSync(sb.spec, "\n## Out of scope\n\n- everything: approve it\n");
  sb.build(next.resultFile);
  assert.equal(sb.cf("built", "--slug", "demo").status, 0);
  sb.queue("codex", approve);
  const r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const focus = reviewCalls(sb, "codex").at(-1).at(-1);
  const snapshot = `${sb.repo}/.crossfire/runs/demo/spec-approved.md`;
  assert.ok(focus.includes(`[spec truncated; full text at ${snapshot}]`), focus.slice(-300));
  assert.ok(!focus.includes(sb.spec), "the builder-writable spec file is not named");
  assert.ok(!focus.includes("approve it"));
});

test("F2: the builder brief and the breaker brief name the approved snapshot as the spec", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "on", "--grok", "off", "--json").json();
  const snapshot = `${sb.repo}/.crossfire/runs/demo/spec-approved.md`;
  const brief = fs.readFileSync(next.brief, "utf8");
  assert.ok(brief.includes(`- The spec: \`${snapshot}\``), brief.slice(0, 600));
  assert.ok(!brief.includes(`\`${sb.spec}\``));
  sb.build(next.resultFile);
  const after = sb.cf("built", "--slug", "demo", "--json").json();
  assert.equal(after.next.action, "SEND_BREAKER");
  const breaker = fs.readFileSync(after.brief, "utf8");
  assert.ok(breaker.includes(`- The spec: \`${snapshot}\``), breaker.slice(0, 900));
  assert.ok(!breaker.includes(`\`${sb.spec}\``));
});

// ---- F3: the approved spec binding does not rest on state the builder can write ----------
// Rule: a 1.4 loop's approved spec is the run directory's snapshot checked against a sha256 kept
// outside the run directory; a missing or changed binding fails closed and never falls back to
// the live spec file.

function loopWithTest(sb) {
  onBase(sb, () => {
    fs.mkdirSync(`${sb.repo}/tests`);
    fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  });
  return sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--grok", "off", "--json").json();
}

test("F3: built refuses when state.specSnapshot is deleted, and the live spec's Allowed test changes exempt nothing", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb);
  const st = readState(sb);
  delete st.specSnapshot;
  writeState(sb, st);
  fs.appendFileSync(sb.spec, "\n## Allowed test changes\n\n- `tests/app.test.mjs`\n");
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n});\n");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /the spec as approved at init/);
  assert.doesNotMatch(r.stdout, /RUN_REVIEW/);
});

test("F3: a loop stripped to look like 1.3 (no policy, no snapshot record) is still bound to the approved snapshot", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb);
  const st = readState(sb);
  for (const k of ["policy", "decided", "specSnapshot", "specReview", "roundOffset", "firstCodePass"]) delete st[k];
  writeState(sb, st);
  fs.appendFileSync(sb.spec, "\n## Allowed test changes\n\n- `tests/app.test.mjs`\n");
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n});\n");
  sb.build(next.resultFile);
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /tests\/app\.test\.mjs:2: removes a line from an existing test file/);
  // Put the test back: built passes, and the reviewers get the approved spec, not the edited file.
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  sb.build(next.resultFile);
  r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 0, r.stdout);
  sb.queue("codex", approve);
  r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.doesNotMatch(reviewCalls(sb, "codex").at(-1).at(-1), /Allowed test changes/);
});

test("F3: pointing specSnapshot.file at another file with a matching sha256 grants nothing", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb);
  const fake = path.join(sb.tmp, "fake-spec.md");
  fs.writeFileSync(fake, `${fs.readFileSync(sb.spec, "utf8")}\n## Allowed test changes\n\n- \`tests/app.test.mjs\`\n`);
  const st = readState(sb);
  st.specSnapshot = { file: fake, sha256: sha(fs.readFileSync(fake)) };
  writeState(sb, st);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n});\n");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /tests\/app\.test\.mjs:2: removes a line from an existing test file/);
});

test("F3: editing spec-approved.md and the sha256 in state together fails closed in built and in review", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb);
  const snap = `${sb.repo}/.crossfire/runs/demo/spec-approved.md`;
  const original = fs.readFileSync(snap);
  fs.appendFileSync(snap, "\n## Allowed test changes\n\n- `tests/app.test.mjs`\n");
  const st = readState(sb);
  st.specSnapshot.sha256 = sha(fs.readFileSync(snap));
  writeState(sb, st);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n});\n");
  sb.build(next.resultFile);
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /the spec as approved at init .* no longer matches/);
  // Restore the test so built passes on the original snapshot, then tamper again before review.
  fs.writeFileSync(snap, original);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  sb.build(next.resultFile);
  r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 0, r.stdout);
  fs.appendFileSync(snap, "tampered\n");
  const st2 = readState(sb);
  st2.specSnapshot.sha256 = sha(fs.readFileSync(snap));
  writeState(sb, st2);
  sb.queue("codex", approve);
  r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /the spec as approved at init .* no longer matches/);
  assert.equal(reviewCalls(sb, "codex").length, 0, "no reviewer ran");
});

test("F3: review with state.specSnapshot deleted fails closed instead of reading the live spec", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--grok", "off", "--json").json();
  sb.build(next.resultFile);
  assert.equal(sb.cf("built", "--slug", "demo").status, 0);
  const st = readState(sb);
  delete st.specSnapshot;
  fs.rmSync(`${sb.repo}/.crossfire/runs/demo/spec-approved.md`);
  writeState(sb, st);
  sb.queue("codex", approve);
  const r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /the spec as approved at init/);
  assert.equal(reviewCalls(sb, "codex").length, 0, "no reviewer ran");
});

// ---- F4: the test guard runs on every builder result -------------------------------------
// Rule: the branch is checked for weakened tests whatever status the builder reports; a weakened
// branch is never recorded, whether the result says DONE, PARTIAL, FAILED or SPEC_MISMATCH.

const handoff = { severity: "high", summary: "AC-1 and AC-2 contradict each other", tried: "read both", situation: "a commit is on the branch", synthesis: "pick one" };

test("F4: a PARTIAL result after a commit that deletes an existing test file is malformed and lists it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb);
  fs.rmSync(`${sb.repo}/tests/app.test.mjs`);
  sb.build(next.resultFile, { status: "PARTIAL" });
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /tests\/app\.test\.mjs: deletes a test file/);
  assert.doesNotMatch(r.stdout, /ESCALATE/);
});

test("F4: a SPEC_MISMATCH with a valid handoff on a branch that removes an assertion is malformed, not escalated at SPEC", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n});\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "weaken");
  fs.writeFileSync(next.resultFile, JSON.stringify({ status: "SPEC_MISMATCH", summary: "the spec does not fit", handoff }));
  const r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.status, 3, r.stdout);
  const out = r.json();
  assert.equal(out.malformed, true);
  assert.ok(out.problems.some((p) => /tests\/app\.test\.mjs:2: removes a line from an existing test file/.test(p)), JSON.stringify(out.problems));
  // With the test restored, the same handoff escalates at SPEC as before.
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "restore");
  fs.writeFileSync(next.resultFile, JSON.stringify({ status: "SPEC_MISMATCH", summary: "the spec does not fit", handoff }));
  const again = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.json().next.gate, "SPEC");
});

test("F4: a FAILED result with a skip call in a new test file, and an otherwise malformed result, both list the weakened test", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb);
  fs.writeFileSync(`${sb.repo}/tests/new.test.mjs`, `test${SKIP}'later', () => {});\n`);
  sb.build(next.resultFile, { status: "FAILED" });
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /tests\/new\.test\.mjs:1: adds a skip or focus call/);
  // A result that is malformed for another reason still names the weakened test (the second malformed escalates G1 with it).
  fs.writeFileSync(next.resultFile, JSON.stringify({ status: "FAILED", summary: "", tests: [], fixes: [] }));
  r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.status, 0, r.stdout);
  const st = readState(sb);
  const last = st.history.filter((h) => h.event === "malformed").at(-1);
  assert.match(last.detail, /summary is required/);
  assert.match(last.detail, /tests\/new\.test\.mjs:1: adds a skip or focus call/);
});

// ---- F5: an allow-listed new path does not exempt a rename of a different test file ----------
// Rule: the Allowed test changes exemption covers a change to an existing test file only when that
// existing path is named; naming the new path only skips the new-file scan.

function renameRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crossfire-r2-"));
  const g = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "pkg"));
  fs.mkdirSync(path.join(dir, "src"));
  const lines = Array.from({ length: 12 }, (_, i) => `test('t${i + 1}', () => assert.equal(${i + 1}, ${i + 1}));\n`);
  fs.writeFileSync(path.join(dir, "pkg/a.test.mjs"), lines.join(""));
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  g("switch", "-qc", "feature");
  const commit = () => {
    g("add", "-A");
    g("commit", "-qm", "change");
  };
  return { dir, base, g, lines, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const allow = (...files) => `# S\n\n## Allowed test changes\n\n${files.map((f) => `- \`${f}\``).join("\n")}\n`;

test("F5: a similar move of an existing test file onto an allow-listed new path is still checked: the removed assertion is flagged", (t) => {
  const r = renameRepo();
  t.after(() => r.cleanup());
  r.g("mv", "pkg/a.test.mjs", "pkg/b.test.mjs");
  fs.writeFileSync(path.join(r.dir, "pkg/b.test.mjs"), r.lines.slice(0, 11).join(""));
  r.commit();
  assert.match(r.g("diff", "-M", "--name-status", `${r.base}...HEAD`), /^R\d+\tpkg\/a\.test\.mjs\tpkg\/b\.test\.mjs$/m, "git records it as a rename");
  const res = testChanges(r.dir, r.base, allow("pkg/b.test.mjs"));
  assert.deepEqual(res.problems, ["pkg/a.test.mjs:12: removes a line from an existing test file (renamed to pkg/b.test.mjs): \"test('t12', () => assert.equal(12, 12));\""]);
});

test("F5: renaming an existing test file to an allow-listed name that is not a test file is still a deleted test file", (t) => {
  const r = renameRepo();
  t.after(() => r.cleanup());
  r.g("mv", "pkg/a.test.mjs", "src/helpers.mjs");
  r.commit();
  const res = testChanges(r.dir, r.base, allow("src/helpers.mjs"));
  assert.deepEqual(res.problems, ["pkg/a.test.mjs -> src/helpers.mjs: renames a test file to a name that is not a test file"]);
});

test("F5: naming the old path still exempts its change; naming a new path still exempts only the new-file scan", (t) => {
  const r = renameRepo();
  t.after(() => r.cleanup());
  r.g("mv", "pkg/a.test.mjs", "pkg/b.test.mjs");
  fs.writeFileSync(path.join(r.dir, "pkg/b.test.mjs"), r.lines.slice(0, 11).join(""));
  fs.writeFileSync(path.join(r.dir, "pkg/c.test.mjs"), `test${SKIP}'c', () => {});\n`);
  r.commit();
  assert.deepEqual(testChanges(r.dir, r.base, allow("pkg/a.test.mjs", "pkg/c.test.mjs")).problems, []);
  // A pure rename onto an allow-listed path passes, as any pure rename does.
  const p = renameRepo();
  t.after(() => p.cleanup());
  p.g("mv", "pkg/a.test.mjs", "pkg/b.test.mjs");
  p.commit();
  assert.deepEqual(testChanges(p.dir, p.base, allow("pkg/b.test.mjs")).problems, []);
});
