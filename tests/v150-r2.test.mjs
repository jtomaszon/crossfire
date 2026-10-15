// 1.5.0 round 2: the printed worktree commands are printed only when they can work, a command never
// records over a state that changed under it, and abandon cannot run while a command holds the loop.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, sh, approve, CLI, ROOT } from "./helpers.mjs";

const LIB = path.join(ROOT, "plugins", "crossfire", "scripts", "lib");
const { loadState, saveState } = await import(path.join(LIB, "store.mjs"));

const H = 3600 * 1000;
const tmpdir = () => fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "cf-lock-"));

// ---- F2/F3: the worktree command is printed only when it can work as printed ----

const init = (sb, slug, ...extra) => sb.cf("init", "--slug", slug, "--spec", sb.spec, "--base", "main", "--breaker", "off", ...extra);

test("F3: the skill's sequence (switch -c <slug> here, then init) names the checkout instead of a worktree add that fails", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  sh(sb.repo, "git", ["switch", "-q", "-c", "two"]);
  const r = init(sb, "two");
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(`the loop's branch two is already checked out at ${fs.realpathSync(sb.repo)} (this checkout)`), r.stderr);
  assert.match(r.stderr, /pick another slug/);
  assert.doesNotMatch(r.stderr, /git worktree add|mkdir -p/);
});

test("F2: a branch checked out in another worktree: run init there or pick another slug", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const wt = path.join(sb.tmp, "elsewhere");
  sh(sb.repo, "git", ["worktree", "add", "-q", "-b", "two", wt, "main"]);
  assert.equal(init(sb, "one").status, 0);
  const r = init(sb, "two");
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(`the loop's branch two is already checked out at ${fs.realpathSync(wt)}; run crossfire init there, or pick another slug`), r.stderr);
  assert.doesNotMatch(r.stderr, /git worktree add/);
});

test("F2: same-slug --force refusal while the slug's branch is checked out here prints no worktree add", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  sh(sb.repo, "git", ["switch", "-q", "-c", "demo"]);
  let r = init(sb, "demo", "--json");
  assert.equal(r.status, 0);
  sb.build(r.json().resultFile);
  sb.cf("built", "--slug", "demo");
  r = init(sb, "demo", "--force");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has recorded steps since its init/);
  assert.match(r.stderr, /the loop's branch demo is already checked out at .* \(this checkout\)/);
  assert.doesNotMatch(r.stderr, /git worktree add/);
});

test("F2: a branch that exists and is checked out nowhere still gets the runnable worktree add", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  sh(sb.repo, "git", ["branch", "two", "main"]);
  assert.equal(init(sb, "one").status, 0);
  const r = init(sb, "two");
  assert.ok(r.stderr.includes("git worktree add ../repo-two two\n"), r.stderr);
});

// ---- F4: a command records only over the state it read; abandon waits for no one, it refuses ----

/** A script that runs crossfire commands and logs each exit status and stderr to side.log. */
function sideScript(sb, then) {
  const file = path.join(sb.tmp, "side.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs"; import { spawnSync } from "node:child_process";
for (const args of ${JSON.stringify(then)}) {
  const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...args], { encoding: "utf8" });
  fs.appendFileSync(${JSON.stringify(path.join(sb.tmp, "side.log"))}, args[0] + " " + r.status + " " + r.stderr.split("\\n")[0] + "\\n");
}
`,
  );
  return file;
}

const readState = (sb, slug) => JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/runs/${slug}/state.json`, "utf8"));
function ageLoop(sb, slug, ms) {
  const file = `${sb.repo}/.crossfire/runs/${slug}/state.json`;
  const st = readState(sb, slug);
  st.startedAt = new Date(Date.now() - ms).toISOString();
  for (const h of st.history) h.at = st.startedAt;
  fs.writeFileSync(file, JSON.stringify(st));
}

test("F4: abandon while a review waits on its reviewers refuses; the review records its result", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let r = init(sb, "one", "--json", "--grok", "off");
  assert.equal(r.status, 0, r.stderr);
  sb.build(r.json().resultFile);
  assert.equal(sb.cf("built", "--slug", "one").status, 0);
  ageLoop(sb, "one", 4 * H);
  sb.queue("codex", approve);
  const p = new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "review", "--slug", "one"], { cwd: sb.repo, env: { ...sb.env, FAKE_REVIEW_DELAY_MS: "2500" } });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stderr }));
  });
  await new Promise((res) => setTimeout(res, 1000));
  const side = spawnSync(process.execPath, [sideScript(sb, [["abandon", "--slug", "one", "--cwd", sb.repo]])], { encoding: "utf8" });
  assert.equal(side.status, 0, side.stderr);
  const rv = await p;
  assert.match(fs.readFileSync(path.join(sb.tmp, "side.log"), "utf8"), /^abandon 5 .*another crossfire command is running for this loop/);
  assert.equal(rv.status, 0, rv.stderr);
  assert.equal(readState(sb, "one").phase, "shipped");
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs/one/.lock`), "no lock left behind");
});

test("F4: neither abandon nor a restarting init can run under an in-flight built", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const restart = ["init", "--slug", "one", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--force", "--cwd", sb.repo];
  const side = sideScript(sb, [["abandon", "--slug", "one", "--cwd", sb.repo], restart]);
  // Nothing recorded since init, so --force would restart it, if built did not hold the loop.
  let r = init(sb, "one", "--json", "--no-preflight", "--e2e", `node ${side}`);
  assert.equal(r.status, 0, r.stderr);
  sb.build(r.json().resultFile);
  ageLoop(sb, "one", 4 * H);
  r = sb.cf("built", "--slug", "one");
  const log = fs.readFileSync(path.join(sb.tmp, "side.log"), "utf8");
  assert.match(log, /^abandon 5 /m, log);
  assert.match(log, /^init 5 .*another crossfire command is running for this loop/m, log);
  assert.equal(r.status, 0, r.stderr);
  const st = readState(sb, "one");
  assert.ok(st.history.length > st.initEvents, "built recorded its step");
});

test("F4: built, review and attacked refuse a loop whose state is terminal", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  const file = `${sb.repo}/.crossfire/runs/one/state.json`;
  const st = readState(sb, "one");
  st.startedAt = new Date(Date.now() - 4 * H).toISOString();
  for (const h of st.history) h.at = st.startedAt;
  fs.writeFileSync(file, JSON.stringify(st));
  assert.equal(sb.cf("abandon", "--slug", "one").status, 0);
  const before = fs.readFileSync(file, "utf8");
  for (const cmd of ["built", "review", "attacked"]) {
    const r = sb.cf(cmd, "--slug", "one");
    assert.equal(r.status, 4, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /already escalated/);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("F4: saveState refuses a state object when state.json changed after it was read, and accepts its own later saves", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ slug: "one", phase: "build", history: [] }));
  const mine = loadState(dir);
  mine.phase = "review";
  saveState(dir, mine);
  mine.memoryWritten = true;
  saveState(dir, mine); // its own earlier save is what it read
  const other = loadState(dir);
  other.phase = "escalated";
  saveState(dir, other);
  mine.phase = "shipped";
  assert.throws(() => saveState(dir, mine), (e) => e.exitCode === 4 && /changed while this command ran \(now escalated\)/.test(e.message));
  fs.rmSync(path.join(dir, "state.json"));
  assert.throws(() => saveState(dir, other), /changed while this command ran \(now removed\)/);
  assert.equal(fs.existsSync(path.join(dir, "state.json")), false);
});
