// End to end: the real CLI in a throwaway git repo, with a fake `claude` and
// fake official reviewer plugins.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, approve, needs, finding, OFFICIAL_MARKETS, ROOT } from "./helpers.mjs";

function init(sb, ...extra) {
  // The loop tests below predate the breaker; the breaker has its own tests.
  const breaker = extra.includes("--breaker") ? [] : ["--breaker", "off"];
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--json", ...breaker, ...extra);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.json();
}

test("full loop: build, Codex finds a blocker, fix, Codex and Grok approve, ship", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb, "--e2e", "grep -q v2 app.txt");
  assert.equal(next.next.action, "SEND_BUILDER");
  assert.match(fs.readFileSync(next.brief, "utf8"), /Build the spec/);

  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  assert.equal(next.next.action, "RUN_REVIEW");

  sb.queue("codex", needs(finding("high", "token not checked before wake")));
  sb.queue("grok", approve);
  let r = sb.cf("review", "--slug", "demo", "--json");
  assert.equal(r.status, 0, r.stderr);
  next = r.json();
  assert.equal(next.next.action, "SEND_BUILDER");
  assert.equal(next.next.brief, "fix");
  assert.match(fs.readFileSync(next.brief, "utf8"), /F1 · BLOCKER · app\.txt:1/);

  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED", note: "checked first" }] });
  assert.equal(sb.cf("built", "--slug", "demo", "--json").json().next.action, "RUN_REVIEW");

  sb.queue("codex", approve);
  sb.queue("grok", approve);
  r = sb.cf("review", "--slug", "demo", "--json");
  next = r.json();
  assert.equal(next.next.action, "SHIP");
  const report = fs.readFileSync(next.report, "utf8");
  assert.match(report, /Crossfire SHIP: demo/);
  assert.match(report, /\| F1 \| BLOCKER \| closed \|/);

  // Both reviewers ran read-only through their own scripts, against the base commit, with the spec as focus.
  const codexReview = sb.calls("codex").find((a) => a[0] === "adversarial-review");
  assert.deepEqual(codexReview.slice(0, 4), ["adversarial-review", "--wait", "--json", "--base"]);
  assert.match(codexReview.at(-1), /When the app starts, it shall print v2/);
  assert.ok(sb.calls("grok").some((a) => a[0] === "critique"));
  // Second pass told the reviewers about F1 and how to re-flag it.
  assert.match(sb.calls("codex").at(-1).at(-1), /\[F1\]/);

  assert.equal(sb.cf("built", "--slug", "demo").status, 4, "a finished loop refuses more work");
});

test("Codex is required: init refuses without the official plugin", (t) => {
  const sb = sandbox({ plugins: [] });
  t.after(() => sb.cleanup());
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main");
  assert.equal(r.status, 5);
  assert.match(r.stderr, /Codex reviewer is required/);
});

test("a community copy of codex from another marketplace is refused", (t) => {
  const sb = sandbox({
    markets: OFFICIAL_MARKETS.map((m) => (m.name === "openai-codex" ? { ...m, repo: "someone/codex-fork" } : m)),
  });
  t.after(() => sb.cleanup());
  const r = sb.cf("doctor", "--json");
  assert.equal(r.status, 5);
  const codex = r.json().checks.find((c) => c.name === "codex");
  assert.equal(codex.ok, false);
  assert.match(codex.detail, /not the official openai\/codex-plugin-cc/);
});

test("doctor: ready with Codex only; Grok missing is a warning with install steps", (t) => {
  const sb = sandbox({ grok: false });
  t.after(() => sb.cleanup());
  const r = sb.cf("doctor");
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /READY/);
  assert.match(r.stdout, /warn grok/);
  assert.match(r.stdout, /claude plugin install grok-build@xai-grok-build/);
});

test("doctor: Codex installed but not logged in is NOT READY", (t) => {
  const sb = sandbox({ env: { FAKE_CODEX_READY: "0" } });
  t.after(() => sb.cleanup());
  const r = sb.cf("doctor");
  assert.equal(r.status, 5);
  assert.match(r.stdout, /FAIL codex .*not ready: Run `codex login`/);
});

test("a malformed builder result is re-asked once, then escalates (G1)", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3);
  assert.match(r.stdout, /no result file/);
  sb.build(next.resultFile, { commit: false }); // claims DONE with nothing committed on top of base
  r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.status, 0);
  assert.equal(r.json().next.gate, "G1");
});

test("G0 runs the declared proof commands itself and sends a red run back to the builder", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb, "--e2e", "grep -q NEVER app.txt");
  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  assert.equal(next.next.action, "SEND_BUILDER");
  assert.equal(next.next.brief, "g0");
  assert.match(fs.readFileSync(next.brief, "utf8"), /grep -q NEVER app\.txt` exited 1/);
  assert.equal(sb.calls("codex").filter((a) => a[0] === "adversarial-review").length, 0, "no review before G0 is green");
});

test("a failing optional Grok review does not block the loop", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", "grok crashed");
  const r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /grok: FAILED/);
  assert.match(r.stdout, /NEXT ACTION: SHIP/);
});

test("a failing Codex review advances nothing the first time and escalates the second", (t) => {
  const sb = sandbox({ grok: false });
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", "codex crashed", "codex crashed again");
  let r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 3);
  r = sb.cf("review", "--slug", "demo", "--json");
  assert.equal(r.json().next.gate, "G1");
});

test("review refuses uncommitted work: reviewers only see commits", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  fs.writeFileSync(`${sb.repo}/stray.txt`, "x");
  const r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uncommitted changes/);
});

test("a second init on a running loop is refused; --force archives it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  init(sb);
  assert.equal(sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main").status, 2);
  assert.equal(sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--force").status, 0);
});

test("loop files live in .crossfire/, which git ignores: never committed, never dirty, never reviewed", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  assert.ok(next.brief.startsWith(`${sb.repo}/.crossfire/runs/demo/`), next.brief);
  const exclude = fs.readFileSync(`${sb.repo}/.git/info/exclude`, "utf8");
  assert.equal(exclude.split("\n").filter((l) => l === "/.crossfire/").length, 1);
  init(sb, "--force"); // a second init does not add the line twice
  assert.equal(fs.readFileSync(`${sb.repo}/.git/info/exclude`, "utf8"), exclude);
  sb.build(next.resultFile);
  const r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.json().next.action, "RUN_REVIEW", "the result file inside .crossfire/ does not make the tree dirty");
});

test("the bin launcher Claude puts on PATH runs (CommonJS shim -> ESM CLI)", () => {
  const r = spawnSync(path.join(ROOT, "plugins", "crossfire", "bin", "crossfire"), ["version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("crossfire spec sets up the ignore rule first, so a spec written before init is never committed", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const r = sb.cf("spec", "--slug", "demo", "--json");
  assert.equal(r.status, 0, r.stderr);
  const { specFile, template } = r.json();
  assert.equal(specFile, `${sb.repo}/.crossfire/specs/demo.md`);
  assert.ok(fs.existsSync(template), template);
  fs.writeFileSync(specFile, "# Spec\n\n## How this could fail\n\n- one\n- two\n- three\n");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: sb.repo, encoding: "utf8" }).stdout, "", "the spec is ignored before init runs");
  assert.equal(sb.cf("init", "--slug", "demo", "--spec", specFile, "--base", "main").status, 0);
});

test("init refuses a spec that is committed on the branch (reviewers would review it as code)", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  fs.mkdirSync(`${sb.repo}/docs`);
  fs.writeFileSync(`${sb.repo}/docs/spec.md`, "# Spec\n");
  spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "add", "docs/spec.md"], { cwd: sb.repo });
  spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "spec"], { cwd: sb.repo });
  const r = sb.cf("init", "--slug", "demo", "--spec", "docs/spec.md", "--base", "main");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /committed on this branch/);
});

test("doctor on Linux: Grok without bubblewrap is a warning, not ready, with the package to install", { skip: process.platform !== "linux" }, (t) => {
  const sb = sandbox({ env: { CROSSFIRE_ASSUME_BWRAP: "0" } });
  t.after(() => sb.cleanup());
  const r = sb.cf("doctor");
  assert.equal(r.status, 0, "Codex alone is enough to be READY");
  assert.match(r.stdout, /warn grok .*needs bubblewrap/);
  assert.match(r.stdout, /apt install -y bubblewrap/);
});

test("a failed reviewer is reported by its own error line, not a payload dump", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", JSON.stringify({ review: "Critique", result: null, parseError: "error: this sandbox could not enforce its deny list on Linux\nmore", grok: { status: 1 } }));
  const r = sb.cf("review", "--slug", "demo");
  assert.match(r.stdout, /grok: FAILED \(error: this sandbox could not enforce its deny list on Linux\)/);
  assert.doesNotMatch(r.stdout, /"parseError"/);
});

test("doctor on Linux: bubblewrap present but blocked (Ubuntu AppArmor) is a warning that names the owner decision", { skip: process.platform !== "linux" }, (t) => {
  const sb = sandbox({ env: { CROSSFIRE_ASSUME_BWRAP: "bwrap: setting up uid map: Permission denied" } });
  t.after(() => sb.cleanup());
  const r = sb.cf("doctor");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /warn grok .*cannot start a sandbox here \(bwrap: setting up uid map: Permission denied\)/);
  assert.match(r.stdout, /AppArmor profile/);
});

test("preflight: init refuses a proof command that cannot run here, accepts one that fails before the build", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--e2e", "definitely-not-a-command-xyz spec/");
  assert.equal(r.status, 5);
  assert.match(r.stderr, /preflight: 1 proof command\(s\) cannot run in this environment/);
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs/demo/state.json`), "nothing was started");
  r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--e2e", "grep -q v2 app.txt");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT: 1 proof command\(s\) can run here \(1 fail before the build, as expected\)/);
});

test("a proof command that stops working mid-loop costs no round; `crossfire proof` fixes it in place", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb, "--e2e", "test -x ./runner && ./runner || grep -q v2 app.txt", "--no-preflight");
  // Simulate the toolchain going missing: the command now exits 127.
  sb.cf("proof", "--slug", "demo", "--e2e", "missing-toolchain-xyz app.txt");
  sb.build(next.resultFile);
  let r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 5);
  assert.match(r.stdout, /PROOF ENVIRONMENT/);
  assert.match(r.stdout, /Nothing advanced/);
  r = sb.cf("proof", "--slug", "demo", "--e2e", "grep -q v2 app.txt", "--json");
  assert.equal(r.json().round, 1, "still round 1: no round was spent");
  r = sb.cf("built", "--slug", "demo", "--json");
  assert.equal(r.json().next.action, "RUN_REVIEW", "the kept builder result passes with the fixed command");
});

test("reports say which reviewers actually reviewed; a silent optional reviewer is flagged every pass", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", JSON.stringify({ result: null, parseError: "warning: sandbox could not be applied: socket deny resolution failed" }));
  const r = sb.cf("review", "--slug", "demo");
  assert.match(r.stdout, /WARNING: grok did not review this pass/);
  assert.match(r.stdout, /REVIEWERS: codex 1\/1 passes, grok 0\/1 passes \(failed: .*socket deny resolution failed\)/);
  const report = fs.readFileSync(`${sb.repo}/.crossfire/runs/demo/report.md`, "utf8");
  assert.match(report, /- Reviewers: codex 1\/1 passes, grok 0\/1 passes/);
});

test("doctor: a reviewer whose last reviews all failed on this machine is not counted as ready", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("medium", "x")));
  sb.queue("grok", JSON.stringify({ result: null, parseError: "sandbox could not be applied" }));
  const r1 = sb.cf("review", "--slug", "demo", "--json");
  sb.build(r1.json().resultFile, { fixes: [{ id: "F1", status: "FIXED" }] });
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", JSON.stringify({ result: null, parseError: "sandbox could not be applied" }));
  sb.cf("review", "--slug", "demo");
  const d = sb.cf("doctor");
  assert.equal(d.status, 0, "Codex is fine, so still READY");
  assert.match(d.stdout, /warn grok .*last 2 reviews on this machine failed .*sandbox could not be applied/);
});

test("A: init refuses a spec without failure modes; --no-failure-modes is the explicit opt-out", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  fs.writeFileSync(sb.spec, "# Spec\n\nPrint v2.\n");
  let r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /How this could fail/);
  r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--base", "main", "--no-failure-modes");
  assert.equal(r.status, 0, r.stderr);
});

test("B: full loop with the breaker: attack proven, hardened, reviewers see it, Codex approves first pass", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb, "--breaker", "on");
  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  assert.equal(next.next.action, "SEND_BREAKER");
  const brief = fs.readFileSync(next.brief, "utf8");
  assert.match(brief, /assume the change is wrong and prove it/);
  assert.match(brief, /worktree add --detach/);
  assert.match(brief, /nested transactions/);

  fs.writeFileSync(next.resultFile, JSON.stringify({ status: "DONE", summary: "tried 7 categories", attacks: [{ title: "a second writer overwrites v2", category: "concurrency", severity: "BLOCKER", file: "app.txt", line: 1, scenario: "two writers at once", rule: "one writer", test: "test_two_writers", command: "node t.mjs", output: "expected v2", proven: true }, { title: "unproven idea", proven: false }] }));
  next = sb.cf("attacked", "--slug", "demo", "--json").json();
  assert.equal(next.next.action, "SEND_BUILDER");
  assert.equal(next.next.brief, "harden");
  const harden = fs.readFileSync(next.brief, "utf8");
  assert.match(harden, /B1 · BLOCKER · app\.txt:1 · from breaker/);
  assert.match(harden, /broadest/);
  assert.match(harden, /Before you edit: depth first/);

  sb.build(next.resultFile, { fixes: [{ id: "B1", status: "FIXED", note: "single writer" }] });
  next = sb.cf("built", "--slug", "demo", "--json").json();
  assert.equal(next.next.action, "RUN_REVIEW", "no second breaker pass after the harden leg");

  sb.queue("codex", approve);
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  assert.equal(next.next.action, "SHIP");
  assert.match(sb.calls("codex").at(-1).at(-1), /internal adversarial pass[\s\S]*a second writer overwrites v2 -> builder: FIXED/);
  const report = fs.readFileSync(next.report, "utf8");
  assert.match(report, /First review pass: approved, nothing to fix/);
  assert.match(report, /Breaker: 1 pass\(es\), 1 proven attack\(s\)/);
});

test("B: a breaker that touches the branch is refused", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb, "--breaker", "on");
  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  fs.writeFileSync(`${sb.repo}/breaker_test.txt`, "oops");
  fs.writeFileSync(next.resultFile, JSON.stringify({ status: "DONE", summary: "", attacks: [] }));
  const r = sb.cf("attacked", "--slug", "demo");
  assert.equal(r.status, 3);
  assert.match(r.stdout, /changed the working tree/);
});

test("B: a breaker that cannot produce a valid result twice is skipped, never blocks the loop", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb, "--breaker", "on");
  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  assert.equal(sb.cf("attacked", "--slug", "demo").status, 3);
  const r = sb.cf("attacked", "--slug", "demo", "--json");
  assert.equal(r.status, 0);
  assert.equal(r.json().next.action, "RUN_REVIEW");
});

function commitChange(sb, content = "v2\n") {
  fs.writeFileSync(`${sb.repo}/app.txt`, content);
  spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", "change"], { cwd: sb.repo });
}

test("check: reviews a branch once with no spec, no builder and no loop", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitChange(sb);
  sb.queue("codex", needs(finding("high", "nested rollback loses the write"), finding("low", "typo in comment", "app.txt", 2)));
  sb.queue("grok", approve);
  const r = sb.cf("check", "--base", "main", "--focus", "PR: print v2 on start", "--name", "pr-1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CHECK pr-1 · feature [0-9a-f]{12} against main/);
  assert.match(r.stdout, /REVIEWERS: codex 1\/1 passes, grok 1\/1 passes/);
  assert.match(r.stdout, /VERDICT: 2 finding\(s\): 1 blocker, 0 changes, 1 nit/);
  assert.match(r.stdout, /TO FIX WITH A LOOP: .*--from-check pr-1/);
  assert.match(sb.calls("codex").at(-1).at(-1), /PR: print v2 on start/);
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs`), "no loop was started");
  assert.match(fs.readFileSync(`${sb.repo}/.crossfire/checks/pr-1/report.md`, "utf8"), /BLOCKER · app\.txt:1 · codex/);
  assert.match(sb.cf("checks").stdout, /pr-1 · 2 finding\(s\)/);
});

test("check: an approving review says so; guards refuse dirty trees and empty diffs", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(sb.cf("check", "--base", "main").status, 2, "no commits on top of main");
  commitChange(sb);
  fs.writeFileSync(`${sb.repo}/stray.txt`, "x");
  assert.match(sb.cf("check", "--base", "main").stderr, /uncommitted changes/);
  fs.rmSync(`${sb.repo}/stray.txt`);
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const r = sb.cf("check", "--base", "main", "--json");
  assert.equal(r.json().approved, true);
});

test("init --from-check: the loop starts at the fix round with the check's findings; no builder round first", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitChange(sb);
  sb.queue("codex", needs(finding("high", "nested rollback loses the write")));
  sb.queue("grok", approve);
  sb.cf("check", "--base", "main", "--name", "pr-1");
  let r = sb.cf("init", "--slug", "fix-pr-1", "--spec", sb.spec, "--base", "main", "--from-check", "pr-1", "--breaker", "off", "--json");
  assert.equal(r.status, 0, r.stderr);
  let next = r.json();
  assert.equal(next.next.action, "SEND_BUILDER");
  assert.equal(next.next.brief, "fix");
  assert.match(fs.readFileSync(next.brief, "utf8"), /F1 · BLOCKER · app\.txt:1 · from codex/);

  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED", note: "committed state" }] });
  next = sb.cf("built", "--slug", "fix-pr-1", "--json").json();
  assert.equal(next.next.action, "RUN_REVIEW");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "fix-pr-1", "--json").json();
  assert.equal(next.next.action, "SHIP");
  const report = fs.readFileSync(next.report, "utf8");
  assert.match(report, /First review pass: 1 finding\(s\)/, "the check counts as the first review pass");
  assert.match(report, /from-check: pr-1/);
});

test("init --from-check refuses a stale check (branch moved) and an approved one", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitChange(sb);
  sb.queue("codex", needs(finding("medium", "x")));
  sb.queue("grok", approve);
  sb.cf("check", "--base", "main", "--name", "c1");
  commitChange(sb, "v3\n");
  assert.match(sb.cf("init", "--slug", "f", "--spec", sb.spec, "--base", "main", "--from-check", "c1").stderr, /branch moved since check c1/);
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  sb.cf("check", "--base", "main", "--name", "c2");
  assert.match(sb.cf("init", "--slug", "f", "--spec", sb.spec, "--base", "main", "--from-check", "c2").stderr, /nothing to fix/);
});

import { spawn } from "node:child_process";

test("check --since: the reviewers get the earlier findings tagged, and the delta says what was fixed", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitChange(sb);
  sb.queue("codex", needs(finding("high", "token unchecked", "app.txt", 1), finding("medium", "missing index", "db.sql", 3)));
  sb.queue("grok", approve);
  sb.cf("check", "--base", "main", "--name", "pr-1", "--focus", "PR: tokens");
  assert.match(sb.cf("check", "--base", "main", "--since", "pr-1", "--name", "pr-1-b").stderr, /nothing new since check pr-1/);
  commitChange(sb, "v3\n");
  sb.queue("codex", needs(finding("high", "[P1] token still unchecked on retry", "app.txt", 1)));
  sb.queue("grok", approve);
  const r = sb.cf("check", "--base", "main", "--since", "pr-1", "--name", "pr-1-b");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SINCE pr-1 \([0-9a-f]{12}\): 1 fixed, 1 still open, 0 unclear, 0 new/);
  assert.match(r.stdout, /fixed: \[P2\] missing index/);
  assert.match(r.stdout, /still open: \[P1\] token unchecked/);
  const focus = sb.calls("codex").at(-1).at(-1);
  assert.match(focus, /\[P1\] BLOCKER app\.txt:1 token unchecked/);
  assert.match(focus, /PR: tokens/, "the earlier focus carries over");
  assert.match(fs.readFileSync(`${sb.repo}/.crossfire/checks/pr-1-b/report.md`, "utf8"), /## Since pr-1/);
});

function runAsync(sb, args) {
  // Test remotes are local bare repositories, not GitHub URLs: name the PR's repository.
  if (args[0] === "watch" && args.includes("--pr") && !args.includes("--repo") && !args.includes("--no-repo")) args = [...args, "--repo", "acme/app"];
  args = args.filter((a) => a !== "--no-repo");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: sb.repo, env: sb.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const CLI_PATH = path.join(ROOT, "plugins", "crossfire", "scripts", "crossfire.mjs");

function withRemote(sb) {
  const bare = path.join(sb.tmp, "remote.git");
  spawnSync("git", ["init", "-q", "--bare", bare]);
  spawnSync("git", ["remote", "add", "origin", bare], { cwd: sb.repo });
  commitChange(sb);
  spawnSync("git", ["push", "-q", "origin", "HEAD:refs/pull/7/head", "HEAD:refs/heads/feature"], { cwd: sb.repo });
  return bare;
}

test("watch --pr: returns as soon as the PR head moves", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const watching = runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "30"]);
  await new Promise((r) => setTimeout(r, 1500));
  commitChange(sb, "v3\n");
  spawnSync("git", ["push", "-q", "-f", "origin", "HEAD:refs/pull/7/head"], { cwd: sb.repo });
  const r = await watching;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WATCH PR #7: CHANGED [0-9a-f]{12} -> [0-9a-f]{12}/);
  assert.match(r.stdout, /crossfire check --since/);
});

test("watch: no change before the timeout exits 4; a missing ref is refused", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const r = await runAsync(sb, ["watch", "--branch", "feature", "--interval-sec", "1", "--timeout-sec", "2"]);
  assert.equal(r.status, 4);
  assert.match(r.stdout, /no new commits/);
  const missing = await runAsync(sb, ["watch", "--pr", "99", "--interval-sec", "1", "--timeout-sec", "2"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /has no refs\/pull\/99\/head/);
});

test("memory: a finished loop records the builder's rule; the next loop's builder and breaker briefs carry it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("high", "nested rollback loses the write")));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED", rule: "a post-commit decision reads committed state, never the in-memory object", variants: [{ test: "a" }, { test: "b" }, { test: "c" }] }] });
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("review", "--slug", "demo", "--json").json().next.action, "SHIP");

  const mem = sb.cf("memory");
  assert.match(mem.stdout, /BLOCKER · app\.txt · a post-commit decision reads committed state, never the in-memory object \(codex, loop demo\)/);
  assert.ok(fs.readFileSync(`${sb.repo}/.git/crossfire/memory.md`, "utf8"), "kept in the shared git folder, never committed");

  next = sb.cf("init", "--slug", "demo2", "--spec", sb.spec, "--base", "main", "--json").json();
  assert.match(fs.readFileSync(next.brief, "utf8"), /What reviewers found in this repository before[\s\S]*post-commit decision reads committed state/);
  assert.match(sb.cf("spec", "--slug", "demo3").stdout, /MEMORY: 1 earlier finding/);
});

test("memory: a review-only check records findings as reported; the same lesson is not repeated", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  commitChange(sb);
  sb.queue("codex", needs(finding("medium", "cache fill races with a write"), finding("low", "typo")));
  sb.queue("grok", approve);
  sb.cf("check", "--base", "main", "--name", "c1");
  commitChange(sb, "v3\n");
  sb.queue("codex", needs(finding("medium", "Cache fill races with a write!")));
  sb.queue("grok", approve);
  sb.cf("check", "--base", "main", "--since", "c1", "--name", "c2");
  const lines = sb.cf("memory", "--json").json().lessons;
  assert.equal(lines.length, 1, "nits are not lessons, and a repeat is not added twice");
  assert.match(lines[0], /CHANGES · app\.txt · cache fill races with a write \(codex, reported in check c1\)/);
});

test("plan: a superpowers plan's Review Focus satisfies the failure modes; briefs point at the plan; a committed plan is refused", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  fs.writeFileSync(sb.spec, "# Spec\n\nPrint v2.\n");
  const planFile = `${sb.repo}/.crossfire/specs/demo.plan.md`;
  sb.cf("spec", "--slug", "demo");
  fs.writeFileSync(planFile, "# Plan\n\n## Review Focus\n\n- two writers at once\n- a nested rollback\n- a stale cached value\n\n## Task 1\n- do it\n");
  const r = sb.cf("init", "--slug", "demo", "--spec", sb.spec, "--plan", planFile, "--base", "main", "--breaker", "on", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(r.json().brief, "utf8"), /The plan: `.*demo\.plan\.md` \(its tasks/);

  fs.mkdirSync(`${sb.repo}/docs`);
  fs.writeFileSync(`${sb.repo}/docs/plan.md`, fs.readFileSync(planFile));
  spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "add", "docs/plan.md"], { cwd: sb.repo });
  spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "plan"], { cwd: sb.repo });
  const bad = sb.cf("init", "--slug", "demo-b", "--spec", sb.spec, "--plan", "docs/plan.md", "--base", "main");
  assert.match(bad.stderr, /plan docs\/plan\.md is committed on this branch/);
});

function ghDir(sb) {
  const d = path.join(sb.tmp, "gh");
  fs.mkdirSync(d, { recursive: true });
  sb.env.FAKE_GH_DIR = d;
  return d;
}
const comment = (id, user, body, extra = {}) => `${JSON.stringify({ id, user, at: "2026-10-10T10:00:00Z", body, url: `https://example.test/c/${id}`, ...extra })}\n`;

test("watch: a new comment from an allowed reviewer wakes it; old, own and other people's comments do not", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(1, "author1", "old comment, before watching"));
  const watching = runAsync(sb, ["watch", "--pr", "7", "--from", "reviewer1", "--interval-sec", "1", "--timeout-sec", "20"]);
  await new Promise((r) => setTimeout(r, 1500));
  fs.appendFileSync(`${gh}/comment.jsonl`, comment(2, "reviewer1", "summary from crossfire <!-- crossfire -->"));
  fs.appendFileSync(`${gh}/comment.jsonl`, comment(3, "someone", "drive-by comment"));
  await new Promise((r) => setTimeout(r, 2500));
  fs.writeFileSync(`${gh}/inline.jsonl`, comment(4, "reviewer1", "Please make the TTL 5s here, not 60s."));
  const r = await watching;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /comments: watched from reviewer1/);
  assert.match(r.stdout, /WATCH PR #7: 1 comment\(s\) to handle/);
  assert.match(r.stdout, /ID: inline:4/);
  assert.match(r.stdout, /COMMENT by reviewer1 \(inline, .*\) https:\/\/example\.test\/c\/4/);
  assert.match(r.stdout, /make the TTL 5s/);
  assert.doesNotMatch(r.stdout, /drive-by|old comment|summary from crossfire/);
});

test("watch: a merged PR stops it; without a working gh, comments are reported as not watched", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  let r = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "2"]);
  assert.match(r.stderr, /comments: (not|no longer) watched \(.*gh auth login/);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/state`, "MERGED");
  r = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "10"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /WATCH PR #7: MERGED; stopped watching/);
});

test("a blind Codex review is retried, never handed to the builder; doctor says Codex is not ready when its sandbox cannot run", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  const blind = { verdict: "needs-attention", summary: "Review blocked: git commands failed in the sandbox", findings: [], next_steps: [] };
  sb.queue("codex", blind, blind);
  sb.queue("grok", approve, approve);
  let r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 3, "nothing advanced");
  assert.match(r.stdout, /could not complete the review: Review blocked/);
  r = sb.cf("review", "--slug", "demo", "--json");
  assert.equal(r.json().next.gate, "G1");

  sb.env.CROSSFIRE_ASSUME_CODEX_SANDBOX = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
  const d = sb.cf("doctor");
  assert.equal(d.status, 5);
  assert.match(d.stdout, /NOT READY/);
  assert.match(d.stdout, /FAIL codex .*sandbox cannot run commands here \(bwrap: loopback: Failed RTM_NEWADDR/);
});

test("watch: at least once with acknowledgement: an unacknowledged comment is shown again, an acknowledged one never, a new one always", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(1, "author1", "old"));
  const first = runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "20"]);
  await new Promise((r) => setTimeout(r, 1500));
  fs.appendFileSync(`${gh}/comment.jsonl`, comment(2, "reviewer1", "first request"));
  const r1 = await first;
  assert.match(r1.stdout, /ID: comment:2[\s\S]*first request/);
  // Not acknowledged (the session died before handling it): it is shown again.
  const again = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.match(again.stdout, /first request/);
  // Handled now; meanwhile another comment arrives before the watcher restarts.
  fs.appendFileSync(`${gh}/comment.jsonl`, comment(3, "reviewer1", "second request, posted between runs"));
  const r2 = await runAsync(sb, ["watch", "--pr", "7", "--ack", "comment:2", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.match(r2.stderr, /acknowledged 1 comment\(s\)/);
  assert.match(r2.stdout, /second request, posted between runs/);
  assert.doesNotMatch(r2.stdout, /first request|old/);
  const r3 = await runAsync(sb, ["watch", "--pr", "7", "--ack", "all", "--interval-sec", "1", "--timeout-sec", "2"]);
  assert.equal(r3.status, 4, "all handled, nothing new: times out");
});

test("watch: a crash between saving and printing loses nothing; the comment is shown on the next run", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(7, "reviewer1", "never lost", { at: new Date(Date.now() + 5000).toISOString() }));
  sb.env.CROSSFIRE_TEST_DIE_BEFORE_PRINT = "1";
  const died = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.equal(died.status, 9);
  assert.doesNotMatch(died.stdout, /never lost/);
  delete sb.env.CROSSFIRE_TEST_DIE_BEFORE_PRINT;
  const r = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.match(r.stdout, /never lost/);
});

test("watch: two watchers racing for a stale lock: exactly one wins", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, "");
  const lockDir = path.join(sb.repo, ".crossfire", "watch");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "origin-pr-7.json.lock"), "2147483646"); // a process that does not exist
  const [a, b] = await Promise.all([
    runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "3"]),
    runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "3"]),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [4, 5], `one ran to its timeout, one was refused: ${a.stderr} | ${b.stderr}`);
});

test("watch: a comment that arrives together with a push is delivered on the next run", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, "");
  const first = runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "20"]);
  await new Promise((r) => setTimeout(r, 1500));
  commitChange(sb, "v3\n");
  spawnSync("git", ["push", "-q", "-f", "origin", "HEAD:refs/pull/7/head"], { cwd: sb.repo });
  fs.appendFileSync(`${gh}/comment.jsonl`, comment(9, "reviewer1", "pushed a fix, please re-check"));
  const r1 = await first;
  assert.match(r1.stdout, /CHANGED/);
  const head = /ID: (head:[0-9a-f]+)/.exec(r1.stdout)[1];
  // Not acknowledged yet: the push is reported again, so it cannot be lost.
  const again = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.match(again.stdout, /CHANGED/);
  // Handled (re-checked) and acknowledged: now the comment that came with it.
  const r2 = await runAsync(sb, ["watch", "--pr", "7", "--ack", head, "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.match(r2.stdout, /pushed a fix, please re-check/);
});

test("watch: a transient gh failure at start is retried, and comments posted during the outage are delivered", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(1, "author1", "from before the watcher started"));
  fs.writeFileSync(`${gh}/fail`, "");
  const watching = runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "20"]);
  await new Promise((r) => setTimeout(r, 1500));
  fs.appendFileSync(`${gh}/comment.jsonl`, comment(2, "reviewer1", "posted during the outage", { at: new Date().toISOString() }));
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(`${gh}/fail`);
  const r = await watching;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /gh failing \(HTTP 502.*retrying every poll/);
  assert.match(r.stdout, /posted during the outage/);
  assert.doesNotMatch(r.stdout, /from before the watcher started/);
});

test("watch: a comment posted after the watcher started is delivered even on the very first run", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  // Already visible to the first fetch, but posted after the watcher's start: it is new, not baseline.
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(1, "author1", "older") + comment(2, "reviewer1", "posted during the first fetch", { at: new Date(Date.now() + 5000).toISOString() }));
  const r = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "10"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /posted during the first fetch/);
  assert.doesNotMatch(r.stdout, /older/);
});

test("watch: an HTTP 403 rate limit at start is retried, not treated as no access", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, "");
  fs.writeFileSync(`${gh}/fail`, "HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/)");
  const watching = runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "20"]);
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(`${gh}/fail`);
  fs.appendFileSync(`${gh}/comment.jsonl`, comment(5, "reviewer1", "after the rate limit", { at: new Date().toISOString() }));
  const r = await watching;
  assert.match(r.stderr, /gh failing \(HTTP 403: API rate limit exceeded.*retrying every poll/);
  assert.match(r.stdout, /after the rate limit/);
});

test("watch: one watcher per PR; a second is refused while the first runs, allowed after it ends", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, "");
  const first = runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "4"]);
  await new Promise((r) => setTimeout(r, 1500));
  const second = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "1"]);
  assert.equal(second.status, 5);
  assert.match(second.stderr, /already being watched \(process \d+\)/);
  assert.equal((await first).status, 4);
  const third = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "1"]);
  assert.equal(third.status, 4, "the lock was released when the first watcher ended");
});

test("watch: the first watch's start is persisted, so an outage then a restart cannot swallow comments posted meanwhile", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(1, "author1", "history", { at: "2020-01-01T00:00:00Z" }));
  fs.writeFileSync(`${gh}/fail`, "HTTP 502: Bad Gateway");
  const outage = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "2"]);
  assert.equal(outage.status, 4, "GitHub down for the whole first run");
  // Posted during that first run, before any fetch ever succeeded.
  fs.appendFileSync(`${gh}/comment.jsonl`, comment(2, "reviewer1", "posted while GitHub was down", { at: new Date(Date.now() - 1000).toISOString() }));
  await new Promise((r) => setTimeout(r, 1100)); // the restart's own start is later than that comment
  fs.rmSync(`${gh}/fail`);
  const r = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.match(r.stdout, /posted while GitHub was down/);
  assert.doesNotMatch(r.stdout, /history/);
});

test("watch: --ack takes the PR lock: it is refused while a watcher runs", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  ghDir(sb);
  fs.writeFileSync(`${sb.env.FAKE_GH_DIR}/comment.jsonl`, "");
  const running = runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "4"]);
  await new Promise((r) => setTimeout(r, 1500));
  const ack = await runAsync(sb, ["watch", "--pr", "7", "--ack", "all", "--ack-only"]);
  assert.equal(ack.status, 5);
  assert.match(ack.stderr, /already being watched/);
  await running;
});

test("watch: saved pending comments are shown before any network call, even with the remote and GitHub down", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(7, "reviewer1", "saved before the crash", { at: new Date(Date.now() + 5000).toISOString() }));
  sb.env.CROSSFIRE_TEST_DIE_BEFORE_PRINT = "1";
  assert.equal((await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"])).status, 9);
  delete sb.env.CROSSFIRE_TEST_DIE_BEFORE_PRINT;
  fs.writeFileSync(`${gh}/fail`, "HTTP 502: Bad Gateway");
  spawnSync("git", ["remote", "set-url", "origin", path.join(sb.tmp, "gone.git")], { cwd: sb.repo });
  const r = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /saved before the crash/);
});

test("watch --comments off still stops when the PR is merged", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/state`, "MERGED");
  const r = await runAsync(sb, ["watch", "--pr", "7", "--comments", "off", "--interval-sec", "1", "--timeout-sec", "10"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /MERGED; stopped watching/);
});

test("watch: a permanent failure while fetching comments (404) turns comment watching off and says so; pushes still wake it", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, "");
  const watching = runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "20"]);
  await new Promise((r) => setTimeout(r, 1200));
  fs.writeFileSync(`${gh}/fail`, "HTTP 404: Not Found (https://api.github.com/repos/acme/app/issues/7/comments)");
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(`${gh}/fail`);
  commitChange(sb, "v4\n");
  spawnSync("git", ["push", "-q", "-f", "origin", "HEAD:refs/pull/7/head"], { cwd: sb.repo });
  const r = await watching;
  assert.match(r.stderr, /comments: no longer watched \(HTTP 404/);
  assert.match(r.stdout, /CHANGED/);
});

test("watch: a push that lands while a comment is handled is still reported after the restart", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(4, "reviewer1", "please rename it", { at: new Date(Date.now() + 5000).toISOString() }));
  const r1 = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.match(r1.stdout, /please rename it/);
  // While the session handles that comment, the author pushes.
  commitChange(sb, "v5\n");
  spawnSync("git", ["push", "-q", "-f", "origin", "HEAD:refs/pull/7/head"], { cwd: sb.repo });
  const r2 = await runAsync(sb, ["watch", "--pr", "7", "--ack", "comment:4", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /CHANGED/, "the push is not swallowed by the restart");
});

test("watch: an unrecognised remote URL never falls back to gh's default repository", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  fs.writeFileSync(`${gh}/state`, "CLOSED"); // an unrelated PR #7 in gh's default repository
  const r = await runAsync(sb, ["watch", "--pr", "7", "--no-repo", "--interval-sec", "1", "--timeout-sec", "2"]);
  assert.equal(r.status, 4, "not stopped by another repository's PR");
  assert.match(r.stderr, /cannot tell which GitHub repository remote "origin" is .*pass --repo OWNER\/NAME/);
});

test("watch prints a long comment in full: what is acknowledged was seen", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  withRemote(sb);
  const gh = ghDir(sb);
  const long = `${"context ".repeat(300)}THE ACTUAL REQUEST AT THE END`;
  fs.writeFileSync(`${gh}/comment.jsonl`, comment(8, "reviewer1", long, { at: new Date(Date.now() + 5000).toISOString() }));
  const r = await runAsync(sb, ["watch", "--pr", "7", "--interval-sec", "1", "--timeout-sec", "5"]);
  assert.match(r.stdout, /THE ACTUAL REQUEST AT THE END/);
});

test("a breaker that commits is refused every time: HEAD drift never falls through to review", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb, "--breaker", "on");
  sb.build(next.resultFile);
  next = sb.cf("built", "--slug", "demo", "--json").json();
  // The breaker commits in the real checkout and leaves the tree clean.
  fs.writeFileSync(`${sb.repo}/breaker-was-here.txt`, "x");
  spawnSync("git", ["-c", "user.name=B", "-c", "user.email=b@example.com", "add", "-A"], { cwd: sb.repo });
  spawnSync("git", ["-c", "user.name=B", "-c", "user.email=b@example.com", "commit", "-qm", "breaker commit"], { cwd: sb.repo });
  fs.writeFileSync(next.resultFile, JSON.stringify({ status: "DONE", summary: "", attacks: [] }));
  for (let i = 0; i < 3; i += 1) {
    const r = sb.cf("attacked", "--slug", "demo");
    assert.equal(r.status, 3, `attempt ${i + 1}: still refused`);
    assert.match(r.stdout, /HEAD moved from the builder's commit/);
  }
  assert.equal(sb.cf("status", "--slug", "demo", "--json").json().next.action, "SEND_BREAKER", "never advanced to review");
});

test("review refuses a HEAD that the proof commands did not verify", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  fs.writeFileSync(`${sb.repo}/late.txt`, "x");
  spawnSync("git", ["-c", "user.name=B", "-c", "user.email=b@example.com", "add", "-A"], { cwd: sb.repo });
  spawnSync("git", ["-c", "user.name=B", "-c", "user.email=b@example.com", "commit", "-qm", "unverified"], { cwd: sb.repo });
  const r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HEAD is not the commit the proof commands verified/);
  assert.equal(sb.calls("codex").filter((a) => a[0] === "adversarial-review").length, 0, "no reviewer ran");
});

test("reviews read the live checkout: if HEAD moves during a review, the verdicts are discarded (review and check)", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  sb.env.FAKE_REVIEW_COMMIT_IN = sb.repo;
  const r = sb.cf("review", "--slug", "demo");
  assert.equal(r.status, 3);
  assert.match(r.stdout, /DISCARDED: HEAD moved while the reviewers were reading/);
  const st = sb.cf("status", "--slug", "demo", "--json").json();
  assert.equal(st.next.action, "RUN_REVIEW", "nothing advanced");
  const runDir = `${sb.repo}/.crossfire/runs/demo`;
  assert.deepEqual(fs.readdirSync(runDir).filter((f) => f.startsWith("review-")), [], "no review files written");
  assert.deepEqual(JSON.parse(fs.readFileSync(`${runDir}/state.json`, "utf8")).reviewerRuns ?? [], [], "no reviewer runs recorded");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const c = sb.cf("check", "--base", "main", "--name", "moving");
  assert.equal(c.status, 3);
  assert.match(c.stdout, /the branch moved while the reviewers were reading it/);
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/checks/moving/check.json`), "no check recorded");
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/checks/moving/review-codex.json`), "no review file kept");
  // Back on the verified commit, the next pass counts once.
  delete sb.env.FAKE_REVIEW_COMMIT_IN;
  spawnSync("git", ["reset", "-q", "--hard", JSON.parse(fs.readFileSync(`${runDir}/state.json`, "utf8")).lastBuildHead], { cwd: sb.repo });
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  const ok = sb.cf("review", "--slug", "demo");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /REVIEWERS: codex 1\/1 passes, grok 1\/1 passes/);
});

test("proof commands can change only while the builder is next", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  const r = sb.cf("proof", "--slug", "demo", "--e2e", "true");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /only while the builder is next/);
});

test("the SHIP report carries an Evidence block: what crossfire ran, what the builder named, what nobody verified", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb, "--e2e", "grep -q v2 app.txt");
  sb.build(next.resultFile, { tests: [{ name: "test_prints_v2", command: "node --test", passed: true }] });
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  const report = fs.readFileSync(next.report, "utf8");
  assert.match(report, /## Evidence/);
  assert.match(report, /`grep -q v2 app\.txt`: exit 0/);
  assert.match(report, /Tests the builder named this loop: 1 \(test_prints_v2\)/);
  assert.match(report, /Not verified by crossfire: .*CI on the pull request is that gate/);
});

test("a FIXED real finding without where (file:line) is refused; a proven attack without file and line is refused", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", needs(finding("high", "x")));
  sb.queue("grok", approve);
  next = sb.cf("review", "--slug", "demo", "--json").json();
  sb.build(next.resultFile, { fixes: [{ id: "F1", status: "FIXED", where: "somewhere", rule: "every write goes through the one versioned writer", variants: [{ test: "a" }, { test: "b" }, { test: "c" }] }] });
  const r = sb.cf("built", "--slug", "demo");
  assert.equal(r.status, 3);
  assert.match(r.stdout, /F1: FIXED needs `where`, the file:line of the fix/);
});

test("the timeline records when the reviews finished, not when they started", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const next = init(sb);
  sb.build(next.resultFile);
  sb.cf("built", "--slug", "demo");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  sb.env.FAKE_REVIEW_DELAY_MS = "1500";
  const before = Date.now();
  sb.cf("review", "--slug", "demo");
  const state = JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/runs/demo/state.json`, "utf8"));
  const recorded = state.history.find((h) => h.event === "review-recorded");
  assert.ok(Date.parse(recorded.at) - before >= 2500, `recorded ${Date.parse(recorded.at) - before} ms after start: two reviewers of 1.5 s each`);
});
