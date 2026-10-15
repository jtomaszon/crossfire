// 1.5.0 lock-review fixes: one unlock at a time (an exclusive unlock marker), locks created with their
// contents already in them, and reviewer health that stays advisory however malformed its file is.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sandbox, approve, gitc, ROOT } from "./helpers.mjs";

const LIB = path.join(ROOT, "plugins", "crossfire", "scripts", "lib");
const { tryCreate, readLock, unlockDead } = await import(path.join(LIB, "util.mjs"));
const { readHealth, recordAttempt, summarize, autoSkip } = await import(path.join(LIB, "health.mjs"));

const DEAD_PID = 2147483646; // no such process
const tmpdir = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cf-lockfix-"));
const lockOf = (pid, host = os.hostname()) => `${pid} ${host}\n2026-01-01T00:00:00.000Z\n`;
const backdate = (file, ms) => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
};
const init = (sb, slug, ...extra) => sb.cf("init", "--slug", slug, "--spec", sb.spec, "--base", "main", "--breaker", "off", ...extra);
const paths = (sb) => ({
  runs: `${sb.repo}/.crossfire/runs`,
  marker: `${sb.repo}/.crossfire/runs/.unlock.lock`,
  initLock: `${sb.repo}/.crossfire/runs/.init.lock`,
  loopLock: (slug) => `${sb.repo}/.crossfire/runs/${slug}/.lock`,
});

// ---- AC-1 / FM-1: one unlock at a time ----

test("AC-1/FM-1: while another unlock holds the unlock marker, unlock (--slug and --init) refuses and changes nothing", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  const p = paths(sb);
  fs.writeFileSync(p.marker, lockOf(process.pid)); // a running unlock
  fs.writeFileSync(p.initLock, lockOf(DEAD_PID));
  fs.writeFileSync(p.loopLock("one"), lockOf(DEAD_PID));
  for (const args of [["--slug", "one"], ["--init"]]) {
    const r = sb.cf("unlock", ...args);
    assert.notEqual(r.status, 0, r.stdout);
    assert.ok(r.stderr.includes(p.marker), r.stderr);
    assert.match(r.stderr, /another crossfire unlock/);
    assert.match(r.stderr, /nothing was removed/);
  }
  assert.equal(fs.readFileSync(p.marker, "utf8"), lockOf(process.pid), "the marker is left alone");
  assert.equal(fs.readFileSync(p.initLock, "utf8"), lockOf(DEAD_PID));
  assert.equal(fs.readFileSync(p.loopLock("one"), "utf8"), lockOf(DEAD_PID));
});

test("AC-1/FM-1: with no marker, a single unlock removes a dead lock, leaves a live one, and removes its own marker", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  const p = paths(sb);
  fs.writeFileSync(p.loopLock("one"), lockOf(DEAD_PID));
  let r = sb.cf("unlock", "--slug", "one");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(p.loopLock("one")));
  assert.ok(!fs.existsSync(p.marker), "its marker is removed");
  fs.writeFileSync(p.initLock, lockOf(process.pid));
  r = sb.cf("unlock", "--init");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is running.*nothing was removed/s);
  assert.equal(fs.readFileSync(p.initLock, "utf8"), lockOf(process.pid), "a live lock stays");
  assert.ok(!fs.existsSync(p.marker), "its marker is removed when it refuses too");
});

test("AC-1/FM-1: unlock no longer needs the init lock to remove a loop's dead lock", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  const p = paths(sb);
  fs.writeFileSync(p.initLock, lockOf(process.pid)); // an init running right now
  fs.writeFileSync(p.loopLock("one"), lockOf(DEAD_PID));
  const r = sb.cf("unlock", "--slug", "one");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(p.loopLock("one")));
  assert.equal(fs.readFileSync(p.initLock, "utf8"), lockOf(process.pid));
});

test("AC-1/FM-1: many unlocks at once on one dead lock: exactly one removes it, the others refuse, and no marker is left", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const p = paths(sb);
  fs.mkdirSync(p.runs, { recursive: true });
  fs.writeFileSync(p.initLock, lockOf(DEAD_PID));
  const results = await Promise.all(
    Array.from({ length: 6 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, "plugins", "crossfire", "scripts", "crossfire.mjs"), "unlock", "--init"], { cwd: sb.repo, env: sb.env });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (status) => resolve({ status, out }));
    })),
  );
  assert.equal(results.filter((r) => r.status === 0).length, 1, JSON.stringify(results));
  assert.ok(!fs.existsSync(p.initLock));
  assert.ok(!fs.existsSync(p.marker));
});

// ---- AC-1b / FM-4: a crashed unlock's marker ----

test("AC-1b/FM-4: a marker left by a crashed unlock is refused, naming the marker, its process and age; nothing clears it", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  const p = paths(sb);
  fs.writeFileSync(p.marker, lockOf(DEAD_PID));
  backdate(p.marker, 3 * 3600 * 1000 + 5 * 60 * 1000);
  fs.writeFileSync(p.loopLock("one"), lockOf(DEAD_PID));
  fs.writeFileSync(p.initLock, lockOf(DEAD_PID));
  for (const args of [["--slug", "one"], ["--init"]]) {
    const r = sb.cf("unlock", ...args);
    assert.notEqual(r.status, 0, r.stdout);
    assert.ok(r.stderr.includes(p.marker), r.stderr);
    assert.match(r.stderr, new RegExp(`process ${DEAD_PID} on this host is gone`));
    assert.match(r.stderr, /3 h 5 min old/);
    assert.match(r.stderr, /if no crossfire unlock is running, a person can delete/i);
  }
  assert.equal(fs.readFileSync(p.marker, "utf8"), lockOf(DEAD_PID), "no automatic clearing");
  assert.equal(fs.readFileSync(p.loopLock("one"), "utf8"), lockOf(DEAD_PID));
  assert.equal(fs.readFileSync(p.initLock, "utf8"), lockOf(DEAD_PID));
});

// ---- FM-3: unparsable locks ----

test("FM-3: unlock removes an unparsable lock older than 60 seconds and refuses a younger one", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  const p = paths(sb);
  for (const content of ["", "garbage"]) {
    for (const [file, args] of [[p.loopLock("one"), ["--slug", "one"]], [p.initLock, ["--init"]]]) {
      fs.writeFileSync(file, content);
      backdate(file, 30 * 1000);
      let r = sb.cf("unlock", ...args);
      assert.notEqual(r.status, 0, r.stdout);
      assert.match(r.stderr, /cannot be read.*nothing was removed/s);
      assert.equal(fs.readFileSync(file, "utf8"), content);
      backdate(file, 61 * 1000);
      r = sb.cf("unlock", ...args);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(`removed ${file}`), r.stdout);
      assert.ok(!fs.existsSync(file));
      assert.ok(!fs.existsSync(p.marker));
    }
  }
});

test("FM-3: unlockDead removes an old unparsable lock only while its contents are what it judged", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  fs.writeFileSync(lock, "");
  backdate(lock, 120 * 1000);
  const judged = readLock(lock);
  fs.writeFileSync(lock, lockOf(process.pid));
  assert.throws(() => unlockDead(lock, judged), /changed .*nothing was removed/);
  assert.equal(fs.readFileSync(lock, "utf8"), lockOf(process.pid));
});

// ---- AC-4 / FM-3: a lock is never visible without its contents ----

test("AC-4: tryCreate creates the file with its contents, refuses an existing one, and leaves no temporary file", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "x.lock");
  assert.equal(tryCreate(file, "one"), true);
  assert.equal(fs.readFileSync(file, "utf8"), "one");
  assert.equal(tryCreate(file, "two"), false);
  assert.equal(fs.readFileSync(file, "utf8"), "one");
  assert.deepEqual(fs.readdirSync(dir), ["x.lock"]);
  assert.throws(() => tryCreate(path.join(dir, "missing-dir", "y.lock"), "x"), /ENOENT/, "an error other than an existing file is not a held lock");
});

test("AC-4: the lock helpers and watch share one tryCreate (temporary file, then link)", () => {
  const util = fs.readFileSync(path.join(LIB, "util.mjs"), "utf8");
  const watch = fs.readFileSync(path.join(LIB, "watch.mjs"), "utf8");
  assert.match(util, /export function tryCreate\(/);
  assert.match(util, /fs\.linkSync\(/);
  assert.doesNotMatch(util, /"wx"/, "no lock is opened empty and written afterwards");
  assert.doesNotMatch(watch, /fs\.linkSync\(/, "watch reuses the shared helper");
  assert.match(watch, /tryCreate[^\n]*from "\.\/util\.mjs"/);
});

test("AC-4/FM-3: no lock or marker is ever observed without its contents while many processes take and release it", async (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  const stop = path.join(dir, "stop");
  const worker = `import { withFileLock } from "${LIB}/util.mjs";
    for (let k = 0; k < 40; k++) { try { withFileLock(${JSON.stringify(lock)}, () => {}); } catch {} }`;
  const watcher = `import fs from "node:fs"; let seen = 0, empty = 0;
    while (!fs.existsSync(${JSON.stringify(stop)})) {
      try { const s = fs.readFileSync(${JSON.stringify(lock)}, "utf8"); seen++; if (!/^\\d+ \\S+\\n/.test(s)) empty++; } catch {}
    }
    console.log(JSON.stringify({ seen, empty }));`;
  const run = (script) => new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script]);
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (status) => resolve({ status, out, err }));
  });
  const watching = run(watcher);
  const workers = await Promise.all(Array.from({ length: 4 }, () => run(worker)));
  fs.writeFileSync(stop, "");
  const w = await watching;
  assert.ok(workers.every((r) => r.status === 0), workers.map((r) => r.err).join("\n"));
  const { seen, empty } = JSON.parse(w.out);
  assert.equal(empty, 0, `observed ${empty} of ${seen} reads without contents`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["stop"], "no lock or temporary file is left");
});

// ---- AC-2 / FM-2: malformed reviewer health stays advisory ----

const MALFORMED = ["null", '{"grok":{}}', '{"grok":[null]}', '{"codex":{}}', '[1,2]', '"x"', '{"grok":[{"ok":"no","at":1},{"ok":false}]}'];

test("AC-2: readHealth drops anything that is not reviewer -> array of { ok: boolean, at: string }", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reviewers.json");
  for (const text of MALFORMED) {
    fs.writeFileSync(file, text);
    const h = readHealth(file);
    assert.equal(typeof h, "object", text);
    assert.ok(h && !Array.isArray(h), text);
    for (const r of ["grok", "codex"]) {
      assert.equal(summarize(h, r).attempts, 0, text);
      assert.equal(autoSkip(h, r), null, text);
    }
  }
  const good = { ok: false, at: "2026-01-01T00:00:00.000Z", seconds: 1, error: "e" };
  fs.writeFileSync(file, JSON.stringify({ grok: [null, 3, good, { ok: true }, { ok: true, at: "t" }], codex: "x", other: [good] }));
  assert.deepEqual(readHealth(file), { grok: [good, { ok: true, at: "t" }], other: [good] });
  fs.writeFileSync(file, '{"__proto__":[{"ok":true,"at":"t"}]}');
  assert.equal(Object.getPrototypeOf(readHealth(file)), Object.prototype, "a __proto__ key never sets the prototype");
});

test("AC-2: recordAttempt never throws over a malformed health file and writes a valid one", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reviewers.json");
  for (const text of MALFORMED) {
    fs.writeFileSync(file, text);
    recordAttempt("codex", { ok: true, at: "t1", seconds: 1 }, file);
    recordAttempt("grok", { ok: false, at: "t2", seconds: 1, error: "x" }, file);
    const h = readHealth(file);
    assert.equal(summarize(h, "codex").attempts, 1, text);
    assert.equal(summarize(h, "grok").consecutiveFailures, 1, text);
  }
  // A health path that cannot be written (its parent is a file) is advisory too.
  fs.writeFileSync(path.join(dir, "blocker"), "");
  assert.doesNotThrow(() => recordAttempt("codex", { ok: true, at: "t", seconds: 1 }, path.join(dir, "blocker", "reviewers.json")));
});

test("FM-2: malformed health never aborts doctor, check, spec-review, or a loop review with Grok on auto", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const health = `${sb.tmp}/state/reviewers.json`;
  fs.mkdirSync(path.dirname(health), { recursive: true });
  const spec = sb.cf("spec", "--slug", "demo", "--json").json();
  fs.writeFileSync(spec.specFile, fs.readFileSync(sb.spec, "utf8"));
  const doctorStatus = sb.cf("doctor").status;
  let n = 0;
  for (const text of ["null", '{"grok":{}}', '{"grok":[null]}', '{"codex":{}}']) {
    n += 1;
    const clean = (r, what) => {
      assert.doesNotMatch(r.stderr, /TypeError|is not iterable|Cannot read prop|is not a function/, `${what} with ${text}: ${r.stderr}`);
    };
    fs.writeFileSync(health, text);
    let r = sb.cf("doctor");
    clean(r, "doctor");
    assert.equal(r.status, doctorStatus, `doctor with ${text}: ${r.stderr}${r.stdout}`);

    fs.writeFileSync(health, text);
    fs.writeFileSync(`${sb.repo}/app.txt`, `health ${n}\n`);
    gitc(sb.repo, "commit", "-qam", `change ${n}`);
    sb.queue("codex", approve);
    sb.queue("grok", approve);
    r = sb.cf("check", "--base", "main", "--name", `c${n}`);
    clean(r, "check");
    assert.equal(r.status, 0, `check with ${text}: ${r.stderr}`);

    fs.writeFileSync(health, text);
    sb.queue("codex", approve);
    sb.queue("grok", approve);
    r = sb.cf("spec-review", "--slug", "demo", "--spec", spec.specFile, "--base", "main");
    clean(r, "spec-review");
    assert.equal(r.status, 0, `spec-review with ${text}: ${r.stderr}`);

    fs.writeFileSync(health, text);
    const slug = `loop${n}`;
    r = sb.cf("init", "--slug", slug, "--spec", sb.spec, "--base", "main", "--breaker", "off", "--grok", "auto", "--json");
    assert.equal(r.status, 0, r.stderr);
    sb.build(r.json().resultFile);
    assert.equal(sb.cf("built", "--slug", slug).status, 0);
    fs.writeFileSync(health, text);
    sb.queue("codex", approve);
    sb.queue("grok", approve);
    r = sb.cf("review", "--slug", slug);
    clean(r, "review");
    assert.equal(r.status, 0, `review with ${text}: ${r.stderr}`);
    assert.match(r.stdout, /NEXT ACTION: SHIP/);
  }
});
