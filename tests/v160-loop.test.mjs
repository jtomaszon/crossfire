// 1.6.0 end to end, loops: `where` shorthand through `built` (E2E-1), the test guard's hint (E2E-2)
// and invariants at init (E2E-6). The real CLI in a throwaway repository with fake reviewers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, approve, needs, finding, gitc } from "./helpers.mjs";

function init(sb, ...extra) {
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json", ...extra);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.json();
}

// ---- E2E-1 -----------------------------------------------------------------------------

test("E2E-1: built accepts a fix whose where is 'a.ts:10, 20-30' (a bare range inherits the file)", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("medium", "a.ts misses a check", "a.ts", 10)));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  assert.equal(next.next.brief, "fix");
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED", note: "checked", where: "a.ts:10, 20-30" }] });
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /MALFORMED/);
  assert.match(r.stdout, /NEXT ACTION: RUN_REVIEW/);
});

test("AC-3: a where that names a non-test file with no line is still MALFORMED, and the message shows the shorthand", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("medium", "a.ts misses a check", "a.ts", 10)));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED", note: "checked", where: "lib/app.rb" }] });
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /F1: FIXED needs `where`/);
  assert.match(r.stdout, /"lib\/app\.rb:15-20, 40"/, "one shorthand example");
});

// ---- E2E-2 -----------------------------------------------------------------------------

/** A loop whose branch has an existing test file when it starts. */
function loopWithTestFile(sb) {
  fs.mkdirSync(path.join(sb.repo, "tests"));
  fs.writeFileSync(path.join(sb.repo, "tests", "app.test.mjs"), "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "an existing test");
  return init(sb);
}

const HINT = /move them into a new test file/;

test("E2E-2: one appended test in an existing test file is MALFORMED with the move-to-a-new-file hint", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTestFile(sb);
  fs.appendFileSync(path.join(sb.repo, "tests", "app.test.mjs"), "test('b', () => {});\n");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /MALFORMED/);
  assert.match(r.stdout, /tests\/app\.test\.mjs:4: adds a line to an existing test file/);
  assert.match(r.stdout, HINT);
  assert.match(r.stdout, /tests\/app\.test\.mjs/);
  assert.match(r.stdout, /Allowed test changes/);
});

test("E2E-2/FM-1: one changed line in an existing test file is MALFORMED naming the removed line, without the hint", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTestFile(sb);
  fs.writeFileSync(path.join(sb.repo, "tests", "app.test.mjs"), "test('a', () => {\n  assert.equal(1, 2);\n});\n");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /tests\/app\.test\.mjs:2: removes a line from an existing test file/);
  assert.doesNotMatch(r.stdout, HINT);
});

test("FM-1: a skip call in a new test file is MALFORMED without the hint", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  fs.mkdirSync(path.join(sb.repo, "tests"));
  fs.writeFileSync(path.join(sb.repo, "tests", "new.test.mjs"), `test${"." + "skip("}'n', () => {});\n`);
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /adds a skip or focus call/);
  assert.doesNotMatch(r.stdout, HINT);
});

// ---- E2E-6 -----------------------------------------------------------------------------

const runDirOf = (sb) => `${sb.repo}/.crossfire/runs/demo`;

test("E2E-6/AC-14: a fresh branch with a failing invariant stops init with exit 2 and creates no run directory", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--invariant", "echo boom-detail-xyz; false");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /echo boom-detail-xyz; false/, "names the invariant");
  assert.match(r.stderr, /boom-detail-xyz/, "with the tail of its output");
  assert.match(r.stderr, /must hold before the change/);
  assert.match(r.stderr, /--e2e/);
  assert.ok(!fs.existsSync(runDirOf(sb)), "no run directory");
  assert.doesNotMatch(r.stdout, /NEXT ACTION/);
});

test("E2E-6/AC-16: a failing E2E command on a fresh branch still starts the loop", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--e2e", "false", "--invariant", "true");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT: 2 proof command\(s\) can run here \(1 fail before the build, as expected\)/);
});

test("E2E-6/AC-15: a branch with commits on top of the base starts with a failing invariant, and PREFLIGHT says so", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  fs.writeFileSync(path.join(sb.repo, "app.txt"), "v1.5\n");
  gitc(sb.repo, "commit", "-qam", "earlier work");
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--invariant", "false", "--invariant", "true");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT: .*1 invariant\(s\) fail before the build/);
});

test("E2E-6/FM-5: an invariant that cannot run here keeps exit 5; --no-preflight still skips everything", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--invariant", "definitely-not-a-command-xyz");
  assert.equal(r.status, 5, r.stderr);
  assert.ok(!fs.existsSync(runDirOf(sb)));
  r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--invariant", "false", "--no-preflight");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT: skipped \(--no-preflight\)/);
});

test("FM-5: an environment failure wins over a failing invariant (exit 5, not 2)", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--invariant", "false", "--e2e", "definitely-not-a-command-xyz");
  assert.equal(r.status, 5, r.stderr);
});

test("FM-5: a --from-check loop whose pull request breaks an invariant still starts", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  fs.writeFileSync(path.join(sb.repo, "app.txt"), "v2\n");
  gitc(sb.repo, "commit", "-qam", "the pull request");
  sb.queue("codex", needs(finding("medium", "x")));
  sb.queue("grok", approve);
  assert.equal(sb.cf("check", "--base", "main", "--name", "c1").status, 0);
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--from-check", "c1", "--invariant", "grep -q v1 app.txt");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 invariant\(s\) fail before the build/);
});
