// 1.4.0 fix: spec-review never writes its review documents through a symlink.
// Rule: every file spec-review writes under .crossfire/specs/ goes through one guarded write that
// refuses a symlinked .crossfire, .crossfire/specs or target, and replaces (never follows) the
// final path by renaming a fresh temporary file over it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandbox, approve, gitc } from "./helpers.mjs";
import { writeSpecReviewFile, checkSpecReviewPaths, replaceFile } from "../plugins/crossfire/scripts/lib/specreview.mjs";

const reviewCalls = (sb) => sb.calls("codex").filter((a) => a[0] === "adversarial-review");

/** A spec outside .crossfire, so a symlinked .crossfire cannot hide it. */
function specOutside(sb) {
  const spec = path.join(sb.tmp, "symlink-spec.md");
  fs.writeFileSync(spec, "# Spec\n\n- AC-1: print v2.\n\n## How this could fail\n\n- a\n- b\n- c\n");
  return spec;
}

function runSpecReview(sb, spec) {
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  return sb.cf("spec-review", "--slug", "demo", "--spec", spec, "--base", "main");
}

/** Commit `rel` (a symlink under the ignored .crossfire/) on the feature branch. */
function commitTracked(sb, rel) {
  gitc(sb.repo, "add", "-f", "--", rel);
  gitc(sb.repo, "commit", "-qm", "tracked symlink");
}

test("FM-1/AC-1: a tracked symlink at .crossfire/specs/<slug>.review.md is refused; its target is unchanged and nothing is written", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const outside = path.join(sb.tmp, "outside.txt");
  fs.writeFileSync(outside, "keep me\n");
  fs.mkdirSync(`${sb.repo}/.crossfire/specs`, { recursive: true });
  fs.symlinkSync(outside, `${sb.repo}/.crossfire/specs/demo.review.md`);
  commitTracked(sb, ".crossfire/specs/demo.review.md");
  const r = runSpecReview(sb, specOutside(sb));
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /demo\.review\.md/);
  assert.match(r.stderr, /symlink/);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep me\n");
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/specs/demo.review.json`), "the json was not written either");
  assert.ok(fs.lstatSync(`${sb.repo}/.crossfire/specs/demo.review.md`).isSymbolicLink(), "the symlink is left as it was");
  assert.equal(reviewCalls(sb).length, 0, "refused before any reviewer ran");
});

test("FM-1/AC-1: a symlink at .crossfire/specs/<slug>.review.json is refused; its target is unchanged", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const outside = path.join(sb.tmp, "outside.json");
  fs.writeFileSync(outside, "{}\n");
  fs.mkdirSync(`${sb.repo}/.crossfire/specs`, { recursive: true });
  fs.symlinkSync(outside, `${sb.repo}/.crossfire/specs/demo.review.json`);
  const r = runSpecReview(sb, specOutside(sb));
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /demo\.review\.json.*symlink/);
  assert.equal(fs.readFileSync(outside, "utf8"), "{}\n");
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/specs/demo.review.md`));
});

test("FM-2/AC-1: a tracked symlinked .crossfire/specs directory is refused; nothing is written into the directory it points to", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const outsideDir = path.join(sb.tmp, "outside-specs");
  fs.mkdirSync(outsideDir);
  fs.mkdirSync(`${sb.repo}/.crossfire`);
  fs.symlinkSync(outsideDir, `${sb.repo}/.crossfire/specs`);
  commitTracked(sb, ".crossfire/specs");
  const r = runSpecReview(sb, specOutside(sb));
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /\.crossfire\/specs.*symlink/);
  assert.deepEqual(fs.readdirSync(outsideDir), []);
  assert.equal(reviewCalls(sb).length, 0);
});

test("FM-2/AC-1: a symlinked .crossfire directory is refused; nothing is written into the directory it points to", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const outsideDir = path.join(sb.tmp, "outside-crossfire");
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, `${sb.repo}/.crossfire`);
  commitTracked(sb, ".crossfire");
  const r = runSpecReview(sb, specOutside(sb));
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /\.crossfire.*symlink/);
  assert.deepEqual(fs.readdirSync(outsideDir), []);
});

test("FM-3: a first run with no .crossfire writes both review documents as regular files, and a second run replaces them", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire`));
  const spec = specOutside(sb);
  let r = runSpecReview(sb, spec);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  for (const f of ["demo.review.json", "demo.review.md"]) assert.ok(fs.lstatSync(`${sb.repo}/.crossfire/specs/${f}`).isFile(), f);
  assert.equal(JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/specs/demo.review.json`, "utf8")).slug, "demo");
  assert.match(fs.readFileSync(`${sb.repo}/.crossfire/specs/demo.review.md`, "utf8"), /^# Crossfire spec review: demo/);
  r = runSpecReview(sb, spec);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.deepEqual(fs.readdirSync(`${sb.repo}/.crossfire/specs`).sort(), ["demo.review.json", "demo.review.md"], "no temporary files left behind");
});

// ---- the guarded write itself ------------------------------------------------------------

function tmpRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "crossfire-symlink-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

test("AC-2: replaceFile renames a new temporary file over a symlink planted after the check, never writing through it", (t) => {
  const dir = tmpRepo(t);
  const outside = path.join(dir, "outside.txt");
  fs.writeFileSync(outside, "keep me\n");
  const target = path.join(dir, "doc.md");
  fs.symlinkSync(outside, target);
  replaceFile(target, "new\n");
  assert.equal(fs.readFileSync(outside, "utf8"), "keep me\n");
  assert.ok(fs.lstatSync(target).isFile());
  assert.equal(fs.readFileSync(target, "utf8"), "new\n");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["doc.md", "outside.txt"]);
});

test("AC-1: checkSpecReviewPaths names the symlinked path; a directory or other non-file at the target is refused too", (t) => {
  const repo = tmpRepo(t);
  const target = path.join(repo, ".crossfire", "specs", "demo.review.md");
  checkSpecReviewPaths(repo, [target]); // nothing there yet: fine
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target);
  assert.throws(() => checkSpecReviewPaths(repo, [target]), /demo\.review\.md.*not a regular file/);
  fs.rmdirSync(target);
  fs.symlinkSync(path.join(repo, "elsewhere"), target);
  assert.throws(() => checkSpecReviewPaths(repo, [target]), (e) => e.message.includes(target) && /symlink/.test(e.message));
});

test("AC-3: writeSpecReviewFile refuses a path outside .crossfire/specs/ and writes a fresh path under it", (t) => {
  const repo = tmpRepo(t);
  assert.throws(() => writeSpecReviewFile(repo, path.join(repo, "app.txt"), "x"), /\.crossfire\/specs/);
  assert.throws(() => writeSpecReviewFile(repo, path.join(repo, ".crossfire", "specs", "..", "x.md"), "x"), /\.crossfire\/specs/);
  const file = path.join(repo, ".crossfire", "specs", "demo.review.md");
  writeSpecReviewFile(repo, file, "hello\n");
  assert.equal(fs.readFileSync(file, "utf8"), "hello\n");
});
