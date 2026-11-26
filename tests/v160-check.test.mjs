// 1.6.0 end to end, checks and reviewers: the merge-base (E2E-4), Grok sign-in and timeouts (E2E-5),
// and no size warning in check (E2E-7). The real CLI in a throwaway repository with fake reviewers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, approve, needs, finding, gitc, sh } from "./helpers.mjs";

const reviewCalls = (sb, name) => sb.calls(name).filter((a) => a[0] === (name === "codex" ? "adversarial-review" : "critique"));
const baseArg = (argv) => argv[argv.indexOf("--base") + 1];
const rev = (sb, ref) => sh(sb.repo, "git", ["rev-parse", ref]);
const readCheck = (sb, id) => JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/checks/${id}/check.json`, "utf8"));

/** Commit `file` on `branch` and come back to `back`. */
function commitOn(sb, branch, file, back = "feature") {
  sh(sb.repo, "git", ["switch", "-q", branch]);
  fs.writeFileSync(path.join(sb.repo, file), `${file} ${Math.random()}\n`);
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", `${file} on ${branch}`);
  sh(sb.repo, "git", ["switch", "-q", back]);
}

// ---- E2E-4 -----------------------------------------------------------------------------

test("E2E-4: check reviews against the merge-base, records it, names it; --since recomputes it; init --from-check still starts", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitOn(sb, "feature", "feature.txt");
  const branchPoint = rev(sb, "main");
  commitOn(sb, "main", "later-on-main.txt");
  const mainTip = rev(sb, "main");
  assert.notEqual(mainTip, branchPoint);

  sb.queue("codex", needs(finding("medium", "first finding", "feature.txt", 1)));
  sb.queue("grok", approve);
  let r = sb.cf("check", "--base", "main", "--name", "c1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(baseArg(reviewCalls(sb, "codex").at(-1)), branchPoint, "codex gets the merge-base, not main's tip");
  assert.equal(baseArg(reviewCalls(sb, "grok").at(-1)), branchPoint, "grok too");
  let rec = readCheck(sb, "c1");
  assert.equal(rec.base, "main");
  assert.equal(rec.baseSha, mainTip, "baseSha keeps its meaning: the base ref's commit");
  assert.equal(rec.mergeBase, branchPoint);
  const focus = reviewCalls(sb, "codex").at(-1).at(-1);
  assert.match(focus, new RegExp(`merge-base ${branchPoint.slice(0, 12)} of main`));
  assert.match(focus, /commits on main after it are not part of this change/);

  // The base moves on, the branch merges it, and the base moves again: the re-check uses the current merge-base.
  sh(sb.repo, "git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "merge", "-q", "--no-edit", "main"]);
  const merged = rev(sb, "main");
  commitOn(sb, "main", "even-later.txt");
  const newTip = rev(sb, "main");
  sb.queue("codex", needs(finding("medium", "second finding", "feature.txt", 1)));
  sb.queue("grok", approve);
  r = sb.cf("check", "--base", "main", "--since", "c1", "--name", "c2");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(baseArg(reviewCalls(sb, "codex").at(-1)), merged, "the merge-base of the current HEAD, not c1's");
  rec = readCheck(sb, "c2");
  assert.equal(rec.mergeBase, merged);
  assert.equal(rec.baseSha, newTip);
  assert.match(reviewCalls(sb, "codex").at(-1).at(-1), new RegExp(`merge-base ${merged.slice(0, 12)} of main`));

  // AC-7: init --from-check on a base that advanced after the branch point still starts the loop.
  r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--from-check", "c2", "--breaker", "off");
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /NEXT ACTION: SEND_BUILDER \(fix\)/);
});

test("FM-3: a branch rebased on the base tip has merge-base == base tip, same as before", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitOn(sb, "feature", "feature.txt");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("check", "--base", "main", "--name", "c1").status, 0);
  const rec = readCheck(sb, "c1");
  assert.equal(rec.mergeBase, rev(sb, "main"));
  assert.equal(rec.baseSha, rev(sb, "main"));
  assert.equal(baseArg(reviewCalls(sb, "codex").at(-1)), rev(sb, "main"));
});

test("E2E-4/AC-9: an orphan branch with no merge-base is refused with exit 2, naming the base, changing nothing", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  sh(sb.repo, "git", ["switch", "-q", "--orphan", "lonely"]);
  fs.writeFileSync(path.join(sb.repo, "app.txt"), "alone\n");
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "unrelated");
  const exclude = path.join(sb.repo, ".git", "info", "exclude");
  const before = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : null;
  const r = sb.cf("check", "--base", "main", "--name", "c1");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /merge-base/);
  assert.match(r.stderr, /\bmain\b/);
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire`), "nothing written");
  assert.equal(fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : null, before);
  assert.equal(reviewCalls(sb, "codex").length, 0);
});

// ---- E2E-5 -----------------------------------------------------------------------------

const SIGNED_OUT = "exit 1: Error: Not signed in. To authenticate without a browser, run:";

function health(sb, data) {
  fs.mkdirSync(`${sb.tmp}/state`, { recursive: true });
  fs.writeFileSync(`${sb.tmp}/state/reviewers.json`, JSON.stringify(data));
}
const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const failed = (h, error) => ({ ok: false, at: ago(h), seconds: 2, error });

test("E2E-5/AC-11: doctor names a Grok sign-in failure and says grok login, then one review with --grok on", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  health(sb, { grok: [failed(1, SIGNED_OUT)] });
  const d = sb.cf("doctor");
  assert.equal(d.status, 0, d.stdout);
  assert.match(d.stdout, /warn grok +.*not signed in/);
  const lines = d.stdout.split("\n");
  const at = lines.findIndex((l) => l.startsWith("warn grok"));
  assert.equal(lines[at + 1].trim(), "grok login");
  assert.equal(lines[at + 2].trim(), "then run one review with --grok on (auto skips it for up to 7 days after repeated failures)");
});

test("AC-11/FM-4: a success after the sign-in failure clears it; timeouts keep today's wording; Codex's login errors are Codex's", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  health(sb, { grok: [failed(2, SIGNED_OUT), { ok: true, at: ago(1), seconds: 300 }] });
  let d = sb.cf("doctor");
  assert.match(d.stdout, /^ok {3}grok/m);
  assert.doesNotMatch(d.stdout, /grok login/);

  health(sb, { grok: [failed(3, "timed out after 1200s"), failed(2, "timed out after 1200s")] });
  d = sb.cf("doctor");
  assert.match(d.stdout, /warn grok .*last 2 reviews on this machine failed .*timed out after 1200s/);
  assert.doesNotMatch(d.stdout, /not signed in|grok login/);

  health(sb, { codex: [failed(3, "Please log in: run codex login"), failed(2, "Please log in: run codex login")] });
  d = sb.cf("doctor");
  assert.match(d.stdout, /FAIL codex .*last 2 reviews on this machine failed/);
  assert.doesNotMatch(d.stdout, /grok login/);
});

test("E2E-5/AC-12: --grok auto skips a signed-out Grok and the skip line and REVIEWERS line say not signed in; run grok login", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  health(sb, { grok: [failed(3, SIGNED_OUT), failed(2, SIGNED_OUT), failed(1, SIGNED_OUT)] });
  commitOn(sb, "feature", "feature.txt");
  sb.queue("codex", approve);
  const r = sb.cf("check", "--base", "main", "--name", "c1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(reviewCalls(sb, "grok").length, 0);
  assert.match(r.stdout, /^grok: skipped \(not signed in; run grok login/m);
  assert.match(r.stdout, /^REVIEWERS: .*grok 0\/1 passes \(skipped: not signed in; run grok login/m);
});

test("E2E-5: a health file with timeouts only keeps today's skip wording", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  health(sb, { grok: [3, 2, 1].map((h) => failed(h, "timed out after 1200s")) });
  commitOn(sb, "feature", "feature.txt");
  sb.queue("codex", approve);
  const r = sb.cf("check", "--base", "main", "--name", "c1");
  assert.ok(r.stdout.includes("grok: skipped (failed the last 3 times on this machine; crossfire doctor shows why; it is tried again after 7 days or with --grok on)"), r.stdout);
  assert.match(r.stdout, /grok 0\/1 passes \(skipped: failed the last 3 times on this machine\)/);
  assert.doesNotMatch(r.stdout, /not signed in/);
});

// ---- E2E-5: timeouts (AC-13, FM-6) -------------------------------------------------------

const reviewJson = (sb, id, who) => JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/checks/${id}/review-${who}.json`, "utf8"));

test("E2E-5/AC-13: check gives Grok 15 minutes and Codex 20 by default; an explicit --timeout-min applies to both", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitOn(sb, "feature", "feature.txt");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("check", "--base", "main", "--name", "c1", "--grok", "on").status, 0);
  assert.equal(reviewJson(sb, "c1", "codex").timeoutMs, 20 * 60_000);
  assert.equal(reviewJson(sb, "c1", "grok").timeoutMs, 15 * 60_000);
  commitOn(sb, "feature", "feature2.txt");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("check", "--base", "main", "--name", "c2", "--grok", "on", "--timeout-min", "5").status, 0);
  assert.equal(reviewJson(sb, "c2", "codex").timeoutMs, 5 * 60_000);
  assert.equal(reviewJson(sb, "c2", "grok").timeoutMs, 5 * 60_000, "FM-6: not overridden by the 15-minute default");
});

test("AC-13: a loop review pass gives Grok 15 minutes by default and the explicit value when given", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json").json();
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("medium", "x")));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  const dir = `${sb.repo}/.crossfire/runs/demo`;
  assert.equal(JSON.parse(fs.readFileSync(`${dir}/review-p1-grok.json`, "utf8")).timeoutMs, 15 * 60_000);
  assert.equal(JSON.parse(fs.readFileSync(`${dir}/review-p1-codex.json`, "utf8")).timeoutMs, 20 * 60_000);
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("review", "--slug", "demo", "--timeout-min", "7").status, 0);
  assert.equal(JSON.parse(fs.readFileSync(`${dir}/review-p2-grok.json`, "utf8")).timeoutMs, 7 * 60_000);
  assert.equal(JSON.parse(fs.readFileSync(`${dir}/review-p2-codex.json`, "utf8")).timeoutMs, 7 * 60_000);
});

test("AC-13: spec-review gives Grok 15 minutes by default; --timeout-sec and --timeout-min apply to both", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = sb.cf("spec", "--slug", "demo", "--json").json();
  fs.writeFileSync(files.specFile, fs.readFileSync(sb.spec, "utf8"));
  const runOnce = (...extra) => {
    sb.queue("codex", approve);
    sb.queue("grok", approve);
    const r = sb.cf("spec-review", "--slug", "demo", "--spec", files.specFile, "--base", "main", "--grok", "on", ...extra);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const rec = JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/specs/demo.review.json`, "utf8"));
    return Object.fromEntries(rec.reviewers.map((x) => [x.reviewer, x.timeoutMs]));
  };
  assert.deepEqual(runOnce(), { codex: 20 * 60_000, grok: 15 * 60_000 });
  assert.deepEqual(runOnce("--timeout-sec", "90"), { codex: 90_000, grok: 90_000 });
  assert.deepEqual(runOnce("--timeout-min", "3"), { codex: 3 * 60_000, grok: 3 * 60_000 });
});

// ---- E2E-7 -----------------------------------------------------------------------------

test("E2E-7/AC-17: check on a diff over 400 lines prints no size warning and records none; a loop review pass still warns", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--json").json();
  fs.writeFileSync(`${sb.repo}/big.txt`, "line\n".repeat(450));
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const loop = sb.cf("review", "--slug", "demo");
  assert.match(loop.stdout, /WARNING: this change is 45[0-9] lines in 2 files; past about 400 lines or 10 files, split it/);

  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const c = sb.cf("check", "--base", "main", "--name", "big");
  assert.equal(c.status, 0, c.stderr);
  assert.doesNotMatch(c.stdout, /WARNING: this change is/);
  const rec = readCheck(sb, "big");
  assert.ok(rec.size && rec.size.lines >= 450, JSON.stringify(rec.size));
  assert.ok(!("warning" in rec.size), "new check records do not set size.warning");
  assert.doesNotMatch(fs.readFileSync(`${sb.repo}/.crossfire/checks/big/report.md`, "utf8"), /- Size:/);
});

test("AC-17: an old check record with size.warning still renders its Size line", async () => {
  const { renderCheckReport } = await import("../plugins/crossfire/scripts/lib/report.mjs");
  const text = renderCheckReport({ id: "old", head: "a".repeat(40), base: "main", baseSha: "b".repeat(40), branch: "f", reviewersText: "codex 1/1 passes", at: "2026-11-01T00:00:00Z", approved: true, findings: [], since: null, size: { lines: 500, files: 3, warning: true } });
  assert.match(text, /- Size: 500 lines in 3 files/);
});

test("check's diff size uses the merge-base: commits on the base after the branch point are not counted", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitOn(sb, "feature", "feature.txt");
  sh(sb.repo, "git", ["switch", "-q", "main"]);
  fs.writeFileSync(path.join(sb.repo, "main-big.txt"), "x\n".repeat(900));
  gitc(sb.repo, "add", "-A");
  gitc(sb.repo, "commit", "-qm", "big on main");
  sh(sb.repo, "git", ["switch", "-q", "feature"]);
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("check", "--base", "main", "--name", "c1").status, 0);
  assert.deepEqual(readCheck(sb, "c1").size, { lines: 1, files: 1 });
});
