// The ship or escalation report, and the short status block every command prints.
import { builderLegs, openAboveNit, openNits } from "./referee.mjs";

function loc(e) {
  return e.file ? `${e.file}${e.lineStart ? `:${e.lineStart}` : ""}` : "-";
}

export function statusLine(state, minutesElapsed) {
  return `CROSSFIRE ${state.slug} · round ${builderLegs(state)}/${state.maxRounds} · review pass ${state.reviewPass} · ${Math.round(minutesElapsed)}/${state.maxMinutes} min · ${state.phase}`;
}

/** Report of a review-only check. */
export function renderCheckReport(check) {
  const out = [
    `# Crossfire check: ${check.id}`,
    "",
    `- Result: ${check.approved ? "approved, nothing to fix" : `${check.findings.length} finding(s)`}`,
    `- Branch: \`${check.branch ?? "?"}\` at \`${check.head.slice(0, 12)}\`, reviewed against \`${check.base}\` (\`${check.baseSha.slice(0, 12)}\`)`,
    `- Reviewers: ${check.reviewersText}`,
    `- When: ${check.at}`,
    ...(check.size?.warning ? [`- Size: ${check.size.lines} lines in ${check.size.files} files (lockfiles excluded); past about 400 lines or 10 files, split it`] : []),
  ];
  if (check.since) {
    const d = check.since;
    out.push(
      "",
      `## Since ${d.id} (${d.head.slice(0, 12)})`,
      "",
      `${d.resolved.length} fixed, ${d.stillOpen.length} still open, ${(d.unclear ?? []).length} unclear, ${d.fresh} new.`,
      ...d.resolved.map((p) => `- Fixed: [P${p.index}] ${p.title}`),
      ...d.stillOpen.map((x) => `- Still open (${x.how}): [P${x.previous.index}] ${x.previous.title}`),
      ...(d.unclear ?? []).map((p) => `- Unclear: [P${p.index}] ${p.title} (a new finding is near it; read both)`),
      ...(d.near ?? []).map((n) => `- New, near ${String(n.near).startsWith("P") ? n.near : `P${n.near}`}: ${n.title}`),
    );
  }
  out.push("", "## Findings");
  if (!check.findings.length) out.push("None.");
  for (const [i, f] of check.findings.entries()) {
    out.push(
      "",
      `### ${i + 1}. ${f.severity} · ${f.file ? `${f.file}${f.lineStart ? `:${f.lineStart}` : ""}` : "(no location)"} · ${f.reviewers.join(" + ")}`,
      `**${f.title}**`,
      "",
      f.body || "",
      f.recommendation ? `\nRecommendation: ${f.recommendation}` : "",
    );
  }
  return `${out.join("\n")}\n`;
}

/**
 * Signs that patching is not converging and a rewritten spec may be cheaper: findings that
 * cluster on one file across passes, fixes re-flagged, new blockers late, or the round cap.
 */
export function respecSignals(state) {
  const signals = [];
  const byFile = new Map();
  for (const e of state.ledger ?? []) {
    if (!e.file || e.severity === "NIT") continue;
    const v = byFile.get(e.file) ?? { n: 0, passes: new Set() };
    v.n += 1;
    v.passes.add(e.raisedPass ?? 0);
    byFile.set(e.file, v);
  }
  for (const [file, v] of byFile) if (v.n >= 3 && v.passes.size >= 2) signals.push(`${v.n} findings in ${v.passes.size} review passes on ${file}`);
  const reflagged = (state.ledger ?? []).filter((e) => e.reflaggedPass != null || (e.history ?? []).some((h) => h.reflagged)).map((e) => e.id);
  if (reflagged.length) signals.push(`fixes re-flagged by a reviewer: ${reflagged.join(", ")}`);
  const gate = state.terminal?.gate;
  if (gate === "G5") signals.push("a new blocker appeared after the first fixes (G5)");
  if (gate === "G2") signals.push(`findings still open after ${builderLegs(state)} builder rounds (G2)`);
  return signals;
}

/** Breaker legs as they happened: completed, skipped (malformed twice, or the time budget) or failed. */
export function breakerTally(state) {
  const events = state.history ?? [];
  const skipped = events.filter((h) => h.event === "breaker-skipped").length;
  const failed = events.filter((h) => h.event === "breaker-failed").length;
  // A malformed-twice skip and a FAILED breaker still record their round; a budget skip does not.
  const recordedSkips = events.filter((h) => h.event === "breaker-skipped" && /^malformed/.test(h.detail ?? "")).length;
  const completed = Math.max(0, (state.breakerRounds ?? []).length - recordedSkips - failed);
  return { completed, skipped, failed, text: `${completed} pass(es) completed${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} failed` : ""}` };
}

/** The settings a 1.4 loop decided at init, and where each came from. */
export function settingsText(state) {
  const d = state.decided ?? {};
  const grok = state.grok === "auto" ? `grok auto (${d.grokPasses === "first" ? "spec review and first code pass only" : "every pass"})` : `grok ${state.grok}`;
  return `${grok}, breaker ${state.breaker ? "on" : "off"}${d.breakerFrom ? ` (${d.breakerFrom})` : ""}, max-rounds ${state.maxRounds}${d.maxRoundsFrom ? ` (${d.maxRoundsFrom})` : ""}`;
}

export function renderReport(state, { minutesElapsed, changedFiles = [], head = null, reviewersText = null }) {
  const t = state.terminal ?? {};
  const shipped = t.kind === "shipped";
  const out = [
    `# Crossfire ${shipped ? "SHIP" : "ESCALATE"}: ${state.slug}`,
    "",
    `- Result: ${shipped ? "shipped" : `escalated at gate ${t.gate}`}: ${t.reason}`,
    `- Spec: \`${state.spec}\``,
    `- Branch diff: \`${state.base}\`..\`${head ?? "HEAD"}\`, ${changedFiles.length} file(s) changed`,
    `- Builder legs: ${builderLegs(state)} of ${state.maxRounds}; review passes: ${state.reviewPass}; ${Math.round(minutesElapsed)} of ${state.maxMinutes} min`,
    ...(state.policy ? [`- Spec review: ${state.specReview?.line ?? "not recorded"}`, `- Settings: ${settingsText(state)}`] : []),
    `- Reviewers: ${reviewersText ?? "not recorded"}`,
    `- First review pass: ${state.firstPass ? (state.firstPass.approved ? "approved, nothing to fix" : `${state.firstPass.findings} finding(s)`) : "no review ran"}`,
    `- Breaker: ${state.breaker === false ? "off" : `${breakerTally(state).text}, ${state.ledger.filter((e) => e.source === "breaker").length} proven attack(s)`}`,
    "",
    "## Findings",
  ];
  if (!state.ledger.length) out.push("None.");
  else {
    out.push("| ID | Severity | Status | Where | Reviewers | Finding |", "|---|---|---|---|---|---|");
    for (const e of state.ledger) {
      const fixAt = [...e.history].reverse().find((h) => h.where)?.where;
      out.push(`| ${e.id} | ${e.severity} | ${e.status} | ${loc(e)}${fixAt ? ` (fix: ${fixAt})` : ""} | ${e.reviewers.join(" + ")} | ${e.title.replace(/\|/g, "\\|")} |`);
    }
  }
  // Evidence: what crossfire executed, what the builder claimed, what nobody checked.
  const breakerItems = state.ledger.filter((e) => e.source === "breaker");
  const lastAnswer = (e) => e.history.at(-1)?.builder;
  const answered = (a) => breakerItems.filter((e) => lastAnswer(e) === a).length;
  const unanswered = breakerItems.filter((e) => !lastAnswer(e)).length;
  // Each answer on its own: reviewed when a review pass ran after it (closed, or held at a finding's place).
  const reviewedAnswer = (e) => e.status === "closed" || (e.reflaggedPass != null && e.reflaggedPass > (e.answeredPass ?? e.claimedPass ?? -1));
  const withAnswer = breakerItems.filter((e) => lastAnswer(e));
  const reviewedN = withAnswer.filter(reviewedAnswer).length;
  const reviewerFailures = (state.reviewerRuns ?? []).filter((r) => !r.ok && !r.notRun);
  out.push(
    "",
    "## Evidence",
    `- Proof commands crossfire ran itself (last run, round ${state.lastProof?.round ?? "-"}):${state.lastProof?.commands?.length ? "" : " none declared"}`,
    ...(state.lastProof?.commands ?? []).map((c) => `  - \`${c.command}\`: exit ${c.status}`),
    `- Tests the builder named this loop: ${(state.testsNamed ?? []).length}${(state.testsNamed ?? []).length ? ` (${state.testsNamed.slice(0, 12).join(", ")}${state.testsNamed.length > 12 ? ", ..." : ""})` : ""}. Crossfire checks that they pass only through the proof commands above.`,
    `- Breaker: ${state.breaker === false ? "off" : `${breakerTally(state).text}; ${breakerItems.length} attack(s) proven with failing tests; the builder answered ${answered("FIXED")} FIXED and ${answered("DISPUTED")} DISPUTED${unanswered ? `, ${unanswered} unanswered` : ""}${withAnswer.length ? `; ${reviewedN} of these answers went through a later review pass, ${withAnswer.length - reviewedN} did not` : ""}`}`,
    `- Reviewers read the branch diff against \`${state.base}\` read-only: ${reviewersText ?? "not recorded"}${reviewerFailures.length ? `; ${reviewerFailures.length} reviewer pass(es) did not complete` : ""}.`,
    ...(state.sizeWarnings ?? []).map((w) => `- Size: ${w.lines} lines in ${w.files} files at review pass ${w.pass} (lockfiles excluded); past about 400 lines or 10 files, split it.`),
    "- Not verified by crossfire: anything outside the proof commands (the full test suite, lint, migrations, deploys). CI on the pull request is that gate.",
  );
  if (t.gate === "SPEC") {
    const h = t.handoff ?? {};
    out.push(
      "",
      "## The builder's handoff: the spec does not fit",
      "",
      `- Severity: ${h.severity ?? "-"}`,
      `- Summary: ${h.summary ?? "-"}`,
      `- Tried: ${h.tried ?? "-"}`,
      `- Situation: ${h.situation ?? "-"}`,
      `- Synthesis: ${h.synthesis ?? "-"}`,
      "",
      `Revise the spec with the person who owns the change: \`crossfire respec --from-loop ${state.slug} --slug <new-slug>\` drafts a new spec from this one (with any findings as known failure modes); after the person approves it, a new loop starts from \`${state.base}\`. The handoff is the builder's view: the person decides whether the spec or the builder is wrong.`,
    );
  }
  const accepted = state.ledger.filter((e) => e.status === "wontfix" || (shipped && e.status === "claimed_fixed" && e.severity === "NIT"));
  if (accepted.length) out.push("", `Accepted nits (G7, not re-reviewed): ${accepted.map((e) => e.id).join(", ")}`);
  if (!shipped) {
    const ids = (list) => list.map((e) => `${e.id} (${e.severity})`).join(", ");
    const signals = respecSignals(state);
    const open = [...openAboveNit(state), ...openNits(state)];
    // Re-flagged in this pass, whatever the status (a closed finding a reviewer re-opened is open again).
    const reflagged = state.ledger.filter((e) => e.reflaggedPass != null && e.reflaggedPass === state.reviewPass && e.reflaggedPass > (e.answeredPass ?? e.claimedPass ?? -1));
    // Loops started before 1.1.0 have no answeredPass: their claims count as not re-reviewed.
    const unreviewed = state.ledger.filter((e) => e.status === "claimed_fixed" && e.severity !== "NIT" && !reflagged.includes(e));
    const openNow = open.filter((e) => !reflagged.includes(e));
    const disputed = state.ledger.filter((e) => e.status === "disputed_internal" || e.status === "disputed");
    const groups = [
      [openNow, "Still open"],
      [reflagged, "Claimed fixed, then re-flagged (or flagged at the same place) by a reviewer"],
      [unreviewed, "Claimed fixed by the builder, not re-reviewed"],
      [disputed, "Disputed by the builder, not settled by a reviewer"],
    ].filter(([list]) => list.length);
    out.push(
      "",
      "## What the owner needs to decide",
      `- Gate ${t.gate}: ${t.reason}`,
      ...(groups.length ? groups.map(([list, label]) => `- ${label}: ${ids(list)}`) : [/^G[34]$/.test(t.gate ?? "") ? "- See the gate above: a reviewer re-flagged a finding." : "- Nothing else is open."]),
      ...reflagged.flatMap((e) => {
        const h = [...e.history].reverse().find((x) => x.reflagged);
        return h ? [`  - ${e.id} re-flagged as: ${h.reflagged}${h.body ? `: ${h.body.split("\n")[0].slice(0, 300)}` : ""}`] : [];
      }),
      ...(signals.length ? [`- Consider starting over: ${signals.join("; ")}. \`crossfire respec --from-loop ${state.slug} --slug <new-slug>\` drafts a new spec from this one with every finding above as a known failure mode; after the person approves it, the new loop starts from \`${state.base}\`, not from this branch.`] : []),
      `- Options: accept as is, give the builder a direction and start a new loop on top of this branch, start over from a rewritten spec (\`crossfire respec\`), or drop the change. The person who asked for the change decides, not an agent running the loop.`,
      "- At most one new loop per escalation (a fix loop or a respec); if it escalates too, stop and wait for the person. Any further code goes through a crossfire loop.",
      "- Only if the person said to run unattended may an agent choose among these, and then it never pushes, merges or opens a PR for this branch while a BLOCKER or CHANGES finding above is open, re-flagged, disputed, or claimed fixed and not re-reviewed.",
    );
  }
  if (changedFiles.length) out.push("", "## Files changed", ...changedFiles.map((f) => `- ${f}`));
  out.push("", "## Timeline", ...state.history.map((h) => `- ${h.at} ${h.event}${h.detail ? `: ${h.detail}` : ""}`));
  return `${out.join("\n")}\n`;
}
