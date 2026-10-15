// 1.4.0 round 2 harden: the test guard judges only what the loop's builder committed (from the
// head recorded at init), and only on loops started on 1.4 (policy: 2). CLI tests use the real CLI
// in a throwaway repository with fake reviewers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sandbox, approve, finding, needs, gitc, sh } from "./helpers.mjs";
import { testChanges } from "../plugins/crossfire/scripts/lib/testguard.mjs";

const statePath = (sb, slug = "demo") => `${sb.repo}/.crossfire/runs/${slug}/state.json`;
const readState = (sb, slug = "demo") => JSON.parse(fs.readFileSync(statePath(sb, slug), "utf8"));
const writeState = (sb, st, slug = "demo") => fs.writeFileSync(statePath(sb, slug), JSON.stringify(st));
const SKIP = "." + "skip(";

/** On main: tests/app.test.mjs ("prints v1") and tests/smoke.mjs (two asserts); feature reset onto main. */
function baseWithTest(sb) {
  sh(sb.repo, "git", ["switch", "-q", "main"]);
  fs.mkdirSync(`${sb.repo}/tests`, { recursive: true });
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('prints v1', () => {\n  assert.equal(read(), 'v1');\n});\n");
  fs.writeFileSync(`${sb.repo}/tests/smoke.mjs`, "assert.equal(run(), 0);\nassert.ok(output.includes('v2'));\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "base tests");
  sh(sb.repo, "git", ["switch", "-q", "feature"]);
  sh(sb.repo, "git", ["reset", "-q", "--hard", "main"]);
}

const V2_TEST = "test('prints v2', () => {\n  assert.equal(read(), 'v2');\n});\n";

/** A pull request (commits already on the branch) that updates the existing test, then a check and a from-check loop. */
function fromCheckLoop(sb) {
  baseWithTest(sb);
  fs.writeFileSync(`${sb.repo}/app.txt`, "v2\n");
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, V2_TEST);
  fs.writeFileSync(`${sb.repo}/tests/pr.test.mjs`, "test('pr', () => {\n  assert.ok(pr());\n});\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "pr: print v2");
  sb.queue("codex", needs(finding("high", "nested rollback loses the write")));
  sb.queue("grok", approve);
  assert.equal(sb.cf("check", "--base", "main", "--name", "pr-1").status, 0);
  return sb.cf("init", "--slug", "fix-pr-1", "--spec", sb.spec, "--base", "main", "--from-check", "pr-1", "--json").json();
}

// ---- B3: the guard judges only the loop's own builder commits ----------------------------
// Rule: a guard on what the builder does judges only the commits made after the head recorded at
// init, never code that was on the branch before the loop started; a history that no longer
// descends from that head, or a start head that cannot be checked, fails closed.

test("breaker: a --from-check loop is refused for the pull request's own (author's) test update, before the builder changed any test", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = fromCheckLoop(sb);
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] }); // touches app.txt only
  const r = sb.cf("built", "--slug", "fix-pr-1");
  assert.doesNotMatch(r.stdout + r.stderr, /weakens tests/);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("B3: a plain loop started on a branch whose earlier commits changed an existing test is not refused for them", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  baseWithTest(sb);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, V2_TEST);
  fs.rmSync(`${sb.repo}/tests/smoke.mjs`);
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "earlier work on the branch");
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--json").json();
  assert.equal(readState(sb).startHead, sh(sb.repo, "git", ["rev-parse", "HEAD"]), "init records the head the loop starts from");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.doesNotMatch(r.stdout + r.stderr, /weakens tests/);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("B3: in a from-check loop the builder may not change a test file that existed when the loop started, including one the pull request added", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = fromCheckLoop(sb);
  fs.writeFileSync(`${sb.repo}/tests/pr.test.mjs`, "test('pr', () => {\n});\n");
  gitc(sb.repo, "add", "-A");
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  const r = sb.cf("built", "--slug", "fix-pr-1");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /weakens tests: tests\/pr\.test\.mjs:2: removes a line from an existing test file/);
});

test("B3: the builder reverting the pull request's test update is refused (its start, not the base, is the reference)", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = fromCheckLoop(sb);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('prints v1', () => {\n  assert.equal(read(), 'v1');\n});\n");
  gitc(sb.repo, "add", "-A");
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  const r = sb.cf("built", "--slug", "fix-pr-1");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /weakens tests: tests\/app\.test\.mjs:\d+: removes a line from an existing test file/);
});

test("B3: a branch rewritten so HEAD no longer descends from the loop's start head fails closed", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = fromCheckLoop(sb);
  sh(sb.repo, "git", ["reset", "-q", "--hard", "main"]); // drops the pull request's commit
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  const r = sb.cf("built", "--slug", "fix-pr-1");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /weakens tests: HEAD does not descend from .*the loop started from/);
});

test("B3: a start head missing from state, or changed there, fails closed on a 1.4 loop", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  baseWithTest(sb);
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--json").json();
  const st = readState(sb);
  for (const [label, value] of [["missing", undefined], ["changed", "0".repeat(40)]]) {
    writeState(sb, { ...st, startHead: value });
    sb.build(next.resultFile);
    const r = sb.cf("built", "--slug", "demo");
    assert.equal(r.status, 3, `${label}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /the commit this loop started from/, label);
  }
});

test("B3 (unit): testChanges against a commit that is not an ancestor of HEAD fails closed", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  baseWithTest(sb);
  sh(sb.repo, "git", ["switch", "-q", "-c", "other"]);
  fs.writeFileSync(`${sb.repo}/other.txt`, "x\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "other");
  const other = sh(sb.repo, "git", ["rev-parse", "HEAD"]);
  sh(sb.repo, "git", ["switch", "-q", "feature"]);
  const { problems } = testChanges(sb.repo, other, "");
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /HEAD does not descend from/);
});

// ---- B4: 1.4 behaviour only on 1.4 loops ---------------------------------------------------
// Rule: a behaviour introduced by a version is gated on the loop's recorded policy; a loop with no
// 1.4 record (no policy, no approved-spec record) keeps the 1.3 rules; a loop with a 1.4 record that
// lost part of it fails closed.

function as13(sb) {
  baseWithTest(sb);
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--json").json();
  const st = readState(sb);
  for (const k of ["policy", "decided", "roundOffset", "firstCodePass", "specReview", "specSnapshot"]) delete st[k];
  writeState(sb, st);
  fs.rmSync(`${sb.repo}/.crossfire/runs/demo/spec-approved.md`, { force: true });
  fs.rmSync(`${sb.repo}/.git/crossfire/approved-specs`, { recursive: true, force: true });
  return next;
}

test("breaker: a loop started on 1.3 (no policy, no approved-spec record) keeps 1.3 behaviour: the new test guard is not applied", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = as13(sb);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, V2_TEST);
  gitc(sb.repo, "add", "-A");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.doesNotMatch(r.stdout + r.stderr, /weakens tests/, "1.3 loop refused by the 1.4 test guard");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("B4: a 1.3 loop may delete an existing test file and add a skip call in a new one, as 1.3 allowed", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = as13(sb);
  fs.rmSync(`${sb.repo}/tests/app.test.mjs`);
  fs.writeFileSync(`${sb.repo}/tests/later.test.mjs`, `test${SKIP}'later', () => {});\n`);
  gitc(sb.repo, "add", "-A");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.doesNotMatch(r.stdout + r.stderr, /weakens tests/);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("B4: a 1.4 loop whose state lost its policy but whose approved-spec record remains is still guarded (fail closed)", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  baseWithTest(sb);
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--json").json();
  const st = readState(sb);
  for (const k of ["policy", "decided", "specSnapshot"]) delete st[k];
  writeState(sb, st);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, V2_TEST);
  gitc(sb.repo, "add", "-A");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /weakens tests: tests\/app\.test\.mjs/);
});

test("B4: a 1.4 loop (policy 2) refuses the same test update the 1.3 loop accepts", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  baseWithTest(sb);
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--json").json();
  assert.equal(readState(sb).policy, 2);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, V2_TEST);
  gitc(sb.repo, "add", "-A");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /weakens tests: tests\/app\.test\.mjs:2: removes a line from an existing test file/);
});

// ---- B5 (disputed): the owner narrowed AC-9 to name-based test files ------------------------
// Owner decision: a test file is known by its name only; helpers, fixtures and other files under
// tests/ are not test files. The docs state that definition exactly.

test("B5: the name-based test-file definition is stated in the README, CHANGELOG, spec template and builder agent", () => {
  const def = "A test file is known by its name: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*.py`, or under `__tests__/`; helpers and fixtures are not test files.";
  const root = new URL("..", import.meta.url).pathname;
  for (const f of ["README.md", "CHANGELOG.md", "plugins/crossfire/skills/loop/references/spec-template.md", "plugins/crossfire/agents/builder.md"]) {
    assert.ok(fs.readFileSync(`${root}${f}`, "utf8").includes(def), `${f} does not state the name-based definition`);
  }
});

test("B5: a file under tests/ that is not named as a test (a helper) is not a test file, by the owner's definition", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  baseWithTest(sb);
  const base = sh(sb.repo, "git", ["rev-parse", "main"]);
  fs.writeFileSync(`${sb.repo}/tests/smoke.mjs`, "// nothing\n");
  gitc(sb.repo, "commit", "-qam", "change a helper");
  assert.deepEqual(testChanges(sb.repo, base, "").problems, []);
});
