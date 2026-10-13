import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, afterBuild, afterReview, mergeFindings, newState, noteMalformed, severityOf } from "../plugins/crossfire/scripts/lib/referee.mjs";

const at = "2026-10-09T00:00:00.000Z";
const t = { at, minutesElapsed: 1 };
const green = { passed: true, failures: [] };
const red = { passed: false, failures: [{ command: "make e2e", status: 1, output: "boom" }] };
const done = (fixes = []) => ({ status: "DONE", summary: "ok", fixes });

function f(severity, title, file = "a.js", line = 10) {
  return { severity, title, body: "b", file, lineStart: line, lineEnd: line, recommendation: "" };
}
const codex = (findings, verdict = findings.length ? "needs-attention" : "approve") => ({ reviewer: "codex", ok: true, verdict, summary: "s", findings });

function fresh(over = {}) {
  return newState({ slug: "x", repo: "/r", spec: "/s.md", base: "main", baseSha: "abc", startedAt: at, breaker: false, ...over });
}

test("severity maps the shared review schema onto three levels", () => {
  assert.equal(severityOf("critical"), "BLOCKER");
  assert.equal(severityOf("high"), "BLOCKER");
  assert.equal(severityOf("medium"), "CHANGES");
  assert.equal(severityOf("low"), "NIT");
  assert.equal(severityOf("weird"), "NIT");
});

test("a clean first review ships", () => {
  const s = fresh();
  assert.equal(afterBuild(s, done(), green, t).action, ACTIONS.RUN_REVIEW);
  const next = afterReview(s, [codex([])], t);
  assert.equal(next.action, ACTIONS.SHIP);
  assert.equal(s.phase, "shipped");
});

test("findings go back to the builder, a claimed fix that is not re-flagged closes, then ship", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  let next = afterReview(s, [codex([f("BLOCKER", "race")])], t);
  assert.equal(next.action, ACTIONS.SEND_BUILDER);
  assert.equal(next.brief, "fix");
  assert.equal(s.round, 2);
  assert.equal(s.ledger[0].id, "F1");
  assert.equal(afterBuild(s, done([{ id: "F1", status: "FIXED" }]), green, t).action, ACTIONS.RUN_REVIEW);
  next = afterReview(s, [codex([])], t);
  assert.equal(next.action, ACTIONS.SHIP);
  assert.equal(s.ledger[0].status, "closed");
});

test("G7: nits get one pass and ship without another review", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  const next = afterReview(s, [codex([f("NIT", "naming")], "approve")], t);
  assert.equal(next.brief, "nits");
  assert.equal(s.phase, "nit-build");
  assert.equal(afterBuild(s, done([{ id: "F1", status: "WONTFIX", note: "fine" }]), green, t).action, ACTIONS.SHIP);
});

test("G0: red proof commands send the builder back and burn a round", () => {
  const s = fresh();
  const next = afterBuild(s, done(), red, t);
  assert.equal(next.action, ACTIONS.SEND_BUILDER);
  assert.equal(next.brief, "g0");
  assert.equal(next.failures[0].command, "make e2e");
  assert.equal(s.round, 2);
});

test("G2: G0 still red at the round cap escalates", () => {
  const s = fresh({ maxRounds: 2 });
  afterBuild(s, done(), red, t);
  const next = afterBuild(s, done(), red, t);
  assert.equal(next.action, ACTIONS.ESCALATE);
  assert.equal(next.gate, "G2");
});

test("G2: findings still open at the round cap escalate", () => {
  const s = fresh({ maxRounds: 1 });
  afterBuild(s, done(), green, t);
  const next = afterReview(s, [codex([f("CHANGES", "missing check")])], t);
  assert.equal(next.gate, "G2");
});

test("G3: a finding re-flagged with its tag after a claimed fix escalates", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("BLOCKER", "race")])], t);
  afterBuild(s, done([{ id: "F1", status: "FIXED" }]), green, t);
  const next = afterReview(s, [codex([f("BLOCKER", "[F1] still racy", "b.js", 99)])], t);
  assert.equal(next.gate, "G3");
});

test("G3: the builder disputing a non-nit escalates to the owner", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("CHANGES", "rename")])], t);
  const next = afterBuild(s, done([{ id: "F1", status: "DISPUTED", note: "spec says so" }]), green, t);
  assert.equal(next.gate, "G3");
  assert.match(next.reason, /spec says so/);
});

test("G4: a new finding at the place of a claimed fix escalates", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("CHANGES", "unchecked input", "a.js", 10)])], t);
  afterBuild(s, done([{ id: "F1", status: "FIXED" }]), green, t);
  const next = afterReview(s, [codex([f("CHANGES", "input still unchecked differently", "a.js", 12)])], t);
  assert.equal(next.gate, "G4");
});

test("G5: a brand-new blocker at review pass 2 escalates", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("CHANGES", "one", "a.js", 1)])], t);
  afterBuild(s, done([{ id: "F1", status: "FIXED" }]), green, t);
  const next = afterReview(s, [codex([f("BLOCKER", "new hole", "z.js", 500)])], t);
  assert.equal(next.gate, "G5");
});

test("G6: the wall-clock budget escalates", () => {
  const s = fresh({ maxMinutes: 10 });
  const next = afterBuild(s, done(), green, { at, minutesElapsed: 11 });
  assert.equal(next.gate, "G6");
});

test("G1: a second malformed input for the same step escalates", () => {
  const s = fresh();
  assert.equal(noteMalformed(s, "build-r1-initial", "no file", at), null);
  assert.equal(noteMalformed(s, "build-r1-initial", "no file", at).gate, "G1");
});

test("a builder that reports PARTIAL stops the loop", () => {
  const s = fresh();
  const next = afterBuild(s, { status: "PARTIAL", summary: "blocked on creds", fixes: [] }, green, t);
  assert.equal(next.action, ACTIONS.ESCALATE);
  assert.equal(next.gate, "BUILDER");
});

test("needs-attention with no itemised findings still blocks shipping", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  const next = afterReview(s, [codex([], "needs-attention")], t);
  assert.equal(next.action, ACTIONS.SEND_BUILDER);
  assert.equal(s.ledger[0].severity, "CHANGES");
});

test("two reviewers flagging the same place count once, with both names", () => {
  const merged = mergeFindings([
    { reviewer: "codex", ok: true, findings: [f("BLOCKER", "race", "a.js", 10)] },
    { reviewer: "grok", ok: true, findings: [f("BLOCKER", "data race", "a.js", 11), f("NIT", "typo", "c.js", 1)] },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].reviewers, ["codex", "grok"]);
});

test("the stricter reviewer wins: grok's blocker blocks even when codex approves", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  const next = afterReview(s, [codex([]), { reviewer: "grok", ok: true, verdict: "needs-attention", summary: "", findings: [f("BLOCKER", "auth bypass")] }], t);
  assert.equal(next.action, ACTIONS.SEND_BUILDER);
  assert.deepEqual(s.ledger[0].reviewers, ["grok"]);
});

import { afterBreak } from "../plugins/crossfire/scripts/lib/referee.mjs";
const attack = (title, file = "a.js", line = 10, severity = "BLOCKER") => ({ title, scenario: "s", rule: "r", test: "t", severity, file, lineStart: line, lineEnd: line });

test("breaker: green build goes to the breaker first; no proven attack goes straight to review", () => {
  const s = fresh({ breaker: true });
  assert.equal(afterBuild(s, done(), green, t).action, ACTIONS.SEND_BREAKER);
  assert.equal(afterBreak(s, [], t).action, ACTIONS.RUN_REVIEW);
});

test("breaker: proven attacks get one harden leg (no round spent), then review without a second breaker pass", () => {
  const s = fresh({ breaker: true });
  afterBuild(s, done(), green, t);
  const next = afterBreak(s, [attack("nested rollback loses the flag")], t);
  assert.equal(next.action, ACTIONS.SEND_BUILDER);
  assert.equal(next.brief, "harden");
  assert.equal(s.round, 1, "harden does not use up a round");
  assert.equal(s.ledger[0].id, "B1");
  assert.equal(afterBuild(s, done([{ id: "B1", status: "FIXED" }]), green, t).action, ACTIONS.RUN_REVIEW);
});

test("breaker: a disputed attack never escalates; it goes to the reviewers to judge", () => {
  const s = fresh({ breaker: true });
  afterBuild(s, done(), green, t);
  afterBreak(s, [attack("maybe a race")], t);
  const next = afterBuild(s, done([{ id: "B1", status: "DISPUTED", note: "the lock covers it" }]), green, t);
  assert.equal(next.action, ACTIONS.RUN_REVIEW);
  assert.equal(s.ledger[0].status, "disputed_internal");
});

test("first review pass outcome is recorded (the number to watch)", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([])], t);
  assert.deepEqual(s.firstPass, { approved: true, findings: 0 });
  const s2 = fresh();
  afterBuild(s2, done(), green, t);
  afterReview(s2, [codex([f("CHANGES", "x")])], t);
  assert.deepEqual(s2.firstPass, { approved: false, findings: 1 });
});

import { renderReport } from "../plugins/crossfire/scripts/lib/report.mjs";

test("G6 right after the breaker: its proven attacks are in the ledger and the escalation report", () => {
  const s = fresh({ breaker: true, maxMinutes: 10 });
  afterBuild(s, done(), green, t);
  const next = afterBreak(s, [attack("nested rollback loses the flag")], { at, minutesElapsed: 11 });
  assert.equal(next.gate, "G6");
  assert.equal(s.ledger[0].id, "B1");
  const report = renderReport(s, { minutesElapsed: 11 });
  assert.match(report, /Still open: B1 \(BLOCKER\)/);
  assert.doesNotMatch(report, /Nothing else is open/);
});

test("an escalation report lists findings the builder claimed fixed that no reviewer re-checked", () => {
  const s = fresh({ maxMinutes: 10 });
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("BLOCKER", "hole")])], t);
  const next = afterBuild(s, done([{ id: "F1", status: "FIXED", where: "a.js:10" }]), green, { at, minutesElapsed: 11 });
  assert.equal(next.gate, "G6");
  const report = renderReport(s, { minutesElapsed: 11 });
  assert.match(report, /Claimed fixed by the builder, not re-reviewed: F1 \(BLOCKER\)/);
});
