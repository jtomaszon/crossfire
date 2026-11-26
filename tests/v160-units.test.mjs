// 1.6.0 units: the `where` shorthand (E2E-1), the test guard's hint (AC-4/5, FM-1), the spec review's
// question about existing tests (E2E-3), and Grok sign-in classification (AC-10, FM-4).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validWhere, WHERE_RE } from "../plugins/crossfire/scripts/lib/briefs.mjs";
import { testChanges } from "../plugins/crossfire/scripts/lib/testguard.mjs";
import { buildSpecFocus } from "../plugins/crossfire/scripts/lib/specreview.mjs";
import { autoSkip, readHealth, signInFailure, summarize } from "../plugins/crossfire/scripts/lib/health.mjs";

// ---- R1: where ------------------------------------------------------------------------

test("E2E-1: validWhere accepts the shorthand builders write and rejects what it always rejected", () => {
  for (const ok of ["a.ts:10", "a.ts:10-20, 30-40", "a.ts:1, b.ts:2-3, 9", "tests/x.test.mjs", "a.ts:5, tests/x_spec.rb", "a.ts:10, 20-30", "App.tsx:349-372, 414-419", "tests/x.test.mjs, 12", "a.ts:1,2,3-4", "test_app.py, src/a.py:3"]) {
    assert.ok(validWhere(ok), ok);
  }
  for (const bad of ["", "10", "10, a.ts:2", "lib/app.rb", "a.ts:0", "a.ts:5-3", "a.ts:1, 0", "a.ts:1, 5-3", "a.ts:1,", ", a.ts:1", "a.ts:1,,2", "lib/app.rb, 10", "a.ts:1, lib/app.rb", "my file.ts:3", "C:\\src\\a.ts:3", "a.ts:1 2", "tests/x.test.mjs:0", "a.ts:-3", "a.ts:1-", "near line 12", null, undefined]) {
    assert.ok(!validWhere(bad), String(bad));
  }
});

test("FM-2: a bare item inherits the most recent file, never a file that is not named", () => {
  assert.ok(validWhere("a.ts:10, 20-30"), "means a.ts:20-30");
  assert.ok(!validWhere("10, a.ts:20"), "a leading bare line has no file to inherit");
  assert.ok(!validWhere("20-30"), "a bare range alone has no file");
  assert.ok(!validWhere("lib/app.rb"), "a non-test file alone has no line");
  assert.ok(!validWhere("src/helpers.mjs"), "a helper is not a test file");
  assert.ok(!validWhere("tests/fixtures/fake.mjs"), "a fixture is not a test file");
  assert.ok(validWhere("src/__tests__/a.js"), "a file under __tests__ is a test file");
});

test("WHERE_RE keeps its old meaning for anything that imports it", () => {
  assert.ok(WHERE_RE.test("src/a.mjs:12"));
  assert.ok(!WHERE_RE.test("src/a.mjs"));
});

// ---- R2: the test guard's hint ----------------------------------------------------------

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crossfire-v160-guard-"));
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
  write("tests/app.test.mjs", "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  write("tests/other.test.mjs", "test('o', () => {\n  assert.equal(1, 1);\n});\n");
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

const SKIP_CALL = "." + "skip(";

test("AC-4/AC-5: an existing test file that only gained lines gets a hint; its problems are the same strings as before", (t) => {
  const r = gitRepo();
  t.after(() => r.cleanup());
  r.write("tests/app.test.mjs", "test('a', () => {\n  assert.equal(1, 1);\n});\ntest('b', () => {});\n");
  r.commit();
  const res = testChanges(r.dir, r.base, "");
  assert.deepEqual(res.problems, ["tests/app.test.mjs:4: adds a line to an existing test file: \"test('b', () => {});\""]);
  assert.deepEqual(res.hints, ["tests/app.test.mjs"]);
});

test("FM-1: no hint for a removed or changed line, a deletion, a skip call in a new file, or an allowed file", (t) => {
  const changed = gitRepo();
  t.after(() => changed.cleanup());
  changed.write("tests/app.test.mjs", "test('a', () => {\n  assert.equal(1, 2);\n});\n");
  changed.commit();
  let res = testChanges(changed.dir, changed.base, "");
  assert.equal(res.problems.length, 2, JSON.stringify(res));
  assert.match(res.problems[0], /^tests\/app\.test\.mjs:2: removes a line from an existing test file/);
  assert.deepEqual(res.hints, []);

  const both = gitRepo();
  t.after(() => both.cleanup());
  both.write("tests/app.test.mjs", "test('a', () => {\n  assert.equal(1, 1);\n});\ntest('b', () => {});\n");
  both.write("tests/other.test.mjs", "test('o', () => {\n});\n");
  both.write("tests/new.test.mjs", `test${SKIP_CALL}'n', () => {});\n`);
  both.commit();
  res = testChanges(both.dir, both.base, "");
  assert.deepEqual(res.hints, ["tests/app.test.mjs"], "only the file whose problems are all added lines");
  assert.ok(res.problems.some((p) => p.startsWith("tests/new.test.mjs:1: adds a skip or focus call")), JSON.stringify(res));

  const gone = gitRepo();
  t.after(() => gone.cleanup());
  gone.g("rm", "-q", "tests/app.test.mjs");
  gone.commit();
  res = testChanges(gone.dir, gone.base, "");
  assert.deepEqual(res.problems, ["tests/app.test.mjs: deletes a test file"]);
  assert.deepEqual(res.hints, []);

  const allowed = gitRepo();
  t.after(() => allowed.cleanup());
  allowed.write("tests/app.test.mjs", "test('a', () => {\n  assert.equal(1, 1);\n});\ntest('b', () => {});\n");
  allowed.commit();
  res = testChanges(allowed.dir, allowed.base, "# S\n\n## Allowed test changes\n\n- `tests/app.test.mjs`\n");
  assert.deepEqual(res, { problems: [], hints: [] });
});

// ---- R2: the spec review's question -------------------------------------------------------

test("E2E-3: the spec review asks which existing tests pin behaviour the spec changes and are not in Allowed test changes", () => {
  const focus = buildSpecFocus({ slug: "demo", base: "main", hasPlan: true });
  assert.match(focus, /existing test files? .*pin behaviour the spec changes/i);
  assert.match(focus, /"Allowed test changes" section does not name/);
  assert.match(focus, /as a gap/);
});

// ---- R4: sign-in ----------------------------------------------------------------------------

const SIGNED_OUT = "exit 1: Error: Not signed in. To authenticate without a browser, run:";

test("AC-10/FM-4: sign-in failures are classified from the stored first line only", () => {
  for (const yes of [SIGNED_OUT, "not logged in", "Please log in first", "please sign in", "401 Unauthenticated", "run `grok login`"]) assert.ok(signInFailure(yes), yes);
  for (const no of ["timed out after 1200s", "sandbox could not be applied", "", null, undefined, 42, { toString: () => "not signed in" }, ["not signed in"]]) assert.ok(!signInFailure(no), String(no));
});

test("AC-10: summarize says whether the latest attempt is a sign-in failure; a later success clears it", () => {
  const at = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  assert.equal(summarize({ grok: [{ ok: false, at: at(2), error: SIGNED_OUT }] }, "grok").lastFailureSignIn, true);
  assert.equal(summarize({ grok: [{ ok: false, at: at(2), error: SIGNED_OUT }, { ok: true, at: at(1) }] }, "grok").lastFailureSignIn, false);
  assert.equal(summarize({ grok: [{ ok: false, at: at(2), error: SIGNED_OUT }, { ok: false, at: at(1), error: "timed out after 900s" }] }, "grok").lastFailureSignIn, false);
  assert.equal(summarize({ grok: [{ ok: false, at: at(1) }] }, "grok").lastFailureSignIn, false, "an entry without error");
  assert.equal(summarize({}, "grok").lastFailureSignIn, false, "no history");
});

test("AC-12/FM-4: autoSkip names the sign-in; timeouts keep today's wording; readHealth stores nothing new", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crossfire-v160-health-"));
  try {
    const at = (h) => new Date(Date.now() - h * 3600_000).toISOString();
    const file = path.join(dir, "reviewers.json");
    fs.writeFileSync(file, JSON.stringify({ grok: [3, 2, 1].map((h) => ({ ok: false, at: at(h), seconds: 1, error: SIGNED_OUT, signIn: true })) }));
    const h = readHealth(file);
    assert.deepEqual(Object.keys(h.grok[0]).sort(), ["at", "error", "ok", "seconds"], "no new stored field survives");
    const s = autoSkip(h, "grok");
    assert.equal(s.signIn, true);
    assert.match(s.line, /^grok: skipped \(not signed in; run grok login/);
    const timeouts = { grok: [3, 2, 1].map((x) => ({ ok: false, at: at(x), seconds: 900, error: "timed out after 900s" })) };
    assert.equal(autoSkip(timeouts, "grok").line, "grok: skipped (failed the last 3 times on this machine; crossfire doctor shows why; it is tried again after 7 days or with --grok on)");
    assert.equal(autoSkip(timeouts, "grok").signIn, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
