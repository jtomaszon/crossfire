// 1.6.0 docs and release (AC-18): the version in its three places, a CHANGELOG entry for R1-R6, and
// the docs that describe the changed behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, CLI } from "./helpers.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const PLUGIN = "plugins/crossfire";

test("AC-18: version 1.6.0 in package.json, plugin.json and the CLI", () => {
  assert.equal(JSON.parse(read("package.json")).version, "1.6.0");
  assert.equal(JSON.parse(read(`${PLUGIN}/.claude-plugin/plugin.json`)).version, "1.6.0");
  assert.equal(spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }).stdout.trim(), "1.6.0");
});

test("AC-18: the CHANGELOG 1.6.0 entry covers where, the test guard hint, merge-base, Grok sign-in and timeout, invariants and the size warning", () => {
  const entry = read("CHANGELOG.md").split("\n## ")[1];
  assert.match(entry, /^1\.6\.0\n/);
  for (const re of [/`where`/, /HINT:/, /pin behaviour the spec changes/, /merge-base/, /grok login/, /15 minutes/, /--invariant/, /size warning/i]) assert.match(entry, re);
});

test("AC-18: README, skills and the spec template describe the changed behaviour", () => {
  const readme = read("README.md");
  assert.match(readme, /App\.tsx:349-372, 414-419/);
  assert.match(readme, /move the new tests into a new test file/);
  assert.match(readme, /git merge-base <base> HEAD/);
  assert.match(readme, /\*\*Grok not signed in\.\*\*/);
  assert.match(readme, /an invariant must already pass when the branch has no commits on top of the base/);
  assert.match(readme, /`crossfire check` does not print it/);
  const loop = read(`${PLUGIN}/skills/loop/SKILL.md`);
  assert.match(loop, /An \*\*invariant\*\* must already pass before the change/);
  assert.match(loop, /HINT:/);
  const review = read(`${PLUGIN}/skills/review/SKILL.md`);
  assert.doesNotMatch(review, /pass it on to the user/, "the size-warning bullet is gone");
  assert.match(review, /not signed in; run grok login/);
  const template = read(`${PLUGIN}/skills/loop/references/spec-template.md`);
  assert.match(template, /existing tests that pin behaviour this spec changes/);
});
