import test from "node:test";
import assert from "node:assert/strict";
import { validateBuildResult, renderBrief } from "../plugins/crossfire/scripts/lib/briefs.mjs";
import { newState, afterBuild, afterReview } from "../plugins/crossfire/scripts/lib/referee.mjs";
import { parseReviewPayload, buildFocus } from "../plugins/crossfire/scripts/lib/reviewers.mjs";
import { compareVersions, reviewerEnv } from "../plugins/crossfire/scripts/lib/plugins.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const at = "2026-10-09T00:00:00.000Z";
const t = { at, minutesElapsed: 1 };
const clean = { head: "a".repeat(40), dirty: [], ahead: 1 };

function stateWithFinding(severity = "CHANGES") {
  const s = newState({ slug: "x", repo: "/r", spec: "/s.md", base: "main", baseSha: "abc", startedAt: at, e2e: ["make e2e"], breaker: false });
  afterBuild(s, { status: "DONE", summary: "ok", fixes: [] }, { passed: true, failures: [] }, t);
  afterReview(s, [{ reviewer: "codex", ok: true, verdict: "needs-attention", summary: "", findings: [{ severity, title: "unchecked input", body: "b", file: "a.js", lineStart: 3, lineEnd: 3, recommendation: "check it" }] }], t);
  return s;
}

const RULE = { rule: "every write goes through the one versioned writer", where: "a.js:3", variants: [{ scenario: "a", test: "t_a" }, { scenario: "b", test: "t_b" }, { scenario: "c", test: "t_c" }] };
const good = (fixes = []) => ({ status: "DONE", summary: "ok", commit: "a".repeat(40), tests: [{ name: "t1", passed: true }], fixes: fixes.map((f) => (f.status === "FIXED" ? { ...RULE, ...f } : f)) });

test("a complete result validates", () => {
  assert.deepEqual(validateBuildResult(good([{ id: "F1", status: "FIXED" }]), stateWithFinding(), clean), []);
});

test("every owed finding must be answered", () => {
  assert.match(validateBuildResult(good(), stateWithFinding(), clean).join(), /must answer F1/);
});

test("WONTFIX is refused for anything above a nit", () => {
  assert.match(validateBuildResult(good([{ id: "F1", status: "WONTFIX" }]), stateWithFinding(), clean).join(), /only for NIT/);
});

test("DONE needs a clean tree, HEAD as the commit, commits on top of base and passing tests", () => {
  const s = stateWithFinding();
  const r = good([{ id: "F1", status: "FIXED" }]);
  assert.match(validateBuildResult(r, s, { ...clean, dirty: [" M a.js"] }).join(), /not clean/);
  assert.match(validateBuildResult(r, s, { ...clean, head: "b".repeat(40) }).join(), /is not HEAD/);
  assert.match(validateBuildResult(r, s, { ...clean, ahead: 0 }).join(), /no commits/);
  assert.match(validateBuildResult({ ...r, tests: [{ name: "t", passed: false }] }, s, clean).join(), /did not pass/);
});

test("the fix brief frames findings as rules, lists G0 commands and names the result file", () => {
  const s = stateWithFinding();
  const brief = renderBrief(s, { resultFile: "/tmp/r.json", branch: "feature" });
  assert.match(brief, /evidence of a rule being broken/);
  assert.match(brief, /make e2e/);
  assert.match(brief, /\/tmp\/r\.json/);
  assert.match(brief, /F1 · CHANGES · a\.js:3/);
});

test("the review payload of the official plugins parses; broken ones do not", () => {
  const ok = parseReviewPayload(JSON.stringify({ result: { verdict: "approve", summary: "s", findings: [{ severity: "high", title: "x", body: "y", file: "a.js", line_start: 2, line_end: 4, confidence: 0.5, recommendation: "" }], next_steps: [] } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.findings[0].severity, "BLOCKER");
  assert.equal(ok.findings[0].lineEnd, 4);
  assert.equal(parseReviewPayload("not json").ok, false);
  assert.equal(parseReviewPayload(JSON.stringify({ result: null, parseError: "bad" })).ok, false);
  assert.equal(parseReviewPayload(JSON.stringify({ result: { verdict: "maybe", findings: [] } })).ok, false);
});

test("the reviewer focus carries the spec and asks for tags on re-flags", () => {
  const s = stateWithFinding();
  s.ledger[0].status = "claimed_fixed";
  s.ledger[0].history.push({ builder: "FIXED", note: "added check" });
  const focus = buildFocus(s, { specText: "THE SPEC" });
  assert.match(focus, /THE SPEC/);
  assert.match(focus, /\[F1\]/);
  assert.match(focus, /START ITS TITLE WITH ITS TAG/);
});

test("versions compare numerically and ignore commit suffixes", () => {
  assert.equal(compareVersions("1.0.10", "1.0.6"), 1);
  assert.equal(compareVersions("v1.0.6-8713c5b11005", "1.0.6"), 0);
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
});

test("grok missing from a session's PATH: crossfire points xAI's plugin at the installer location", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-home-"));
  try {
    const bin = path.join(home, ".grok", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "grok"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(reviewerEnv("grok", { HOME: home, PATH: "/usr/bin" }).GROK_BINARY, path.join(bin, "grok"));
    assert.equal(reviewerEnv("grok", { HOME: home, PATH: bin }).GROK_BINARY, undefined, "on PATH: left alone");
    assert.equal(reviewerEnv("grok", { HOME: home, PATH: "/usr/bin", GROK_BINARY: "/x/grok" }).GROK_BINARY, "/x/grok", "an explicit GROK_BINARY wins");
    assert.equal(reviewerEnv("codex", { HOME: home, PATH: "/usr/bin" }).GROK_BINARY, undefined, "only Grok");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

import { classifyProofFailure, summarize, recordAttempt, readHealth, grokSocketHint } from "../plugins/crossfire/scripts/lib/health.mjs";

test("proof failures: a command that cannot run here is environment, a failing test is code", () => {
  const bundler = "/System/Library/Frameworks/Ruby.framework/Versions/2.6/usr/lib/ruby/2.6.0/rubygems.rb:283:in `find_spec_for_exe': Could not find 'bundler' (2.4.10) required by your /x/Gemfile.lock. (Gem::GemNotFoundException)";
  assert.equal(classifyProofFailure({ status: 1, output: bundler }), "environment", "a Ruby toolchain mismatch");
  assert.equal(classifyProofFailure({ status: 127, output: "" }), "environment");
  assert.equal(classifyProofFailure({ status: 1, output: "sh: rspecc: command not found" }), "environment");
  assert.equal(classifyProofFailure({ status: 1, output: "Failures:\n  1) Widget#save keeps the name\n     expected 1, got 0" }), "code");
  assert.equal(classifyProofFailure({ status: 1, output: "cannot load such file -- spec/jobs/new_job_spec.rb" }), "code", "a spec file the builder will create");
});

test("reviewer health keeps one-line errors only and counts consecutive failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-health-"));
  try {
    const file = path.join(dir, "reviewers.json");
    recordAttempt("grok", { ok: true, at: "t1", seconds: 30 }, file);
    recordAttempt("grok", { ok: false, at: "t2", seconds: 1, error: "sandbox could not be applied\nsecond line" }, file);
    recordAttempt("grok", { ok: false, at: "t3", seconds: 1, error: "sandbox could not be applied" }, file);
    const h = summarize(readHealth(file), "grok");
    assert.equal(h.consecutiveFailures, 2);
    assert.equal(h.lastOkAt, "t1");
    assert.equal(h.lastError, "sandbox could not be applied");
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /second line/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the macOS Docker-socket hint only applies on macOS", () => {
  assert.equal(grokSocketHint("linux"), null);
});

import { validateBreakerResult } from "../plugins/crossfire/scripts/lib/briefs.mjs";

test("D: fixing a real finding needs the broadest rule and at least 3 tested variants; a nit does not", () => {
  const s = stateWithFinding("CHANGES");
  const bare = { status: "DONE", summary: "ok", commit: "a".repeat(40), tests: [{ name: "t1", passed: true }], fixes: [{ id: "F1", status: "FIXED" }] };
  const problems = validateBuildResult(bare, s, clean).join();
  assert.match(problems, /needs `rule`/);
  assert.match(problems, /at least 3 `variants`/);
  const two = { ...bare, fixes: [{ id: "F1", status: "FIXED", rule: "every write goes through the one writer", variants: [{ test: "a" }, { test: "b" }] }] };
  assert.match(validateBuildResult(two, s, clean).join(), /got 2/);
  const nit = stateWithFinding("NIT");
  assert.deepEqual(validateBuildResult({ ...bare, fixes: [{ id: "F1", status: "FIXED" }] }, nit, clean), []);
});

test("breaker results: only proven attacks count; FAILED counts none; proven ones need a scenario and a test", () => {
  const r = validateBreakerResult({ status: "DONE", attacks: [{ title: "a", scenario: "s", test: "t", file: "a.js", proven: true, severity: "blocker", line: 3 }, { title: "idea", proven: false }] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.attacks.length, 1);
  assert.equal(r.attacks[0].severity, "BLOCKER");
  assert.equal(validateBreakerResult({ status: "FAILED", attacks: [{ title: "a", scenario: "s", test: "t", proven: true }] }).attacks.length, 0);
  assert.match(validateBreakerResult({ status: "DONE", attacks: [{ title: "a", proven: true }] }).problems.join(), /scenario is required/);
});

import { countFailureModes } from "../plugins/crossfire/scripts/crossfire.mjs";

test("A: failure modes are counted under the spec's heading only", () => {
  assert.equal(countFailureModes("# S\n\nnothing"), -1);
  assert.equal(countFailureModes("## How this could fail\n- a\n- b\n1. c\n## Next\n- not counted"), 3);
  assert.equal(countFailureModes("### How it could fail\n* a\n"), 1);
});

import { compareWithPrevious } from "../plugins/crossfire/scripts/lib/referee.mjs";

test("re-check delta: only tagged re-flags are still open; an untagged finding near an old one is new (near Pn) and the old one unclear", () => {
  const prev = [
    { severity: "BLOCKER", title: "token unchecked", file: "a.js", lineStart: 10, lineEnd: 10 },
    { severity: "CHANGES", title: "missing index", file: "db.sql", lineStart: 3, lineEnd: 3 },
    { severity: "NIT", title: "typo", file: "b.js", lineStart: 1, lineEnd: 1 },
  ];
  const now = [
    { severity: "BLOCKER", title: "[P1] token still unchecked on retry", file: "a.js", lineStart: 40, lineEnd: 40 },
    { severity: "CHANGES", title: "index on the wrong column", file: "db.sql", lineStart: 4, lineEnd: 4 },
    { severity: "BLOCKER", title: "new: deadlock", file: "c.js", lineStart: 5, lineEnd: 5 },
  ];
  const d = compareWithPrevious(prev, now);
  assert.deepEqual(d.stillOpen.map((x) => [x.previous.index, x.how]), [[1, "re-flagged"]]);
  assert.deepEqual(d.unclear.map((p) => p.index), [2], "not guessed fixed, not guessed open");
  assert.deepEqual(d.resolved.map((p) => p.index), [3]);
  assert.deepEqual(d.fresh.map((f) => [f.title, f.nearPrevious ?? null]), [["index on the wrong column", [2]], ["new: deadlock", null]]);
});

test("a reviewer that could not review (needs-attention, nothing itemised) is a failed review, not a finding", () => {
  const r = parseReviewPayload(JSON.stringify({ result: { verdict: "needs-attention", summary: "Review blocked: read-only git commands failed with `bwrap: loopback: Failed RTM_NEWADDR`.\nmore", findings: [], next_steps: [] } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /could not complete the review: Review blocked: read-only git commands failed/);
  assert.doesNotMatch(r.error, /more/);
});

test("Grok's wrapped review (JSON inside result.text or structuredOutput) parses; absolute paths become repo-relative", () => {
  const review = { verdict: "needs-attention", summary: "Do not ship.", findings: [{ severity: "critical", title: "traversal", body: "b", file: "/repo/serve.mjs", line_start: 4, line_end: 6, confidence: 0.96, recommendation: "r" }], next_steps: [] };
  const viaText = parseReviewPayload(JSON.stringify({ result: { text: JSON.stringify(review), structuredOutput: null, num_turns: 3 } }), { cwd: "/repo" });
  assert.equal(viaText.ok, true);
  assert.equal(viaText.findings[0].severity, "BLOCKER");
  assert.equal(viaText.findings[0].file, "serve.mjs");
  const fenced = parseReviewPayload(JSON.stringify({ result: { text: "```json\n" + JSON.stringify(review) + "\n```" } }));
  assert.equal(fenced.ok, true);
  const viaStructured = parseReviewPayload(JSON.stringify({ result: { structuredOutput: review, text: "prose" } }));
  assert.equal(viaStructured.ok, true);
  assert.equal(parseReviewPayload(JSON.stringify({ result: { text: "I could not decide." } })).ok, false);
});

import { parseRemoteUrl } from "../plugins/crossfire/scripts/lib/watch.mjs";

test("the watched remote's own repository is used, never gh's default", () => {
  assert.deepEqual(parseRemoteUrl("git@github.com:jtomaszon/crossfire.git"), { host: "github.com", owner: "jtomaszon", repo: "crossfire" });
  assert.deepEqual(parseRemoteUrl("https://github.com/acme/app"), { host: "github.com", owner: "acme", repo: "app" });
  assert.deepEqual(parseRemoteUrl("ssh://git@ghe.example.com:2222/team/svc.git"), { host: "ghe.example.com", owner: "team", repo: "svc" });
  assert.equal(parseRemoteUrl("/tmp/some/bare/repo.git"), null);
});

import { acquireLock } from "../plugins/crossfire/scripts/lib/watch.mjs";

test("lock: an empty (still being written) lock is not stolen; an old empty one is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-lock-"));
  try {
    const file = path.join(dir, "pr.lock");
    fs.writeFileSync(file, "");
    assert.equal(acquireLock(file).heldBy, "starting");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const got = acquireLock(file);
    assert.ok(got.release, "a lock abandoned mid-creation is taken over");
    assert.equal(fs.readFileSync(file, "utf8").trim(), String(process.pid));
    got.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { ghArgs } from "../plugins/crossfire/scripts/lib/watch.mjs";

test("gh calls always name the remote's host, github.com included (GH_HOST cannot redirect them)", () => {
  const gh = { host: "github.com", owner: "acme", repo: "app" };
  assert.deepEqual(ghArgs(gh, ["api", "repos/acme/app/issues/7/comments"]).slice(-2), ["--hostname", "github.com"]);
  assert.deepEqual(ghArgs(gh, ["pr", "view", "7"]).slice(-2), ["--repo", "github.com/acme/app"]);
});

test("a proven breaker attack must say where the bug is (file and line)", () => {
  const problems = validateBreakerResult({ status: "DONE", attacks: [{ title: "a", scenario: "s", test: "t", proven: true }] }).problems.join();
  assert.match(problems, /file is required/);
  assert.match(problems, /line is required/);
});

import { WHERE_RE } from "../plugins/crossfire/scripts/lib/briefs.mjs";

test("where accepts lines and ranges, one or several; not a bare file or prose", () => {
  for (const ok of ["src/a.mjs:12", "src/a.mjs:15-20", "src/a.mjs:24, src/a.mjs:15-20", "test/a_test.rb:3,lib/a.rb:9-11"]) assert.ok(WHERE_RE.test(ok), ok);
  for (const bad of ["somewhere", "src/a.mjs", "src/a.mjs:", "src/a.mjs:12-", "near line 12"]) assert.ok(!WHERE_RE.test(bad), bad);
});

import { reviewersLine } from "../plugins/crossfire/scripts/crossfire.mjs";

test("REVIEWERS says the last verdict when it was not an approval, so 1/1 passes is not read as approved", () => {
  const line = reviewersLine({ reviewPass: 1, reviewerRuns: [{ pass: 1, reviewer: "codex", ok: true, verdict: "needs-attention" }] });
  assert.equal(line, "codex 1/1 passes (last verdict: needs-attention)");
  assert.equal(reviewersLine({ reviewPass: 1, reviewerRuns: [{ pass: 1, reviewer: "codex", ok: true, verdict: "approve" }] }), "codex 1/1 passes");
});

test("re-check delta: every earlier finding near an untagged one is unclear, at any severity; tags count only at the start", () => {
  const prev = [
    { severity: "BLOCKER", title: "race on write", file: "app.js", lineStart: 10, lineEnd: 10 },
    { severity: "CHANGES", title: "missing check", file: "app.js", lineStart: 12, lineEnd: 12 },
    { severity: "BLOCKER", title: "far away", file: "other.js", lineStart: 50, lineEnd: 50 },
  ];
  const now = [
    { severity: "CHANGES", title: "partial fix still racy", file: "app.js", lineStart: 11, lineEnd: 11 },
    { severity: "NIT", title: "see [P3] for context", file: "z.js", lineStart: 1, lineEnd: 1 },
  ];
  const d = compareWithPrevious(prev, now);
  assert.deepEqual(d.unclear.map((p) => p.index), [1, 2]);
  assert.deepEqual(d.resolved.map((p) => p.index), [3], "an unanchored [P3] does not re-flag P3");
  assert.deepEqual(d.stillOpen, []);
  assert.deepEqual(d.fresh.map((f) => [f.title, f.nearPrevious ?? null]), [["partial fix still racy", [1, 2]], ["see [P3] for context", null]]);
});

import { validWhere } from "../plugins/crossfire/scripts/lib/briefs.mjs";

test("where: lines start at 1 and ranges run forward", () => {
  for (const ok of ["a.js:1", "src/x.mjs:15-20", "a.js:3, b.js:9-9"]) assert.ok(validWhere(ok), ok);
  for (const bad of ["a.js:0", "a.js:20-1", "a.js:0-3", "somewhere", "", "a.js:5, b.js:0"]) assert.ok(!validWhere(bad), bad);
});

test("re-check: a tagged re-flag keeps its neighbours unclear; tags from every merged reviewer count", () => {
  const prev = [
    { severity: "BLOCKER", title: "racy", file: "app.js", lineStart: 10, lineEnd: 10 },
    { severity: "BLOCKER", title: "neighbour", file: "app.js", lineStart: 12, lineEnd: 12 },
  ];
  const d = compareWithPrevious(prev, [{ severity: "BLOCKER", title: "[P1] still racy", file: "app.js", lineStart: 11, lineEnd: 11 }]);
  assert.deepEqual(d.stillOpen.map((x) => x.previous.index), [1]);
  assert.deepEqual(d.unclear.map((p) => p.index), [2]);
  assert.deepEqual(d.resolved, []);
  const merged = { severity: "BLOCKER", title: "[P1] still racy", alsoTitles: ["[P2] neighbour too"], file: "app.js", lineStart: 11, lineEnd: 11 };
  assert.deepEqual(compareWithPrevious(prev, [merged]).stillOpen.map((x) => x.previous.index), [1, 2]);
});

test("the builder result example in the brief passes the where check", () => {
  const src = fs.readFileSync(new URL("../plugins/crossfire/scripts/lib/briefs.mjs", import.meta.url), "utf8");
  const example = /where: "([^"]+)"/.exec(src)[1];
  assert.ok(validWhere(example), example);
});

test("re-check: a merged finding is near every earlier finding at any reviewer's location", () => {
  const prev = [
    { severity: "BLOCKER", title: "a", file: "a.js", lineStart: 10, lineEnd: 10 },
    { severity: "BLOCKER", title: "b", file: "a.js", lineStart: 16, lineEnd: 16 },
  ];
  const merged = { severity: "BLOCKER", title: "[P1] a again", alsoTitles: ["near b"], alsoAt: [{ file: "a.js", lineStart: 13, lineEnd: 13 }], file: "a.js", lineStart: 10, lineEnd: 10 };
  const d = compareWithPrevious(prev, [merged]);
  assert.deepEqual(d.unclear.map((p) => p.index), [2]);
  assert.deepEqual(d.resolved, []);
});
