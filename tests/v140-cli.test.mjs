// 1.4.0 end to end: the real CLI in a throwaway repository, fake `claude` and fake reviewers.
// Spec review, the lean defaults it unlocks, Grok on a broken host, the test guard,
// SPEC_MISMATCH, precedents and the size warning.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, approve, needs, finding, gitc, sh } from "./helpers.mjs";

const git = (sb, ...args) => spawnSync("git", args, { cwd: sb.repo, encoding: "utf8" }).stdout;
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const reviewCalls = (sb, name) => sb.calls(name).filter((a) => a[0] === (name === "codex" ? "adversarial-review" : "critique"));
const statePath = (sb, slug) => `${sb.repo}/.crossfire/runs/${slug}/state.json`;
const readState = (sb, slug) => JSON.parse(fs.readFileSync(statePath(sb, slug), "utf8"));

/** A spec and plan under .crossfire/specs/ (which git ignores), as the loop skill writes them. */
function specAndPlan(sb, slug = "demo", extra = "") {
  const r = sb.cf("spec", "--slug", slug, "--json").json();
  fs.writeFileSync(r.specFile, `# Spec: print v2\n\n## Acceptance criteria\n\n- AC-1: When the app starts, it shall print v2.\n${extra}\n## How this could fail\n\n- the file is missing\n- two writers at once\n- a stale cached value\n`);
  fs.writeFileSync(r.planFile, "# Plan\n\n## Task 1\n\n- write v2 to app.txt\n");
  return r;
}

function specReview(sb, slug, files, ...extra) {
  sb.queue("codex", needs(finding("high", "AC-1 does not say where v2 is printed", `crossfire-spec-review/${slug}.md`, 5)));
  sb.queue("grok", approve);
  const r = sb.cf("spec-review", "--slug", slug, "--spec", files.specFile, "--plan", files.planFile, "--base", "main", ...extra);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r;
}

function initLoop(sb, slug, files, ...extra) {
  const r = sb.cf("init", "--slug", slug, "--spec", files.specFile, "--plan", files.planFile, "--base", "main", "--json", ...extra);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.json();
}

/** Everything spec-review must leave alone. */
function snapshot(sb) {
  const crossfire = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (!/\.review\.(json|md)$/.test(f)) crossfire.push(`${path.relative(sb.repo, p)} ${sha256(p)}`);
    }
  };
  walk(path.join(sb.repo, ".crossfire"));
  return {
    head: git(sb, "rev-parse", "HEAD"),
    branch: git(sb, "symbolic-ref", "HEAD"),
    branches: git(sb, "for-each-ref", "--format=%(refname) %(objectname)"),
    worktrees: git(sb, "worktree", "list", "--porcelain"),
    index: git(sb, "ls-files", "-s"),
    status: git(sb, "status", "--porcelain", "--untracked-files=all"),
    stash: git(sb, "stash", "list"),
    tree: fs.readFileSync(path.join(sb.repo, "app.txt"), "utf8"),
    crossfire,
  };
}

// ---- R1: spec review -----------------------------------------------------------

test("AC-1/AC-1b/FM-2: spec-review has Codex and Grok review the spec and plan as a design, from a diff that contains them", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = specAndPlan(sb);
  sb.env.FAKE_REVIEW_RECORD_DIFF = "1";
  sb.queue("codex", needs(finding("high", "AC-1 does not say where v2 is printed", "crossfire-spec-review/demo.md", 5)));
  sb.queue("grok", needs(finding("medium", "the plan has no test task", "crossfire-spec-review/demo.plan.md", 3)));
  const r = sb.cf("spec-review", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main");
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /SPEC REVIEW demo/);
  assert.match(r.stdout, /REVIEWERS: codex 1\/1 passes \(last verdict: needs-attention\), grok 1\/1 passes \(last verdict: needs-attention\)/);
  assert.match(r.stdout, /1\. high crossfire-spec-review\/demo\.md:5 AC-1 does not say where v2 is printed \(codex\)/);
  assert.match(r.stdout, /2\. medium crossfire-spec-review\/demo\.plan\.md:3 the plan has no test task \(grok\)/);

  const baseSha = git(sb, "rev-parse", "main").trim();
  const review = JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/specs/demo.review.json`, "utf8"));
  assert.equal(review.baseSha, baseSha);
  assert.equal(review.specSha256, sha256(files.specFile));
  assert.equal(review.planSha256, sha256(files.planFile));
  assert.equal(review.findings.length, 2);
  assert.deepEqual(review.reviewers.map((x) => [x.reviewer, x.ok]), [["codex", true], ["grok", true]]);
  assert.ok(Number.isFinite(Date.parse(review.at)));
  const md = fs.readFileSync(`${sb.repo}/.crossfire/specs/demo.review.md`, "utf8");
  assert.match(md, /# Crossfire spec review: demo/);
  assert.match(md, /AC-1 does not say where v2 is printed/);

  // Both reviewers read a commit on the base whose diff is the spec and the plan, at a path git does not ignore.
  for (const name of ["codex", "grok"]) {
    const [d] = sb.diffs(name);
    assert.equal(d.base, baseSha);
    assert.notEqual(d.cwd, sb.repo, "never the user's checkout");
    assert.match(d.diff, /\+\+\+ b\/crossfire-spec-review\/demo\.md/);
    assert.match(d.diff, /\+- AC-1: When the app starts, it shall print v2\./);
    assert.match(d.diff, /\+\+\+ b\/crossfire-spec-review\/demo\.plan\.md/);
    assert.deepEqual([...d.diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]), ["crossfire-spec-review/demo.md", "crossfire-spec-review/demo.plan.md"], "nothing but the spec and plan");
    assert.ok(!fs.existsSync(d.cwd), "the throwaway worktree is gone");
  }
  const focus = reviewCalls(sb, "codex")[0].at(-1);
  assert.match(focus, /Review the document as a design against the repository's current code/);
  assert.ok(!focus.includes("Only report a finding you can tie to a file and line in this diff"));
});

test("AC-2/FM-1: spec-review leaves the branch, index, worktrees, stash and .crossfire/ alone, also when Codex fails or times out", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = specAndPlan(sb);
  // Work in progress the review must not touch: a staged change and an unstaged one.
  fs.writeFileSync(path.join(sb.repo, "staged.txt"), "staged\n");
  gitc(sb.repo, "add", "staged.txt");
  fs.writeFileSync(path.join(sb.repo, "app.txt"), "work in progress\n");
  const before = snapshot(sb);

  sb.queue("codex", "codex crashed");
  sb.queue("grok", approve);
  let r = sb.cf("spec-review", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /the Codex review failed/);
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/specs/demo.review.json`), "a failed review saves nothing");
  assert.deepEqual(snapshot(sb), before);

  sb.queue("codex", approve);
  sb.queue("grok", approve);
  sb.env.FAKE_REVIEW_DELAY_MS = "4000";
  r = sb.cf("spec-review", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main", "--timeout-sec", "1");
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /timed out/);
  assert.deepEqual(snapshot(sb), before);
  delete sb.env.FAKE_REVIEW_DELAY_MS;

  sb.queue("codex", approve);
  sb.queue("grok", approve);
  r = sb.cf("spec-review", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /FINDINGS: none/);
  assert.deepEqual(snapshot(sb), before, "only the two review files are new");
  assert.ok(fs.existsSync(`${sb.repo}/.crossfire/specs/demo.review.json`));
  assert.ok(fs.existsSync(`${sb.repo}/.crossfire/specs/demo.review.md`));
});

test("AC-3/FM-2b: init says whether the spec is the one reviewed: current, revised after review, stale or none", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = specAndPlan(sb);
  let r = sb.cf("init", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main");
  assert.match(r.stdout, /SPEC REVIEW: none/);
  assert.equal(readState(sb, "demo").specReview.status, "none");

  specReview(sb, "demo", files);
  const at = JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/specs/demo.review.json`, "utf8")).at;
  r = sb.cf("init", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main", "--force");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`SPEC REVIEW: current (${at}, 1 findings)`), r.stdout);
  assert.equal(readState(sb, "demo").specReview.status, "current");

  fs.appendFileSync(files.specFile, "\n- AC-2: it prints v2 on stdout.\n");
  r = sb.cf("init", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main", "--force");
  assert.ok(r.stdout.includes(`SPEC REVIEW: stale (the spec changed after ${at} with no recorded response)`), r.stdout);
  assert.match(r.stdout, /WARNING: no current spec review; using the full review defaults\. Run crossfire spec-review first to use the lean ones\./);
  assert.equal(readState(sb, "demo").specReview.status, "stale");

  const response = `${sb.repo}/.crossfire/specs/demo.review-response.md`;
  fs.writeFileSync(response, "- 1 (AC-1 does not say where v2 is printed): AC-2 now says stdout.\n");
  r = sb.cf("init", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main", "--force");
  assert.ok(r.stdout.includes(`SPEC REVIEW: revised after review (${at}, 1 findings; responses in ${response})`), r.stdout);
  assert.doesNotMatch(r.stdout, /WARNING: no current spec review/);
  assert.equal(readState(sb, "demo").specReview.status, "revised");
  assert.match(sb.cf("status", "--slug", "demo").stdout, /round 1\/2/, "init is not blocked, and the lean defaults apply");
});

// ---- R2: lean code reviews ---------------------------------------------------------

test("AC-5/5b/6/7/7b: with a current spec review, Grok reviews the first code pass only, the breaker is off and 2 rounds; the report says so", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = specAndPlan(sb);
  specReview(sb, "demo", files);
  assert.equal(reviewCalls(sb, "grok").length, 1, "Grok reviewed the spec");
  let next = initLoop(sb, "demo", files, "--e2e", "grep -q v2 app.txt");
  const st = readState(sb, "demo");
  assert.equal(st.policy, 2);
  assert.equal(st.grok, "auto");
  assert.equal(st.breaker, false);
  assert.equal(st.maxRounds, 2);
  assert.deepEqual(st.decided, { lean: true, grokPasses: "first", breakerFrom: "lean default", maxRoundsFrom: "lean default" });

  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  assert.equal(next.next.action, "RUN_REVIEW", "no breaker leg");
  sb.queue("codex", needs(finding("medium", "v2 is not flushed")));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  assert.equal(reviewCalls(sb, "grok").length, 2, "Grok reviews code pass 1");
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED", note: "flushed" }] });
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  const r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /grok: not run on pass 2 \(auto: first code pass only\)/);
  assert.doesNotMatch(r.stdout, /WARNING: grok did not review/);
  assert.equal(reviewCalls(sb, "grok").length, 2, "Grok is not called on pass 2");
  assert.match(r.stdout, /NEXT ACTION: SHIP/);
  assert.match(r.stdout, /REVIEWERS: codex 2\/2 passes, grok 1\/2 passes \(not run: auto, first code pass only\)/);
  const report = fs.readFileSync(`${sb.repo}/.crossfire/runs/demo/report.md`, "utf8");
  assert.match(report, /- Spec review: SPEC REVIEW: current \(/);
  assert.match(report, /- Settings: grok auto \(spec review and first code pass only\), breaker off \(lean default\), max-rounds 2 \(lean default\)/);
  assert.doesNotMatch(report, /reviewer pass\(es\) did not complete/, "a pass Grok was not asked to review is not a failure");
});

test("AC-5/AC-7b: without a current spec review, a new loop keeps the 1.3 defaults and warns; explicit flags always win", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = specAndPlan(sb);
  const r = sb.cf("init", "--slug", "demo", "--spec", files.specFile, "--plan", files.planFile, "--base", "main");
  assert.match(r.stdout, /WARNING: no current spec review; using the full review defaults/);
  let st = readState(sb, "demo");
  assert.equal(st.policy, 2);
  assert.equal(st.breaker, true);
  assert.equal(st.maxRounds, 3);
  assert.deepEqual(st.decided, { lean: false, grokPasses: "every", breakerFrom: "no current spec review", maxRoundsFrom: "no current spec review" });

  specReview(sb, "demo", files);
  initLoop(sb, "demo", files, "--force", "--grok", "on", "--breaker", "on", "--max-rounds", "4");
  st = readState(sb, "demo");
  assert.equal(st.grok, "on");
  assert.equal(st.breaker, true);
  assert.equal(st.maxRounds, 4);
  assert.deepEqual(st.decided, { lean: true, grokPasses: "every", breakerFrom: "--breaker", maxRoundsFrom: "--max-rounds" });
});

test("AC-5b: --grok on runs Grok on every pass of a lean loop", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = specAndPlan(sb);
  specReview(sb, "demo", files);
  let next = initLoop(sb, "demo", files, "--grok", "on");
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("medium", "x")));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.match(sb.cf("review", "--slug", "demo").stdout, /NEXT ACTION: SHIP/);
  assert.equal(reviewCalls(sb, "grok").length, 3, "the spec review, then both code passes");
});

test("AC-6: a spec with **Risk:** high turns the breaker on in a lean loop", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = specAndPlan(sb, "demo", "\n**Risk:** high (touches git)\n");
  specReview(sb, "demo", files);
  let next = initLoop(sb, "demo", files);
  assert.equal(readState(sb, "demo").breaker, true);
  assert.equal(readState(sb, "demo").decided.breakerFrom, "the spec's Risk: high");
  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  assert.equal(next.next.action, "SEND_BREAKER");
});

function checkWithFinding(sb, name = "pr-1") {
  fs.writeFileSync(`${sb.repo}/app.txt`, "v2\n");
  gitc(sb.repo, "commit", "-qam", "change");
  sb.queue("codex", needs(finding("high", "nested rollback loses the write")));
  sb.queue("grok", approve);
  const r = sb.cf("check", "--base", "main", "--name", name);
  assert.equal(r.status, 0, r.stderr);
}

test("FM-5/AC-7: a lean --from-check loop with 2 rounds gets two builder legs: a red G0 on the first fix goes back to the builder", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  checkWithFinding(sb);
  const files = specAndPlan(sb, "fix-pr-1");
  specReview(sb, "fix-pr-1", files);
  let next = initLoop(sb, "fix-pr-1", files, "--from-check", "pr-1", "--e2e", "grep -q NEVER app.txt");
  assert.equal(readState(sb, "fix-pr-1").maxRounds, 2);
  assert.match(sb.cf("status", "--slug", "fix-pr-1").stdout, /round 1\/2/, "the pull request's own code is not a leg");
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  next = sb.cf("built", "--slug", "fix-pr-1", "--json").json();
  assert.equal(next.next.action, "SEND_BUILDER", "not ESCALATE");
  assert.equal(next.next.brief, "g0");
  assert.match(fs.readFileSync(next.brief, "utf8"), /round 2 of 2/);
  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "fix-pr-1", "--json").json();
  assert.equal(next.next.action, "ESCALATE");
  assert.equal(next.next.gate, "G2");
  assert.match(next.next.reason, /after 2 builder legs/);
});

test("FM-6/AC-5b: in a lean --from-check loop, Grok reviews the first pass crossfire runs (the fix), not later ones", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  checkWithFinding(sb);
  const files = specAndPlan(sb, "fix-pr-1");
  specReview(sb, "fix-pr-1", files);
  const grokBefore = reviewCalls(sb, "grok").length;
  let next = initLoop(sb, "fix-pr-1", files, "--from-check", "pr-1");
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  sb.cf("built", "--slug", "fix-pr-1");
  sb.queue("codex", needs(finding("medium", "a second problem", "other.txt", 50)));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "fix-pr-1", "--json").json();
  assert.equal(reviewCalls(sb, "grok").length, grokBefore + 1, "Grok reviews pass 2, the first pass crossfire runs");
  sb.build(next.resultFile, { fixes: [{ id: "F2", status: "FIXED" }] });
  sb.cf("built", "--slug", "fix-pr-1");
  sb.queue("codex", approve);
  const r = sb.cf("review", "--slug", "fix-pr-1");
  assert.match(r.stdout, /grok: not run on pass 3 \(auto: first code pass only\)/);
  assert.match(r.stdout, /NEXT ACTION: SHIP/);
  assert.equal(reviewCalls(sb, "grok").length, grokBefore + 1);
});

test("FM-6b/AC-7b: a loop started on 1.3 (no policy) keeps Grok on every pass under auto", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = specAndPlan(sb);
  specReview(sb, "demo", files);
  let next = initLoop(sb, "demo", files);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("medium", "x")));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  // What a 1.3 state looks like: no policy, none of 1.4's decided settings.
  const st = readState(sb, "demo");
  for (const k of ["policy", "decided", "roundOffset", "firstCodePass", "specReview"]) delete st[k];
  fs.writeFileSync(statePath(sb, "demo"), JSON.stringify(st));
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const r = sb.cf("review", "--slug", "demo");
  assert.match(r.stdout, /NEXT ACTION: SHIP/);
  assert.equal(reviewCalls(sb, "grok").length, 3, "the spec review, pass 1 and pass 2 too");
  assert.doesNotMatch(fs.readFileSync(`${sb.repo}/.crossfire/runs/demo/report.md`, "utf8"), /- Settings:/);
});

// ---- R3: Grok on a broken host ---------------------------------------------------

function brokenGrok(sb) {
  const now = Date.now();
  const fail = (h) => ({ ok: false, at: new Date(now - h * 3600_000).toISOString(), seconds: 2, error: "sandbox could not be applied" });
  fs.mkdirSync(`${sb.tmp}/state`, { recursive: true });
  fs.writeFileSync(`${sb.tmp}/state/reviewers.json`, JSON.stringify({ grok: [fail(30), fail(20), fail(10)] }));
}

test("AC-8: --grok auto skips Grok without calling it after 3 recent failures (check, loop review, spec review); --grok on still calls it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  brokenGrok(sb);
  const line = "grok: skipped (failed the last 3 times on this machine; crossfire doctor shows why; it is tried again after 7 days or with --grok on)";
  fs.writeFileSync(`${sb.repo}/app.txt`, "v2\n");
  gitc(sb.repo, "commit", "-qam", "change");
  sb.queue("codex", approve);
  let r = sb.cf("check", "--base", "main", "--name", "c1");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(line), r.stdout);
  assert.equal(reviewCalls(sb, "grok").length, 0);

  sb.queue("codex", approve);
  sb.queue("grok", approve);
  r = sb.cf("check", "--base", "main", "--name", "c2", "--since", "c1", "--grok", "on");
  assert.equal(reviewCalls(sb, "grok").length, 0, "c2 is refused: nothing new since c1");
  fs.writeFileSync(`${sb.repo}/app.txt`, "v3\n");
  gitc(sb.repo, "commit", "-qam", "change 2");
  r = sb.cf("check", "--base", "main", "--name", "c3", "--grok", "on");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(reviewCalls(sb, "grok").length, 1, "--grok on calls it");

  brokenGrok(sb);
  const files = specAndPlan(sb);
  sb.queue("codex", approve);
  r = sb.cf("spec-review", "--slug", "demo", "--spec", files.specFile, "--base", "main");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(line), r.stdout);
  assert.equal(reviewCalls(sb, "grok").length, 1);

  const next = sb.cf("init", "--slug", "loop", "--spec", files.specFile, "--base", "main", "--breaker", "off", "--json").json();
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "loop");
  sb.queue("codex", approve);
  r = sb.cf("review", "--slug", "loop");
  assert.ok(r.stdout.includes(line), r.stdout);
  assert.match(r.stdout, /NEXT ACTION: SHIP/);
  assert.equal(reviewCalls(sb, "grok").length, 1, "never called while skipped");
});

// ---- R4: tests are not weakened ------------------------------------------------------

test("AC-9: built refuses a branch that removes a test line, listing file and line, unless the spec allows that file", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  sh(sb.repo, "git", ["switch", "-q", "main"]);
  fs.mkdirSync(`${sb.repo}/tests`);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "a test");
  sh(sb.repo, "git", ["switch", "-q", "feature"]);
  sh(sb.repo, "git", ["reset", "-q", "--hard", "main"]);
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json").json();
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n});\n");
  sb.build(next.resultFile);
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /MALFORMED/);
  assert.match(r.stdout, /tests\/app\.test\.mjs:2: removes a line from an existing test file: "  assert\.equal\(1, 1\);"/);
  // A spec that allows the file when the loop starts lets it shrink.
  fs.appendFileSync(sb.spec, "\n## Allowed test changes\n\n- `tests/app.test.mjs`: the assertion moved to the new suite\n");
  // 1.5 (AC-3): --force does not restart a loop that has recorded steps since its init; it ends first.
  r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--force");
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /has recorded steps since its init/);
  const stateFile = `${sb.repo}/.crossfire/runs/demo/state.json`;
  const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const old = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  st.startedAt = old;
  for (const h of st.history) h.at = old;
  fs.writeFileSync(stateFile, JSON.stringify(st));
  assert.equal(sb.cf("abandon", "--slug", "demo").status, 0);
  const again = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json").json();
  sb.build(again.resultFile);
  r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json().next.action, "RUN_REVIEW");
});

// Rule: what the referee grants or judges by comes from the spec as approved at init (a snapshot
// with its sha256), never from the spec file as it is later: the builder can write that file.

function loopWithTest(sb, specExtra = "") {
  sh(sb.repo, "git", ["switch", "-q", "main"]);
  fs.mkdirSync(`${sb.repo}/tests`);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  fs.writeFileSync(`${sb.repo}/tests/other.test.mjs`, "test('o', () => {\n  assert.equal(2, 2);\n});\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "tests");
  sh(sb.repo, "git", ["switch", "-q", "feature"]);
  sh(sb.repo, "git", ["reset", "-q", "--hard", "main"]);
  if (specExtra) fs.appendFileSync(sb.spec, specExtra);
  return sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json").json();
}

test("breaker: the builder can exempt itself by adding an Allowed test changes section to the spec mid-loop", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb);
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n});\n");
  fs.appendFileSync(sb.spec, "\n## Allowed test changes\n\n- `tests/app.test.mjs`\n");
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, `the spec approved at init allowed no test changes, yet built accepted the removed assertion:\n${r.stdout}`);
  assert.match(r.stdout, /tests\/app\.test\.mjs:2: removes a line from an existing test file/);
});

test("spec bound at init: widening an Allowed test changes section mid-loop exempts nothing new; what init allowed stays allowed", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = loopWithTest(sb, "\n## Allowed test changes\n\n- `tests/other.test.mjs`: replaced\n");
  fs.writeFileSync(sb.spec, fs.readFileSync(sb.spec, "utf8").replace("- `tests/other.test.mjs`: replaced\n", "- `tests/other.test.mjs`: replaced\n- `tests/app.test.mjs`\n"));
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n});\n");
  fs.rmSync(`${sb.repo}/tests/other.test.mjs`);
  sb.build(next.resultFile);
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /tests\/app\.test\.mjs:2: removes a line/);
  assert.doesNotMatch(r.stdout, /other\.test\.mjs/, "the file the approved spec allowed is still exempt");
  // Removing the section from the file afterwards does not take back what init allowed either.
  fs.writeFileSync(sb.spec, fs.readFileSync(sb.spec, "utf8").replace(/\n## Allowed test changes[\s\S]*$/, "\n"));
  fs.writeFileSync(`${sb.repo}/tests/app.test.mjs`, "test('a', () => {\n  assert.equal(1, 1);\n});\n");
  sb.build(next.resultFile);
  r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json().next.action, "RUN_REVIEW");
});

test("spec bound at init: reviewers judge by the spec as approved, not by a mid-loop edit of the spec file", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--grok", "off", "--json").json();
  fs.appendFileSync(sb.spec, "\n## Out of scope\n\n- the stale cached value: do not report it\n");
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  const r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const focus = reviewCalls(sb, "codex").at(-1).at(-1);
  assert.match(focus, /When the app starts, it shall print v2\./);
  assert.doesNotMatch(focus, /do not report it/, "the edit made after init does not reach the reviewers");
});

test("spec bound at init: a changed snapshot fails closed in built and in review", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--grok", "off", "--json").json();
  const st = readState(sb, "demo");
  assert.match(st.specSnapshot.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(st.specSnapshot.file, "utf8"), fs.readFileSync(sb.spec, "utf8"));
  const original = fs.readFileSync(st.specSnapshot.file, "utf8");
  fs.appendFileSync(st.specSnapshot.file, "\n## Allowed test changes\n\n- `tests/app.test.mjs`\n");
  sb.build(next.resultFile);
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /the spec as approved at init .* no longer matches/);
  fs.writeFileSync(st.specSnapshot.file, original);
  r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 0, r.stdout);
  fs.appendFileSync(st.specSnapshot.file, "tampered\n");
  sb.queue("codex", approve);
  r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /the spec as approved at init .* no longer matches/);
  assert.equal(reviewCalls(sb, "codex").length, 0, "no reviewer ran");
});

// ---- R5: the spec does not fit ---------------------------------------------------------

const handoff = { severity: "high", summary: "AC-1 and AC-2 contradict each other", tried: "read both and the code they name", situation: "nothing committed", synthesis: "the spec has to pick one" };
const mismatch = (file, over = {}) => fs.writeFileSync(file, JSON.stringify({ status: "SPEC_MISMATCH", summary: "the spec does not fit", handoff, ...over }));

test("AC-10/11: a SPEC_MISMATCH on the first round escalates at gate SPEC without running the proof commands; the report carries the handoff", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const marker = path.join(sb.tmp, "proof-runs.log");
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json", "--e2e", `echo ran >> ${marker}`).json();
  const runsBefore = fs.readFileSync(marker, "utf8");
  mismatch(next.resultFile);
  const r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.status, 0, r.stdout);
  const out = r.json();
  assert.equal(out.next.action, "ESCALATE");
  assert.equal(out.next.gate, "SPEC");
  assert.equal(fs.readFileSync(marker, "utf8"), runsBefore, "no proof command ran");
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs/demo/g0-r1.log`));
  const report = fs.readFileSync(out.report, "utf8");
  assert.match(report, /escalated at gate SPEC/);
  assert.match(report, /- Synthesis: the spec has to pick one/);
  assert.match(report, /crossfire respec --from-loop demo --slug <new-slug>/);
});

test("AC-10/11/FM-7b: a SPEC_MISMATCH on a fix round with findings owed is not malformed and leaves the ledger as it was", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json").json();
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("high", "race")));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  assert.equal(next.next.brief, "fix");
  const ledger = JSON.stringify(readState(sb, "demo").ledger);
  mismatch(next.resultFile);
  const r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json().next.gate, "SPEC");
  assert.equal(JSON.stringify(readState(sb, "demo").ledger), ledger);
});

test("AC-11/FM-7b: a SPEC_MISMATCH escalates even when a proof command cannot run here; a missing handoff field is malformed", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--no-preflight", "--json", "--e2e", "missing-toolchain-xyz app.txt").json();
  const partial = { ...handoff };
  delete partial.tried;
  mismatch(next.resultFile, { handoff: partial });
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /handoff\.tried is required/);
  mismatch(next.resultFile);
  r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json().next.gate, "SPEC");
});

// ---- R6: precedents ------------------------------------------------------------------

test("AC-12/13: crossfire precedent add records a dated ruling; briefs and every reviewer focus carry it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let r = sb.cf("precedent", "add", "a cached value may be 5 s stale");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PRECEDENT: - \d{4}-\d{2}-\d{2} · a cached value may be 5 s stale/);
  assert.match(fs.readFileSync(`${sb.repo}/.git/crossfire/precedents.md`, "utf8"), /- \d{4}-\d{2}-\d{2} · a cached value may be 5 s stale/);
  assert.match(sb.cf("precedents").stdout, /a cached value may be 5 s stale/);
  assert.equal(sb.cf("precedent", "add", "  ").status, 2);
  assert.equal(sb.cf("precedent", "remove", "x").status, 2);

  let next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "on", "--json").json();
  const settled = /Settled by the owner; do not raise these again[\s\S]*a cached value may be 5 s stale/;
  assert.match(fs.readFileSync(next.brief, "utf8"), settled);
  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  assert.match(fs.readFileSync(next.brief, "utf8"), settled, "breaker brief");
  fs.writeFileSync(next.resultFile, JSON.stringify({ status: "DONE", summary: "", attacks: [] }));
  sb.cf("attacked", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  sb.cf("review", "--slug", "demo");
  assert.match(reviewCalls(sb, "codex").at(-1).at(-1), settled, "loop review focus");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("check", "--base", "main", "--name", "c1").status, 0);
  assert.match(reviewCalls(sb, "codex").at(-1).at(-1), settled, "check focus");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("spec-review", "--slug", "demo", "--spec", sb.spec, "--base", "main").status, 0);
  assert.match(reviewCalls(sb, "codex").at(-1).at(-1), settled, "spec review focus");
});

// ---- R7: size ---------------------------------------------------------------------------

test("AC-15: a review pass on a change over 400 lines or 10 files warns, and the report's Evidence notes it; it does not block", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json").json();
  fs.writeFileSync(`${sb.repo}/big.txt`, "line\n".repeat(450));
  fs.writeFileSync(`${sb.repo}/package-lock.json`, "{}\n".repeat(2000));
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const r = sb.cf("review", "--slug", "demo");
  assert.match(r.stdout, /WARNING: this change is 45[0-9] lines in 2 files; past about 400 lines or 10 files, split it/);
  assert.match(r.stdout, /NEXT ACTION: SHIP/);
  assert.match(fs.readFileSync(`${sb.repo}/.crossfire/runs/demo/report.md`, "utf8"), /- Size: 45[0-9] lines in 2 files at review pass 1 \(lockfiles excluded\)/);

  for (let i = 0; i < 11; i += 1) fs.writeFileSync(`${sb.repo}/f${i}.txt`, "x\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "many files");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const c = sb.cf("check", "--base", "main", "--name", "many");
  assert.match(c.stdout, /WARNING: this change is \d+ lines in 13 files; past about 400 lines or 10 files, split it/);
  assert.match(fs.readFileSync(`${sb.repo}/.crossfire/checks/many/report.md`, "utf8"), /- Size: \d+ lines in 13 files/);
});
