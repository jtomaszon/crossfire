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

test("G3 and G4 escalations: a re-flagged fix is reported as re-flagged, and the G4 finding is open", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("BLOCKER", "hole", "a.js", 10), f("BLOCKER", "leak", "b.js", 40)])], t);
  afterBuild(s, done([{ id: "F1", status: "FIXED", where: "a.js:10" }, { id: "F2", status: "FIXED", where: "b.js:40" }]), green, t);
  const next = afterReview(s, [codex([f("BLOCKER", "[F1] still a hole", "a.js", 10), f("CHANGES", "leak on retry", "b.js", 41)])], t);
  assert.ok(["G3", "G4"].includes(next.gate));
  const report = renderReport(s, { minutesElapsed: 2 });
  assert.match(report, /Claimed fixed, then re-flagged \(or flagged at the same place\) by a reviewer: F1 \(BLOCKER\), F2 \(BLOCKER\)/);
  assert.doesNotMatch(report, /not re-reviewed/);
  assert.match(report, /Still open: F3 \(CHANGES\)/);
  assert.match(report, /a\.js:10 \(fix: a\.js:10\)/);
});

test("breaker evidence counts the builder's answers; a dispute on an early stop is shown to the owner", () => {
  const s = fresh({ breaker: true, maxMinutes: 10 });
  afterBuild(s, done(), green, t);
  afterBreak(s, [attack("maybe a race"), attack("real hole", "b.js", 5)], t);
  const next = afterBuild(s, done([{ id: "B1", status: "DISPUTED", note: "lock covers it" }, { id: "B2", status: "FIXED", where: "b.js:5" }]), green, { at, minutesElapsed: 11 });
  assert.equal(next.gate, "G6");
  const report = renderReport(s, { minutesElapsed: 11 });
  assert.match(report, /the builder answered 1 FIXED and 1 DISPUTED; 0 of these answers went through a later review pass, 2 did not/);
  assert.match(report, /Claimed fixed by the builder, not re-reviewed: B2 \(BLOCKER\)/);
  assert.match(report, /Disputed by the builder, not settled by a reviewer: B1 \(BLOCKER\)/);
  assert.doesNotMatch(report, /hardened/);
});


test("two reviewers tag different earlier findings at the same place: both are re-flagged (G3)", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("BLOCKER", "a", "a.js", 10), f("BLOCKER", "b", "a.js", 12)])], t);
  afterBuild(s, done([{ id: "F1", status: "FIXED", where: "a.js:10" }, { id: "F2", status: "FIXED", where: "a.js:12" }]), green, t);
  const grok = { reviewer: "grok", ok: true, verdict: "needs-attention", summary: "s", findings: [f("BLOCKER", "[F2] still b", "a.js", 11)] };
  afterReview(s, [codex([f("BLOCKER", "[F1] still a", "a.js", 11)]), grok], t);
  assert.ok(s.history.some((h) => /F1 re-flagged/.test(h.detail ?? "")) || s.terminal.reason.includes("F1"));
  assert.equal(s.ledger.find((e) => e.id === "F2").status, "claimed_fixed", "F2 is not closed");
  assert.equal(s.ledger.find((e) => e.id === "F1").status, "claimed_fixed");
});

test("one finding at the place of two claimed fixes: neither is closed, G4 names both", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("BLOCKER", "a", "a.js", 10), f("CHANGES", "b", "a.js", 12)])], t);
  afterBuild(s, done([{ id: "F1", status: "FIXED", where: "a.js:10" }, { id: "F2", status: "FIXED", where: "a.js:12" }]), green, t);
  const next = afterReview(s, [codex([f("BLOCKER", "new at 11", "a.js", 11)])], t);
  assert.equal(next.gate, "G4");
  assert.deepEqual(s.ledger.filter((e) => e.status === "closed").map((e) => e.id), []);
  const report = renderReport(s, { minutesElapsed: 2 });
  assert.match(report, /F1 \(BLOCKER\), F2 \(CHANGES\)/);
});

test("breaker coverage is counted per answer across rounds", () => {
  const s = fresh({ breaker: true, maxMinutes: 10 });
  afterBuild(s, done(), green, t);
  afterBreak(s, [attack("first", "a.js", 10)], t);
  afterBuild(s, done([{ id: "B1", status: "FIXED", where: "a.js:10" }]), green, t);
  afterReview(s, [codex([f("CHANGES", "elsewhere", "z.js", 90)])], t);
  afterBuild(s, done([{ id: "F1", status: "FIXED", where: "z.js:90" }]), green, t);
  afterBreak(s, [attack("second", "b.js", 5)], t);
  const next = afterBuild(s, done([{ id: "B2", status: "FIXED", where: "b.js:5" }]), green, { at, minutesElapsed: 11 });
  assert.equal(next.gate, "G6");
  const report = renderReport(s, { minutesElapsed: 11 });
  assert.match(report, /1 of these answers went through a later review pass, 1 did not/);
});

test("a claimed fix from a loop started before 1.1.0 (no claimedPass) is listed as not re-reviewed", () => {
  const s = fresh();
  s.ledger.push({ id: "F1", source: "review", severity: "BLOCKER", title: "x", file: "a.js", lineStart: 1, lineEnd: 1, reviewers: ["codex"], status: "claimed_fixed", claimedRound: 2, history: [{ builder: "FIXED" }] });
  s.terminal = { kind: "escalated", gate: "G1", reason: "reviewer failed twice" };
  assert.match(renderReport(s, { minutesElapsed: 5 }), /not re-reviewed: F1 \(BLOCKER\)/);
});

test("closed on pass 2, re-flagged on pass 3: reopened, the reviewer's words reach the owner", () => {
  const s2 = fresh();
  afterBuild(s2, done(), green, t);
  afterReview(s2, [codex([f("BLOCKER", "hole", "a.js", 10), f("CHANGES", "style", "z.js", 80)])], t);
  afterBuild(s2, done([{ id: "F1", status: "FIXED", where: "a.js:10" }, { id: "F2", status: "FIXED", where: "z.js:80" }]), green, t);
  afterReview(s2, [codex([f("CHANGES", "z still off", "z.js", 200)])], t);
  assert.equal(s2.ledger.find((e) => e.id === "F1").status, "closed");
  afterBuild(s2, done([{ id: "F3", status: "FIXED", where: "z.js:200" }]), green, t);
  const next = afterReview(s2, [codex([f("BLOCKER", "[F1] hole is back via retry", "a.js", 10)])], t);
  assert.equal(next.gate, "G3");
  assert.match(s2.terminal.reason, /hole is back via retry/);
  assert.equal(s2.ledger.find((e) => e.id === "F1").status, "open");
  const report = renderReport(s2, { minutesElapsed: 3 });
  assert.match(report, /re-flagged \(or flagged at the same place\) by a reviewer: F1/);
  assert.match(report, /F1 re-flagged as: \[F1\] hole is back via retry/);
  assert.doesNotMatch(report, /Nothing else is open/);
});

test("a merged finding holds claimed fixes at every reviewer's location", () => {
  const s = fresh();
  afterBuild(s, done(), green, t);
  afterReview(s, [codex([f("BLOCKER", "a", "a.js", 10), f("BLOCKER", "b", "a.js", 16)])], t);
  afterBuild(s, done([{ id: "F1", status: "FIXED", where: "a.js:10" }, { id: "F2", status: "FIXED", where: "a.js:16" }]), green, t);
  const grok = { reviewer: "grok", ok: true, verdict: "needs-attention", summary: "s", findings: [f("BLOCKER", "near b", "a.js", 13)] };
  afterReview(s, [codex([f("BLOCKER", "[F1] a again", "a.js", 10)]), grok], t);
  assert.notEqual(s.ledger.find((e) => e.id === "F2").status, "closed", "F2 is not accepted");
});

test("a breaker answer changed after a review is not counted as reviewed", () => {
  const s = fresh({ breaker: true, maxMinutes: 10 });
  afterBuild(s, done(), green, t);
  afterBreak(s, [attack("first", "a.js", 10)], t);
  afterBuild(s, done([{ id: "B1", status: "FIXED", where: "a.js:10" }]), green, t);
  afterReview(s, [codex([f("CHANGES", "near the attack", "a.js", 11)])], t);
  assert.equal(s.ledger.find((e) => e.id === "B1").status, "claimed_fixed", "held at a finding's place");
  const next = afterBuild(s, done([{ id: "F1", status: "FIXED", where: "a.js:11" }, { id: "B1", status: "DISPUTED", note: "changed my mind" }]), green, { at, minutesElapsed: 11 });
  assert.equal(next.gate, "G6");
  assert.match(renderReport(s, { minutesElapsed: 11 }), /0 of these answers went through a later review pass, 1 did not/);
});
