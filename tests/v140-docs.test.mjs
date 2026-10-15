// 1.4.0 docs and release: the template, skills, builder agent, README and CHANGELOG describe the
// new flow and defaults, with generic examples only; the version matches in its three places.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, CLI } from "./helpers.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const PLUGIN = "plugins/crossfire";

test("AC-16: the spec template asks for owners, what is deleted, the Risk line and allowed test changes", () => {
  const t = read(`${PLUGIN}/skills/loop/references/spec-template.md`);
  assert.match(t, /^## Requirements and owners$/m);
  assert.match(t, /owner/i);
  assert.match(t, /drop first/i);
  assert.match(t, /^## What we're deleting$/m);
  assert.match(t, /^\*\*Risk:\*\* low \| high/m);
  assert.match(t, /high turns on the breaker/);
  assert.match(t, /^## Allowed test changes \(optional\)$/m);
});

test("AC-4/AC-14: the loop skill runs spec-review once, records responses, and adds precedents only on the person's explicit words", () => {
  const s = read(`${PLUGIN}/skills/loop/SKILL.md`);
  assert.match(s, /crossfire spec-review --slug <slug> --spec <spec path> --plan <plan path>/);
  assert.match(s, /\.review-response\.md/);
  assert.match(s, /one line per finding/);
  assert.match(s, /A second spec review only when the user asks/);
  assert.match(s, /crossfire precedent add/);
  assert.match(s, /only on the person's explicit words, never by an agent's own decision/);
  assert.match(s, /SPEC_MISMATCH/);
  assert.match(s, /`--max-rounds` \(default 2 with a current spec review, 3 without\)/);
  assert.match(s, /SPEC REVIEW:/);
});

test("AC-17: the review skill, builder agent, README and CHANGELOG describe 1.4.0", () => {
  const review = read(`${PLUGIN}/skills/review/SKILL.md`);
  assert.match(review, /grok: skipped/);
  assert.match(review, /Settled by the owner/);
  assert.match(review, /past about 400 lines or 10 files/);
  const builder = read(`${PLUGIN}/agents/builder.md`);
  assert.match(builder, /SPEC_MISMATCH/);
  assert.match(builder, /handoff/);
  const readme = read("README.md");
  assert.match(readme, /^## Prove the spec$/m);
  assert.match(readme, /crossfire spec-review/);
  assert.match(readme, /crossfire precedent add/);
  assert.match(readme, /\| G2 round cap \|.*default 2 with a current spec review, 3 without/);
  assert.match(readme, /\| SPEC \|/);
  const changelog = read("CHANGELOG.md");
  assert.match(changelog.split("\n## ")[1], /^1\.4\.0\n/, "1.4.0 is the newest entry");
});

test("AC-17: the public docs carry generic examples only (no local paths or host names)", () => {
  const docs = ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "docs/workflow.md", `${PLUGIN}/skills/loop/SKILL.md`, `${PLUGIN}/skills/review/SKILL.md`, `${PLUGIN}/skills/loop/references/spec-template.md`, `${PLUGIN}/agents/builder.md`, `${PLUGIN}/agents/breaker.md`];
  for (const d of docs) {
    const text = read(d);
    assert.doesNotMatch(text, /\/home\/[a-z]|\/Users\/[a-z]/i, d);
  }
});

test("the version is 1.4.0 in package.json, plugin.json and the CLI", () => {
  assert.equal(JSON.parse(read("package.json")).version, "1.4.0");
  assert.equal(JSON.parse(read(`${PLUGIN}/.claude-plugin/plugin.json`)).version, "1.4.0");
  const r = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "1.4.0");
});

test("R4: README, spec template, CHANGELOG, loop skill and builder agent state the test rule in one sentence", () => {
  const rule = /existing test files are not changed unless the spec allows it; add new tests in new files/i;
  for (const f of ["README.md", "CHANGELOG.md", `${PLUGIN}/skills/loop/references/spec-template.md`, `${PLUGIN}/skills/loop/SKILL.md`, `${PLUGIN}/agents/builder.md`]) {
    const t = read(f);
    assert.match(t, rule, f);
    assert.doesNotMatch(t, /may only grow|stop existing ones from running/i, `${f} still describes the old rule`);
  }
});
