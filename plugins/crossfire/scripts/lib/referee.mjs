// The referee: pure decision logic for the build -> review -> fix loop.
// No I/O here. The CLI gathers facts (builder result, test runs, reviews),
// calls these functions, and persists the state they return.
//
// Gates (from JARVIS, the author's earlier private builder-reviewer loop; the lessons
// behind each are in CHANGELOG.md):
//   G0  proof        the declared E2E and invariant commands must pass before any review
//   G1  malformed    one re-ask for a malformed builder result or reviewer output, then escalate
//   G2  round cap    at most maxRounds builder legs (initial build included) before escalating
//   G3  convergence  a finding re-flagged after a claimed fix, or a disputed non-nit, escalates
//   G4  suspect      a new finding at the same place as a claimed fix escalates
//   G5  regression   a new blocker at review pass 2 or later escalates
//   G6  budget       wall-clock budget (maxMinutes)
//   G7  nits         nits get one fix pass, then ship without another review
// Before each review pass, an internal breaker (a cold subagent) tries to break the
// change and proves each attack with a failing test; proven attacks get one harden
// leg before the reviewers see the branch. The breaker never escalates on its own.
// Blockers never downgrade, and anything ambiguous escalates instead of looping.

export const ACTIONS = Object.freeze({
  SEND_BUILDER: "SEND_BUILDER",
  SEND_BREAKER: "SEND_BREAKER",
  RUN_REVIEW: "RUN_REVIEW",
  SHIP: "SHIP",
  ESCALATE: "ESCALATE",
});

export const SEVERITY = Object.freeze({ BLOCKER: "BLOCKER", CHANGES: "CHANGES", NIT: "NIT" });

const SEVERITY_RANK = { NIT: 1, CHANGES: 2, BLOCKER: 3 };

/** Map the shared Codex/Grok review schema severities onto crossfire's three levels. */
export function severityOf(reviewerSeverity) {
  switch (String(reviewerSeverity).toLowerCase()) {
    case "critical":
    case "high":
      return SEVERITY.BLOCKER;
    case "medium":
      return SEVERITY.CHANGES;
    default:
      return SEVERITY.NIT;
  }
}

export function newState({ slug, repo, spec, base, baseSha, e2e = [], invariants = [], maxRounds = 5, maxMinutes = 45, grok = "auto", breaker = true, startedAt }) {
  return {
    version: 1,
    slug,
    repo,
    spec,
    base,
    baseSha,
    e2e,
    invariants,
    maxRounds,
    maxMinutes,
    grok,
    breaker,
    startedAt,
    breakerRounds: [],
    phase: "build",
    round: 1,
    reviewPass: 0,
    nitPassDone: false,
    malformed: {},
    ledger: [],
    history: [],
    next: { action: ACTIONS.SEND_BUILDER, brief: "initial", round: 1 },
    terminal: null,
  };
}

export function isTerminal(state) {
  return state.phase === "shipped" || state.phase === "escalated";
}

function log(state, at, event, detail = "") {
  state.history.push({ at, event, detail });
}

function escalate(state, at, gate, reason) {
  state.phase = "escalated";
  state.terminal = { kind: "escalated", gate, reason, at };
  state.next = { action: ACTIONS.ESCALATE, gate, reason };
  log(state, at, `escalate:${gate}`, reason);
  return state.next;
}

function ship(state, at, reason) {
  state.phase = "shipped";
  state.terminal = { kind: "shipped", reason, at };
  state.next = { action: ACTIONS.SHIP, reason };
  log(state, at, "ship", reason);
  return state.next;
}

function sendBuilder(state, at, brief, extra = {}) {
  state.next = { action: ACTIONS.SEND_BUILDER, brief, round: state.round, ...extra };
  log(state, at, `send-builder:${brief}`, `round ${state.round}`);
  return state.next;
}

export function openItems(state, minSeverity = SEVERITY.NIT) {
  return state.ledger.filter((e) => e.status === "open" && SEVERITY_RANK[e.severity] >= SEVERITY_RANK[minSeverity]);
}

export function openAboveNit(state) {
  return openItems(state, SEVERITY.CHANGES);
}

export function openNits(state) {
  return state.ledger.filter((e) => e.status === "open" && e.severity === SEVERITY.NIT);
}

/** The ledger items the next builder leg must answer, one fixes[] entry each. */
export function itemsOwed(state) {
  if (state.next?.brief === "nits") return openNits(state);
  if (state.next?.brief === "fix") return openAboveNit(state).concat(openNits(state));
  if (state.next?.brief === "harden") return state.ledger.filter((e) => e.source === "breaker" && e.status === "open");
  return [];
}

/** Next id for a ledger entry: F1.. for reviewer findings, B1.. for breaker attacks. */
export function nextId(state, prefix) {
  return `${prefix}${state.ledger.filter((e) => e.id.startsWith(prefix)).length + 1}`;
}

/**
 * Count a malformed input. The first one asks again; the second for the same
 * key escalates (G1). Returns the escalation, or null when a re-ask is allowed.
 */
export function noteMalformed(state, key, reason, at) {
  state.malformed[key] = (state.malformed[key] ?? 0) + 1;
  log(state, at, "malformed", `${key}: ${reason}`);
  if (state.malformed[key] >= 2) return escalate(state, at, "G1", `malformed twice (${key}): ${reason}`);
  return null;
}

function overBudget(state, minutesElapsed) {
  return minutesElapsed > state.maxMinutes;
}

/**
 * After a builder leg. `result` is the validated builder result, `g0` the
 * outcome of the declared E2E and invariant commands run by crossfire itself.
 */
export function afterBuild(state, result, g0, { at, minutesElapsed }) {
  log(state, at, "build-recorded", `round ${state.round}: ${result.status}`);

  if (result.status !== "DONE") {
    return escalate(state, at, "BUILDER", `builder reported ${result.status}: ${result.summary ?? ""}`.trim());
  }

  for (const fix of result.fixes ?? []) {
    const entry = state.ledger.find((e) => e.id === fix.id);
    if (!entry) continue;
    entry.history.push({ at, round: state.round, builder: fix.status, note: fix.note ?? "", ...(fix.rule ? { rule: String(fix.rule).slice(0, 300) } : {}), ...(fix.where ? { where: String(fix.where).trim().slice(0, 300) } : {}) });
    if (fix.status === "FIXED") {
      entry.status = "claimed_fixed";
      entry.claimedRound = state.round;
      entry.claimedPass = state.reviewPass;
      delete entry.reflaggedPass;
    } else if (entry.severity === SEVERITY.NIT) {
      entry.status = "wontfix";
    } else if (entry.source === "breaker") {
      // The breaker is internal and can be wrong: a dispute is recorded and shown to
      // the reviewers, who decide. It never escalates by itself.
      entry.status = "disputed_internal";
    } else {
      entry.status = "disputed";
      return escalate(state, at, "G3", `builder ${fix.status} ${entry.id} (${entry.severity}: ${entry.title}): ${fix.note ?? "no note"}`);
    }
  }

  if (overBudget(state, minutesElapsed)) {
    return escalate(state, at, "G6", `wall-clock budget of ${state.maxMinutes} min spent`);
  }

  if (!g0.passed) {
    if (state.round >= state.maxRounds) {
      return escalate(state, at, "G2", `G0 still failing after ${state.round} builder legs`);
    }
    state.round += 1;
    state.phase = "build";
    return sendBuilder(state, at, "g0", { failures: g0.failures });
  }

  if (state.phase === "nit-build") {
    return ship(state, at, "nit pass done and G0 green (G7: no re-review after nits)");
  }

  // One breaker pass per builder leg, before the reviewers; not after its own harden leg.
  const hardenLeg = state.phase === "harden";
  if (state.breaker && !hardenLeg && !state.breakerRounds.includes(state.round)) {
    state.phase = "break";
    state.next = { action: ACTIONS.SEND_BREAKER, round: state.round };
    log(state, at, "send-breaker", `round ${state.round}`);
    return state.next;
  }

  state.phase = "review";
  state.next = { action: ACTIONS.RUN_REVIEW, pass: state.reviewPass + 1 };
  log(state, at, "run-review", `pass ${state.reviewPass + 1}`);
  return state.next;
}

/**
 * After the breaker. `attacks` are its proven attacks: [{severity, title, rule, scenario,
 * file, lineStart, lineEnd, test}]. Proven attacks become ledger entries (B1..) and get one
 * harden leg; with none, the branch goes to review.
 */
export function afterBreak(state, attacks, { at, minutesElapsed }) {
  state.breakerRounds.push(state.round);
  log(state, at, "break-recorded", `round ${state.round}: ${attacks.length} proven attack(s)`);
  for (const a of attacks) {
    state.ledger.push({
      id: nextId(state, "B"),
      source: "breaker",
      severity: a.severity === SEVERITY.NIT ? SEVERITY.CHANGES : a.severity,
      title: a.title,
      body: [a.scenario, a.rule ? `Rule: ${a.rule}` : "", a.test ? `Failing test: ${a.test}` : ""].filter(Boolean).join("\n"),
      file: a.file ?? null,
      lineStart: a.lineStart ?? null,
      lineEnd: a.lineEnd ?? a.lineStart ?? null,
      recommendation: "",
      reviewers: ["breaker"],
      status: "open",
      raisedPass: state.reviewPass,
      history: [],
    });
  }
  // The budget is checked after the attacks are in the ledger, so an escalation reports them.
  if (overBudget(state, minutesElapsed)) {
    return escalate(state, at, "G6", `wall-clock budget of ${state.maxMinutes} min spent`);
  }
  if (attacks.length) {
    state.phase = "harden";
    return sendBuilder(state, at, "harden");
  }
  state.phase = "review";
  state.next = { action: ACTIONS.RUN_REVIEW, pass: state.reviewPass + 1 };
  log(state, at, "run-review", `pass ${state.reviewPass + 1}`);
  return state.next;
}

/**
 * Compare a re-check with an earlier check of the same PR. Earlier findings are
 * tagged P1..Pn in the reviewers' focus; a reviewer that still sees one reports it
 * again, its title starting with the tag. Only that counts as still open. An untagged
 * finding near earlier ones (any severity) is new, "near Pn", and every earlier finding
 * it is near is unclear. Fixed means re-flagged by nobody and near nothing.
 */
export function compareWithPrevious(previous, current) {
  // Still open needs the reviewer's own tag ([Pn]). A new finding near an earlier one is
  // reported as new, "near Pn", and that earlier finding as unclear: neither is guessed.
  const stillOpen = [];
  const fresh = [];
  const tagged = new Set();
  const near = new Set();
  for (const f of current) {
    const close = previous.flatMap((p, j) => (overlaps(p, f) ? [j] : []));
    const idx = [...new Set(titlesOf(f).map((t) => /^\s*\[P(\d+)\]/.exec(t)?.[1]).filter(Boolean).map((n) => Number(n) - 1))].filter((i) => i >= 0 && i < previous.length);
    if (idx.length) {
      for (const i of idx) {
        if (!tagged.has(i)) stillOpen.push({ previous: { index: i + 1, ...previous[i] }, now: f, how: "re-flagged" });
        tagged.add(i);
      }
      for (const j of close) near.add(j);
      continue;
    }
    for (const j of close) near.add(j);
    fresh.push(close.length ? { ...f, nearPrevious: close.map((j) => j + 1) } : f);
  }
  const indexed = previous.map((p, i) => ({ index: i + 1, ...p }));
  const unclear = indexed.filter((p) => !tagged.has(p.index - 1) && near.has(p.index - 1));
  const resolved = indexed.filter((p) => !tagged.has(p.index - 1) && !near.has(p.index - 1));
  return { resolved, stillOpen, unclear, fresh };
}

const TAG_RE = /\[(F\d+)\]/;

/** Every title a merged finding carries: one per reviewer that reported it. */
function titlesOf(f) {
  return [f.title, ...(f.alsoTitles ?? [])].filter((t) => typeof t === "string");
}
const LINE_SLACK = 3;

function overlaps(a, b) {
  if (!a.file || !b.file || a.file !== b.file) return false;
  const aStart = a.lineStart ?? 0;
  const aEnd = a.lineEnd ?? aStart;
  const bStart = b.lineStart ?? 0;
  const bEnd = b.lineEnd ?? bStart;
  return aStart <= bEnd + LINE_SLACK && bStart <= aEnd + LINE_SLACK;
}

/** Merge findings from several reviewers; the same place and severity counts once. */
export function mergeFindings(reviews) {
  const merged = [];
  for (const review of reviews) {
    if (!review.ok) continue;
    for (const f of review.findings) {
      const twin = merged.find((m) => m.severity === f.severity && overlaps(m, f) && !m.reviewers.includes(review.reviewer));
      if (twin) {
        twin.reviewers.push(review.reviewer);
        if (f.title && f.title !== twin.title) (twin.alsoTitles ??= []).push(f.title);
        continue;
      }
      merged.push({ ...f, reviewers: [review.reviewer] });
    }
  }
  return merged;
}

/**
 * After a review pass. `reviews` holds one entry per reviewer that ran:
 * { reviewer, ok, required, verdict, summary, findings: [{severity, title, body, file, lineStart, lineEnd, recommendation, confidence}] }
 * A failed required reviewer must be handled by the caller (G1) before this.
 */
/** All findings of one review pass: merged across reviewers, plus a finding for an un-itemised "needs attention". */
export function collectFindings(reviews) {
  const findings = mergeFindings(reviews);
  for (const r of reviews) {
    if (r.ok && r.verdict === "needs-attention" && r.findings.length === 0) {
      findings.push({
        severity: SEVERITY.CHANGES,
        title: `${r.reviewer}: needs attention`,
        body: r.summary || "The reviewer asked for changes without itemised findings.",
        file: null,
        lineStart: null,
        lineEnd: null,
        recommendation: "",
        reviewers: [r.reviewer],
      });
    }
  }
  return findings;
}

export function afterReview(state, reviews, { at, minutesElapsed }) {
  state.reviewPass += 1;
  const findings = collectFindings(reviews);
  log(state, at, "review-recorded", `pass ${state.reviewPass}: ${findings.length} finding(s) from ${reviews.filter((r) => r.ok).map((r) => r.reviewer).join(", ")}`);

  const escalations = [];
  const fresh = [];
  const reflagged = new Set();

  for (const f of findings) {
    // A claimed fix or a dispute at the place of any finding is not accepted this pass.
    const atPlace = state.ledger.filter((e) => (e.status === "claimed_fixed" || e.status === "disputed_internal") && overlaps(e, f));
    for (const e of atPlace) reflagged.add(e.id);
    const tags = [...new Set(titlesOf(f).map((t) => TAG_RE.exec(t)?.[1]).filter(Boolean))];
    const taggedEntries = tags.map((id) => state.ledger.find((e) => e.id === id)).filter(Boolean);
    if (taggedEntries.length) {
      for (const tagged of taggedEntries) {
        reflagged.add(tagged.id);
        if (tagged.status === "wontfix" && f.severity === SEVERITY.NIT) continue;
        escalations.push(["G3", `${tagged.id} re-flagged after the builder answered it (${tagged.status}): ${tagged.title}`]);
      }
      continue;
    }
    // Breaker entries are internal: a reviewer finding at their place is a new finding, not G4.
    const suspects = atPlace.filter((e) => e.status === "claimed_fixed" && e.source !== "breaker");
    if (suspects.length) {
      for (const s of suspects) escalations.push(["G4", `new ${f.severity} at ${f.file}:${f.lineStart} overlaps ${s.id}, claimed fixed: ${f.title}`]);
      fresh.push(f); // recorded as open, so the owner sees it
      continue;
    }
    fresh.push(f);
    if (f.severity === SEVERITY.BLOCKER && state.reviewPass >= 2) {
      escalations.push(["G5", `new blocker at review pass ${state.reviewPass}: ${f.title}`]);
    }
  }

  if (state.reviewPass === 1) state.firstPass = { approved: fresh.length === 0 && escalations.length === 0, findings: fresh.length };
  for (const e of state.ledger) {
    if ((e.status === "claimed_fixed" || e.status === "disputed_internal") && !reflagged.has(e.id)) {
      e.status = "closed";
      e.closedPass = state.reviewPass;
    }
    if (reflagged.has(e.id)) e.reflaggedPass = state.reviewPass;
  }

  for (const f of fresh) {
    const id = nextId(state, "F");
    state.ledger.push({
      id,
      severity: f.severity,
      title: f.title,
      body: f.body,
      file: f.file,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      recommendation: f.recommendation ?? "",
      reviewers: f.reviewers,
      status: "open",
      raisedPass: state.reviewPass,
      history: [],
    });
  }

  if (escalations.length) {
    const order = ["G3", "G4", "G5"];
    escalations.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    const [gate] = escalations[0];
    return escalate(state, at, gate, escalations.map(([g, r]) => `${g}: ${r}`).join("; "));
  }

  if (overBudget(state, minutesElapsed)) {
    return escalate(state, at, "G6", `wall-clock budget of ${state.maxMinutes} min spent`);
  }

  if (openAboveNit(state).length === 0) {
    if (openNits(state).length === 0) return ship(state, at, `approved at review pass ${state.reviewPass}`);
    state.phase = "nit-build";
    state.nitPassDone = true;
    return sendBuilder(state, at, "nits");
  }

  if (state.round >= state.maxRounds) {
    return escalate(state, at, "G2", `${openAboveNit(state).length} finding(s) still open after ${state.round} builder legs`);
  }
  state.round += 1;
  state.phase = "build";
  return sendBuilder(state, at, "fix");
}
