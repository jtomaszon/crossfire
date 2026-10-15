// Round-2 fix for F1 (codex, check pr for v150-lock-fixes): readHealth must normalize every
// optional field it keeps (error, seconds) to its expected type or drop it, not just validate
// `ok`/`at`. An entry with a malformed optional field must never survive into a consumer that
// interpolates it (doctor's `${h.lastError}`) or does arithmetic on it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandbox, approve, ROOT } from "./helpers.mjs";

const LIB = path.join(ROOT, "plugins", "crossfire", "scripts", "lib");
const { readHealth, recordAttempt, summarize } = await import(path.join(LIB, "health.mjs"));

const tmpdir = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cf-r2fix-"));

// ---- the rule: readHealth normalizes every optional field it keeps (error, seconds) to its
// expected type (string/number) or drops it, so a malformed value never survives ----

test("F1 variant 1 (reported case): an object-valued error with ok/at valid is dropped, not kept as an object", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reviewers.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      codex: [
        { ok: false, at: "2026-01-01T00:00:00.000Z", error: { toString: null } },
        { ok: false, at: "2026-01-02T00:00:00.000Z", error: { toString: null } },
      ],
    }),
  );
  const h = readHealth(file);
  assert.ok(h.codex.every((a) => !("error" in a) || typeof a.error === "string"), JSON.stringify(h));
  const s = summarize(h, "codex");
  assert.equal(s.lastError, null, "an object-valued error is dropped, never kept as an object");
  // The consumer doctor uses: template-interpolating it must never throw.
  assert.doesNotThrow(() => `${s.lastError}`);
});

test("F1 variant 2: an array-valued or numeric error is dropped the same way", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reviewers.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      grok: [
        { ok: false, at: "2026-01-01T00:00:00.000Z", error: ["bad"] },
        { ok: false, at: "2026-01-02T00:00:00.000Z", error: 42 },
      ],
    }),
  );
  const h = readHealth(file);
  for (const entry of h.grok) assert.ok(!("error" in entry), JSON.stringify(entry));
  assert.equal(summarize(h, "grok").lastError, null);
});

test("F1 variant 3: a non-finite or non-numeric seconds (object, NaN, Infinity, string) is dropped, never kept to be used in arithmetic", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reviewers.json");
  const bad = [{ toString: null }, "NaN", null];
  fs.writeFileSync(
    file,
    JSON.stringify({
      codex: [
        { ok: true, at: "t1", seconds: bad[0] },
        { ok: true, at: "t2", seconds: Number.NaN },
        { ok: true, at: "t3", seconds: Number.POSITIVE_INFINITY },
      ],
    }),
  );
  const h = readHealth(file);
  for (const entry of h.codex) {
    assert.ok(!("seconds" in entry) || (typeof entry.seconds === "number" && Number.isFinite(entry.seconds)), JSON.stringify(entry));
  }
});

test("F1: a valid string error and finite number seconds are kept unchanged", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reviewers.json");
  const good = { ok: false, at: "2026-01-01T00:00:00.000Z", seconds: 2.5, error: "boom" };
  fs.writeFileSync(file, JSON.stringify({ codex: [good] }));
  assert.deepEqual(readHealth(file), { codex: [good] });
});

test("F1: recordAttempt followed by readHealth still round-trips a legitimate error/seconds pair", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reviewers.json");
  recordAttempt("codex", { ok: false, at: "t", seconds: 3, error: "boom" }, file);
  const h = readHealth(file);
  assert.equal(h.codex.length, 1);
  assert.equal(h.codex[0].error, "boom");
  assert.equal(h.codex[0].seconds, 3);
});

// ---- end-to-end: doctor never throws with the reported malformed entries in the real health file ----

test("F1 e2e: doctor does not throw TypeError when the health file has object-valued errors", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const health = `${sb.tmp}/state/reviewers.json`;
  fs.mkdirSync(path.dirname(health), { recursive: true });
  fs.writeFileSync(
    health,
    JSON.stringify({
      codex: [
        { ok: false, at: "2026-01-01T00:00:00.000Z", error: { toString: null } },
        { ok: false, at: "2026-01-02T00:00:00.000Z", error: { toString: null } },
      ],
    }),
  );
  const r = sb.cf("doctor");
  assert.doesNotMatch(r.stderr, /TypeError|Cannot convert object to primitive value/, r.stderr);
});
