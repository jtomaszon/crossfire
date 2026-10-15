// 1.5.0 locks: a lock is held while its process is alive on this host, however old it is. Nothing takes
// a lock over automatically: a dead process's lock is cleared only by `crossfire unlock`, on the
// person's word. The memory, reviewer health and precedents files are back to their 1.4.0 behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, CLI, ROOT } from "./helpers.mjs";

const LIB = path.join(ROOT, "plugins", "crossfire", "scripts", "lib");
const { withFileLock, readLock, unlockDead } = await import(path.join(LIB, "util.mjs"));

const H = 3600 * 1000;
const DEAD_PID = 2147483646; // no such process
const tmpdir = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cf-locks-"));
const backdate = (file, ms) => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
};
const lockOf = (pid, host = os.hostname()) => `${pid} ${host}\n2026-01-01T00:00:00.000Z\n`;
const init = (sb, slug, ...extra) => sb.cf("init", "--slug", slug, "--spec", sb.spec, "--base", "main", "--breaker", "off", ...extra);
const stateFile = (sb, slug) => `${sb.repo}/.crossfire/runs/${slug}/state.json`;
const readState = (sb, slug) => JSON.parse(fs.readFileSync(stateFile(sb, slug), "utf8"));
function ageLoop(sb, slug, ms) {
  const st = readState(sb, slug);
  const at = new Date(Date.now() - ms).toISOString();
  st.startedAt = at;
  for (const h of st.history) h.at = at;
  fs.writeFileSync(stateFile(sb, slug), JSON.stringify(st));
}

function child(script, env = process.env) {
  const p = spawn(process.execPath, ["--input-type=module", "-e", script], { env });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve) => p.on("close", (status) => resolve({ status, out, err })));
  return { p, done };
}

// ---- AC-1: the lock file ----

test("AC-1: a lock is created exclusively with `<pid> <hostname>` and the time, and its holder removes it", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  let seen;
  const r = withFileLock(lock, () => {
    seen = fs.readFileSync(lock, "utf8");
    return 7;
  });
  assert.equal(r, 7);
  const [first, second] = seen.split("\n");
  assert.equal(first, `${process.pid} ${os.hostname()}`);
  assert.ok(Number.isFinite(Date.parse(second)), seen);
  assert.ok(!fs.existsSync(lock), "released");
  // The holder removes it on a throw too.
  assert.throws(() => withFileLock(lock, () => {
    throw new Error("boom");
  }), /boom/);
  assert.ok(!fs.existsSync(lock));
});

test("FM-3: a holder never removes a lock it did not create", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  withFileLock(lock, () => {
    fs.rmSync(lock);
    fs.writeFileSync(lock, lockOf(process.pid, "someone-else"));
  });
  assert.equal(fs.readFileSync(lock, "utf8"), lockOf(process.pid, "someone-else"), "the other lock is left alone");
});

// ---- AC-2 / FM-1: a live holder keeps its lock however old it is ----

test("AC-2/FM-1: a lock held by a live process and backdated 5 hours is not taken", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, lockOf(process.pid));
  backdate(lock, 5 * H);
  let ran = false;
  assert.throws(
    () => withFileLock(lock, () => (ran = true), { waitMs: 200, unlock: "crossfire unlock --slug demo" }),
    (e) => e.exitCode === 5 && e.message.includes(lock) && e.message.includes(`${process.pid} ${os.hostname()}`) && /5 h 0 min old/.test(e.message) && /is running/.test(e.message) && e.message.includes("crossfire unlock --slug demo"),
  );
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(lock, "utf8"), lockOf(process.pid), "untouched");
  assert.equal(readLock(lock).alive, true);
});

test("AC-2: a live process of another user (EPERM) counts as alive", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, lockOf(1)); // pid 1: alive, and EPERM unless the tests run as its owner
  assert.equal(readLock(lock).alive, true);
  assert.throws(() => withFileLock(lock, () => {}), (e) => e.exitCode === 5);
  assert.ok(fs.existsSync(lock));
});

// ---- AC-3 / FM-2: a dead, foreign or unreadable lock is refused, never taken over ----

test("AC-3/FM-2: a dead process's lock, another host's lock and an unparsable lock are refused, never taken", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  for (const [content, why] of [
    [lockOf(DEAD_PID), /process 2147483646 .*is gone/],
    [lockOf(process.pid, "another-host.example"), /another host \(another-host\.example\)/],
    ["garbage", /cannot be read as `<pid> <hostname>`/],
    ["", /cannot be read as `<pid> <hostname>`/],
  ]) {
    fs.writeFileSync(lock, content);
    backdate(lock, 2 * H + 3 * 60 * 1000);
    let ran = false;
    assert.throws(
      () => withFileLock(lock, () => (ran = true), { waitMs: 5000, unlock: "crossfire unlock --init" }),
      (e) => e.exitCode === 5 && why.test(e.message) && e.message.includes(lock) && e.message.includes(JSON.stringify(content.trim())) && /2 h 3 min old/.test(e.message) && e.message.includes("crossfire unlock --init"),
    );
    assert.equal(ran, false);
    assert.equal(fs.readFileSync(lock, "utf8"), content, "nothing took it over");
  }
});

test("AC-3: built, review and abandon refuse a loop lock left by a dead process and name crossfire unlock --slug", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  ageLoop(sb, "one", 4 * H);
  const lock = `${sb.repo}/.crossfire/runs/one/.lock`;
  fs.writeFileSync(lock, lockOf(DEAD_PID));
  const before = fs.readFileSync(stateFile(sb, "one"), "utf8");
  for (const cmd of ["built", "review", "abandon"]) {
    const r = sb.cf(cmd, "--slug", "one");
    assert.equal(r.status, 5, `${cmd}: ${r.stderr}`);
    assert.ok(r.stderr.includes(lock), r.stderr);
    assert.match(r.stderr, /crossfire unlock --slug one/);
  }
  assert.equal(fs.readFileSync(lock, "utf8"), lockOf(DEAD_PID));
  assert.equal(fs.readFileSync(stateFile(sb, "one"), "utf8"), before);
});

test("AC-3: init refuses an init lock left by a dead process and names crossfire unlock --init", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const lock = `${sb.repo}/.crossfire/runs/.init.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, lockOf(DEAD_PID));
  backdate(lock, 61 * 1000);
  const r = init(sb, "one");
  assert.equal(r.status, 5, r.stderr);
  assert.ok(r.stderr.includes(lock), r.stderr);
  assert.match(r.stderr, /crossfire unlock --init/);
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs/one`), "no loop was started");
  assert.equal(fs.readFileSync(lock, "utf8"), lockOf(DEAD_PID));
});

// ---- AC-3b: crossfire unlock ----

test("AC-3b: unlock removes a dead process's lock and prints what it removed; init and built work again", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const initLock = `${sb.repo}/.crossfire/runs/.init.lock`;
  fs.mkdirSync(path.dirname(initLock), { recursive: true });
  fs.writeFileSync(initLock, lockOf(DEAD_PID));
  let r = sb.cf("unlock", "--init");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`removed ${initLock}`), r.stdout);
  assert.ok(r.stdout.includes(`${DEAD_PID} ${os.hostname()}`), r.stdout);
  assert.ok(!fs.existsSync(initLock));
  r = init(sb, "one", "--json");
  assert.equal(r.status, 0, r.stderr);
  const resultFile = r.json().resultFile;
  const lock = `${sb.repo}/.crossfire/runs/one/.lock`;
  fs.writeFileSync(lock, lockOf(DEAD_PID));
  r = sb.cf("unlock", "--slug", "one");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`removed ${lock}`), r.stdout);
  assert.ok(!fs.existsSync(lock));
  assert.ok(!fs.existsSync(initLock), "the init lock it took to serialize unlocks is released");
  sb.build(resultFile);
  assert.equal(sb.cf("built", "--slug", "one").status, 0);
});

test("AC-3b: unlock refuses a live, another host's, an unparsable or a missing lock and changes nothing", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  const lock = `${sb.repo}/.crossfire/runs/one/.lock`;
  const initLock = `${sb.repo}/.crossfire/runs/.init.lock`;
  for (const [content, why] of [
    [lockOf(process.pid), /is running/],
    [lockOf(DEAD_PID, "another-host.example"), /another host/],
    ["12 ", /cannot be read/],
  ]) {
    for (const [file, args] of [[lock, ["--slug", "one"]], [initLock, ["--init"]]]) {
      fs.writeFileSync(file, content);
      const r = sb.cf("unlock", ...args);
      assert.notEqual(r.status, 0, r.stdout);
      assert.match(r.stderr, why);
      assert.match(r.stderr, /nothing was removed/);
      assert.equal(fs.readFileSync(file, "utf8"), content);
      fs.rmSync(file);
    }
  }
  let r = sb.cf("unlock", "--slug", "one");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no lock at .*nothing was removed/);
  r = sb.cf("unlock");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /crossfire unlock --slug <slug>/);
  r = sb.cf("unlock", "--slug", "one", "--init");
  assert.equal(r.status, 2);
});

test("AC-3b: unlockDead re-reads the lock and leaves a lock that changed after it was judged", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, lockOf(DEAD_PID));
  // Another unlock removed it and a live process took it between this unlock's look and its removal.
  const judged = readLock(lock);
  fs.rmSync(lock);
  fs.writeFileSync(lock, lockOf(process.pid));
  assert.throws(() => unlockDead(lock, judged), /changed .*nothing was removed/);
  assert.equal(fs.readFileSync(lock, "utf8"), lockOf(process.pid));
});

// ---- FM-3: two live processes never both hold a lock ----

test("FM-3: concurrent exclusive creates: exactly one of many processes wins", async (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  const script = `import { withFileLock } from "${LIB}/util.mjs";
    try { withFileLock(${JSON.stringify(lock)}, () => { console.log("WON"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); }); }
    catch (e) { console.log("REFUSED " + e.exitCode); }`;
  const results = await Promise.all(Array.from({ length: 8 }, () => child(script).done));
  const outs = results.map((r) => r.out.trim());
  assert.equal(outs.filter((o) => o === "WON").length, 1, outs.join("\n") + results.map((r) => r.err).join(""));
  assert.equal(outs.filter((o) => o === "REFUSED 5").length, 7, outs.join("\n"));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("FM-3: processes waiting on a live lock never overlap in their critical sections", async (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  const inside = path.join(dir, "inside");
  const script = `import fs from "node:fs"; import { withFileLock } from "${LIB}/util.mjs";
    for (let k = 0; k < 5; k++) withFileLock(${JSON.stringify(lock)}, () => {
      fs.writeFileSync(${JSON.stringify(inside)}, String(process.pid), { flag: "wx" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      fs.rmSync(${JSON.stringify(inside)});
    }, { waitMs: 20000 });`;
  const results = await Promise.all(Array.from({ length: 6 }, () => child(script).done));
  assert.ok(results.every((r) => r.status === 0), results.map((r) => r.err).join("\n"));
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ---- AC-5 / FM-4: abandon takes the loop lock ----

test("AC-5/FM-4: abandon refuses while a live command holds the loop lock, however long ago the last step was", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  ageLoop(sb, "one", 5 * H);
  const lock = `${sb.repo}/.crossfire/runs/one/.lock`;
  fs.writeFileSync(lock, lockOf(process.pid));
  backdate(lock, 5 * H);
  const before = fs.readFileSync(stateFile(sb, "one"), "utf8");
  const r = sb.cf("abandon", "--slug", "one");
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /another crossfire command is running for this loop/);
  assert.equal(fs.readFileSync(stateFile(sb, "one"), "utf8"), before);
  assert.doesNotMatch(init(sb, "two").stderr, /looks stuck/, "a live holder: it does not look stuck");
  fs.rmSync(lock);
  assert.match(init(sb, "two").stderr, /looks stuck/);
});

test("AC-5/FM-4: an abandon started while built runs its proof commands refuses; built records its result", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  let r = init(sb, "one", "--json");
  assert.equal(r.status, 0, r.stderr);
  const resultFile = r.json().resultFile;
  const side = path.join(sb.tmp, "side.log");
  const script = path.join(sb.tmp, "abandon-during-built.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs"; import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, "abandon", "--slug", "one"], { encoding: "utf8" });
fs.appendFileSync(${JSON.stringify(side)}, "abandon " + r.status + " " + r.stderr + "\\n");
`,
  );
  assert.equal(sb.cf("proof", "--slug", "one", "--e2e", `node ${script}`).status, 0);
  sb.build(resultFile);
  ageLoop(sb, "one", 5 * H); // the loop looks stuck by its steps alone
  r = sb.cf("built", "--slug", "one");
  const log = fs.readFileSync(side, "utf8");
  assert.match(log, /^abandon 5 .*another crossfire command is running for this loop/, log);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const st = readState(sb, "one");
  assert.notEqual(st.phase, "escalated");
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs/one/.lock`), "built released its lock");
});

// ---- AC-6: the init lock waits up to 10 seconds for a live holder ----

test("AC-6: init waits for a live init-lock holder that lets go, then starts the loop", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const lock = `${sb.repo}/.crossfire/runs/.init.lock`;
  const holder = child(`import { withFileLock } from "${LIB}/util.mjs";
    withFileLock(${JSON.stringify(lock)}, () => { console.log("HELD"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); });`);
  await new Promise((resolve) => holder.p.stdout.once("data", resolve));
  const started = Date.now();
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "init", "--slug", "one", "--spec", sb.spec, "--base", "main", "--breaker", "off"], { cwd: sb.repo, env: sb.env });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stderr }));
  });
  assert.equal((await holder.done).status, 0);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started >= 1000, "it waited");
  assert.ok(fs.existsSync(stateFile(sb, "one")));
});

test("AC-6: init refuses after 10 seconds while the init lock stays held by a live process, naming it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const lock = `${sb.repo}/.crossfire/runs/.init.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, lockOf(process.pid));
  const started = Date.now();
  const r = init(sb, "one");
  const took = Date.now() - started;
  assert.equal(r.status, 5, r.stderr);
  assert.ok(took >= 10_000 && took < 30_000, `waited ${took} ms`);
  assert.ok(r.stderr.includes(lock) && r.stderr.includes(`${process.pid} ${os.hostname()}`), r.stderr);
  assert.match(r.stderr, /crossfire unlock --init/);
  assert.equal(fs.readFileSync(lock, "utf8"), lockOf(process.pid));
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs/one`));
});

// ---- R2 / FM-5: memory, health and precedents without their own locks ----

test("R2/FM-5: precedent add, memory append and health record still work, and leave no lock files", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const script = `import { appendLessons } from "${LIB}/memory.mjs"; import { recordAttempt } from "${LIB}/health.mjs"; import { appendPrecedent } from "${LIB}/precedents.mjs";
    for (let k = 0; k < 3; k++) {
      appendLessons(process.cwd(), [{ date: "2026-01-01", severity: "HIGH", file: "a.js", lesson: "lesson " + k, source: "t" }]);
      recordAttempt("codex", { ok: true, at: "x", seconds: 1 });
      appendPrecedent(process.cwd(), "ruling " + k);
    }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: sb.repo, env: sb.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const dir = `${sb.repo}/.git/crossfire`;
  assert.equal(fs.readFileSync(`${dir}/memory.md`, "utf8").split("\n").filter((l) => l.startsWith("- ")).length, 3);
  assert.equal(fs.readFileSync(`${dir}/precedents.md`, "utf8").split("\n").filter((l) => l.startsWith("- ")).length, 3);
  assert.equal(JSON.parse(fs.readFileSync(`${sb.tmp}/state/reviewers.json`, "utf8")).codex.length, 3);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".lock")), []);
  assert.deepEqual(fs.readdirSync(`${sb.tmp}/state`).filter((f) => f.endsWith(".lock")), []);
  assert.equal(sb.cf("precedents").status, 0);
});

test("R2: the shared-file and takeover lock code is gone", () => {
  const read = (rel) => fs.readFileSync(path.join(LIB, rel), "utf8");
  for (const f of ["memory.mjs", "health.mjs", "precedents.mjs"]) assert.doesNotMatch(read(f), /withFileLock|\.lock`/, f);
  const util = read("util.mjs");
  assert.doesNotMatch(util, /takeover|staleMs|claimFile/);
  assert.doesNotMatch(read("store.mjs"), /LOCK_STALE_MS|mtimeMs/);
});

// ---- docs ----

test("docs: README, the loop skill and CHANGELOG 1.5.0 describe unlock (person-only) and best-effort shared files", () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const skill = read("plugins/crossfire/skills/loop/SKILL.md");
  assert.match(skill, /`crossfire unlock --slug <slug>` \(or `--init`\) only on the person's explicit words/);
  const readme = read("README.md");
  assert.match(readme, /crossfire unlock --slug <slug>/);
  assert.match(readme, /while its process is alive/);
  const entry = read("CHANGELOG.md").split("\n## ")[1];
  assert.match(entry, /^1\.5\.0\n/);
  assert.match(entry, /crossfire unlock/);
  assert.match(entry, /best effort/);
  assert.doesNotMatch(entry, /stale after 60|Shared files under a lock/);
  const usage = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout;
  assert.match(usage, /crossfire unlock \(--slug <slug> \| --init\)/);
});
