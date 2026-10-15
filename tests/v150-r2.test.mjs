// 1.5.0 round 2: a lock is removed only by the process that may remove it, the printed worktree
// commands are printed only when they can work, and a command never records over a state that
// changed under it (an abandon is not undone).
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, sh, approve, CLI, ROOT } from "./helpers.mjs";

const LIB = path.join(ROOT, "plugins", "crossfire", "scripts", "lib");
const { withFileLock } = await import(path.join(LIB, "util.mjs"));
const { loadState, saveState } = await import(path.join(LIB, "store.mjs"));

const H = 3600 * 1000;
const tmpdir = () => fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "cf-lock-"));
const backdate = (file, ms) => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
};

/** Record every rename or removal of `lock` that would take away a lock whose content is `live`. */
function guardLive(t, lock, live) {
  const violations = [];
  const check = (p, op) => {
    if (path.resolve(String(p)) !== path.resolve(lock)) return;
    let text = null;
    try {
      text = fs.readFileSync(lock, "utf8");
    } catch {
      /* none */
    }
    if (text === live) violations.push(op);
  };
  for (const op of ["renameSync", "rmSync", "unlinkSync"]) {
    const orig = fs[op];
    mock.method(fs, op, function (p, ...rest) {
      check(p, op);
      return orig.call(fs, p, ...rest);
    });
  }
  t.after(() => mock.restoreAll());
  return violations;
}

// ---- F1/F5: a lock is removed only by its holder, or by the one process that claimed the exact stale lock it judged ----

test("F1: a stale lock replaced by a fresh one after it was judged stale is never moved or removed", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, "crashed-holder");
  backdate(lock, 120_000);
  // Between the waiter's look at the stale lock and its takeover, the stale holder lets go and B takes the lock.
  const origStat = fs.statSync;
  const origFstat = fs.fstatSync;
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    origStat.call(fs, lock); // the stale one was seen
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, "B-live", { flag: "wx" });
  };
  for (const [name, orig] of [["statSync", origStat], ["fstatSync", origFstat]]) {
    mock.method(fs, name, function (...args) {
      const r = orig.apply(fs, args);
      if (name === "fstatSync" || path.resolve(String(args[0])) === lock) {
        if (!swapped && Date.now() - r.mtimeMs > 60_000) {
          swap();
        }
      }
      return r;
    });
  }
  const violations = guardLive(t, lock, "B-live");
  let ran = false;
  assert.throws(() => withFileLock(lock, () => (ran = true), { waitMs: 300 }), (e) => e.lockBusy === true);
  assert.equal(ran, false, "B holds the lock: the waiter never enters");
  assert.deepEqual(violations, [], "B's live lock was never moved aside or removed");
  assert.equal(fs.readFileSync(lock, "utf8"), "B-live");
});

test("F1: a stale lock whose takeover another process has claimed is left to it; the waiter fails with a clear message", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, "crashed-holder");
  backdate(lock, 120_000);
  // Another process claimed this stale lock first: its claim is the only one allowed to remove it.
  const first = (() => {
    let claim = null;
    const orig = fs.writeFileSync;
    mock.method(fs, "writeFileSync", function (p, ...rest) {
      if (String(p).startsWith(`${lock}.takeover-`) && !claim) {
        claim = String(p);
        orig.call(fs, p, ...rest);
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); // as if the other process got there first
      }
      return orig.call(fs, p, ...rest);
    });
    return () => claim;
  })();
  t.after(() => mock.restoreAll());
  let ran = false;
  assert.throws(
    () => withFileLock(lock, () => (ran = true), { waitMs: 200 }),
    (e) => e.lockBusy === true && /is stale and .*takeover-.* claims it/.test(e.message) && /remove both/.test(e.message),
  );
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(lock, "utf8"), "crashed-holder", "only the claimant may remove it");
  assert.ok(first(), "a claim was attempted");
});

test("F5: a holder whose lock was taken over never removes the lock its successor now holds", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  let violations;
  withFileLock(lock, () => {
    // This holder ran past the stale limit; a waiter took the lock over and C holds it now.
    backdate(lock, 120_000);
    withFileLock(lock, () => {}, { waitMs: 0 }); // the takeover (and its release)
    fs.writeFileSync(lock, "C-live", { flag: "wx" });
    violations = guardLive(t, lock, "C-live");
  });
  assert.deepEqual(violations, [], "the late holder's release left C's lock alone");
  assert.equal(fs.readFileSync(lock, "utf8"), "C-live");
});

test("F5: a holder releasing while a waiter has claimed its stale lock leaves the removal to the waiter", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  let claim = null;
  withFileLock(lock, () => {
    const token = fs.readFileSync(lock, "utf8");
    // A waiter is between its claim and its removal: the claim file for this token exists.
    const orig = fs.writeFileSync;
    mock.method(fs, "writeFileSync", function (p, ...rest) {
      if (String(p).startsWith(`${lock}.takeover-`)) {
        claim = String(p);
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      return orig.call(fs, p, ...rest);
    });
    t.after(() => mock.restoreAll());
    assert.ok(token.length > 0);
  });
  mock.restoreAll();
  assert.ok(claim, "the release asked for the claim first");
  assert.ok(fs.existsSync(lock), "the claimant removes it, not the holder");
});

test("F5/FM-6: a crashed holder's lock is taken over and no claim file is left behind", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  for (const content of ["999999-crashed", ""]) {
    fs.writeFileSync(lock, content);
    backdate(lock, 61_000);
    assert.equal(withFileLock(lock, () => 42, { waitMs: 0 }), 42);
    assert.deepEqual(fs.readdirSync(dir), [], `nothing left after taking over ${JSON.stringify(content)}`);
  }
});

test("F1: many processes racing over a stale lock: their critical sections never overlap", async (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, "crashed");
  backdate(lock, 120_000);
  const inside = path.join(dir, "inside");
  const script = `import fs from "node:fs"; import { withFileLock } from "${LIB}/util.mjs";
    for (let k = 0; k < 5; k++) withFileLock(${JSON.stringify(lock)}, () => {
      fs.writeFileSync(${JSON.stringify(inside)}, String(process.pid), { flag: "wx" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      fs.rmSync(${JSON.stringify(inside)});
    }, { waitMs: 20000 });`;
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", script]);
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (status) => resolve({ status, err }));
      }),
    ),
  );
  assert.ok(results.every((r) => r.status === 0), results.map((r) => r.err).join("\n"));
  assert.deepEqual(fs.readdirSync(dir), []);
});

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

// ---- F4: a command records only over the state it read; an abandon is not undone ----

function ageScript(sb, slug, then) {
  const file = path.join(sb.tmp, `age-${slug}.mjs`);
  fs.writeFileSync(
    file,
    `import fs from "node:fs"; import { spawnSync } from "node:child_process";
const dir = ${JSON.stringify(`${sb.repo}/.crossfire/runs/${slug}`)};
const old = new Date(Date.now() - 4 * ${H});
fs.utimesSync(dir + "/.lock", old, old);
const st = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
st.startedAt = old.toISOString();
for (const h of st.history) h.at = old.toISOString();
fs.writeFileSync(dir + "/state.json", JSON.stringify(st));
for (const args of ${JSON.stringify(then)}) {
  const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...args], { encoding: "utf8" });
  fs.appendFileSync(${JSON.stringify(path.join(sb.tmp, "side.log"))}, args[0] + " " + r.status + " " + r.stderr + "\\n");
}
`,
  );
  return `node ${file}`;
}

const readState = (sb, slug) => JSON.parse(fs.readFileSync(`${sb.repo}/.crossfire/runs/${slug}/state.json`, "utf8"));

test("F4: abandon while built runs its proof commands past the stale limit: built records nothing over it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let r = init(sb, "one", "--json", "--e2e", "true");
  assert.equal(r.status, 0, r.stderr);
  const proofCmd = ageScript(sb, "one", [["abandon", "--slug", "one"]]);
  assert.equal(sb.cf("proof", "--slug", "one", "--e2e", proofCmd).status, 0);
  sb.build(r.json().resultFile);
  r = sb.cf("built", "--slug", "one");
  assert.match(fs.readFileSync(path.join(sb.tmp, "side.log"), "utf8"), /^abandon 0 /, "the abandon itself went through");
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stderr, /the state of loop one changed while this command ran \(now escalated\); nothing was recorded/);
  const st = readState(sb, "one");
  assert.equal(st.phase, "escalated");
  assert.equal(st.terminal.gate, "ABANDONED");
  assert.equal(sb.cf("status", "--slug", "one").status, 0);
});

test("F4: abandon while a review waits on its reviewers: the review records nothing and the loop stays abandoned", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let r = init(sb, "one", "--json", "--grok", "off");
  assert.equal(r.status, 0, r.stderr);
  sb.build(r.json().resultFile);
  assert.equal(sb.cf("built", "--slug", "one").status, 0);
  sb.queue("codex", approve);
  const p = new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "review", "--slug", "one"], { cwd: sb.repo, env: { ...sb.env, FAKE_REVIEW_DELAY_MS: "2500" } });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stderr }));
  });
  await new Promise((res) => setTimeout(res, 1000));
  const aged = spawnSync(process.execPath, [ageScript(sb, "one", [["abandon", "--slug", "one"]]).slice("node ".length)], { cwd: sb.repo, env: sb.env, encoding: "utf8" });
  assert.equal(aged.status, 0, aged.stderr);
  const rv = await p;
  assert.match(fs.readFileSync(path.join(sb.tmp, "side.log"), "utf8"), /^abandon 0 /);
  assert.equal(rv.status, 4, rv.stderr);
  assert.match(rv.stderr, /changed while this command ran \(now escalated\)/);
  assert.equal(readState(sb, "one").terminal.gate, "ABANDONED");
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs/one/.lock`), "no lock left behind");
});

test("F4: a loop restarted under an in-flight built is not overwritten by it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let r = init(sb, "one", "--json");
  assert.equal(r.status, 0, r.stderr);
  const restart = ["init", "--slug", "one", "--spec", sb.spec, "--base", "main", "--breaker", "off", "--cwd", sb.repo];
  const proofCmd = ageScript(sb, "one", [["abandon", "--slug", "one", "--cwd", sb.repo], restart]);
  assert.equal(sb.cf("proof", "--slug", "one", "--e2e", proofCmd).status, 0);
  sb.build(r.json().resultFile);
  r = sb.cf("built", "--slug", "one");
  const side = fs.readFileSync(path.join(sb.tmp, "side.log"), "utf8");
  assert.match(side, /^abandon 0 /m);
  assert.match(side, /^init 0 /m, side);
  assert.equal(r.status, 4, r.stderr);
  const st = readState(sb, "one");
  assert.equal(st.phase, "build", "the restarted loop is untouched");
  assert.equal(st.history.length, st.initEvents);
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
