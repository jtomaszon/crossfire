// The ship or escalation report, and the short status block every command prints.
import { openAboveNit, openNits } from "./referee.mjs";

function loc(e) {
  return e.file ? `${e.file}${e.lineStart ? `:${e.lineStart}` : ""}` : "-";
}

export function statusLine(state, minutesElapsed) {
  return `CROSSFIRE ${state.slug} · round ${state.round}/${state.maxRounds} · review pass ${state.reviewPass} · ${Math.round(minutesElapsed)}/${state.maxMinutes} min · ${state.phase}`;
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

export function renderReport(state, { minutesElapsed, changedFiles = [], head = null, reviewersText = null }) {
  const t = state.terminal ?? {};
  const shipped = t.kind === "shipped";
  const out = [
    `# Crossfire ${shipped ? "SHIP" : "ESCALATE"}: ${state.slug}`,
    "",
    `- Result: ${shipped ? "shipped" : `escalated at gate ${t.gate}`}: ${t.reason}`,
    `- Spec: \`${state.spec}\``,
    `- Branch diff: \`${state.base}\`..\`${head ?? "HEAD"}\`, ${changedFiles.length} file(s) changed`,
    `- Builder legs: ${state.round} of ${state.maxRounds}; review passes: ${state.reviewPass}; ${Math.round(minutesElapsed)} of ${state.maxMinutes} min`,
    `- Reviewers: ${reviewersText ?? "not recorded"}`,
    `- First review pass: ${state.firstPass ? (state.firstPass.approved ? "approved, nothing to fix" : `${state.firstPass.findings} finding(s)`) : "no review ran"}`,
    `- Breaker: ${state.breaker === false ? "off" : `${(state.breakerRounds ?? []).length} pass(es), ${state.ledger.filter((e) => e.source === "breaker").length} proven attack(s)`}`,
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
  const reviewerFailures = (state.reviewerRuns ?? []).filter((r) => !r.ok);
  out.push(
    "",
    "## Evidence",
    `- Proof commands crossfire ran itself (last run, round ${state.lastProof?.round ?? "-"}):${state.lastProof?.commands?.length ? "" : " none declared"}`,
    ...(state.lastProof?.commands ?? []).map((c) => `  - \`${c.command}\`: exit ${c.status}`),
    `- Tests the builder named this loop: ${(state.testsNamed ?? []).length}${(state.testsNamed ?? []).length ? ` (${state.testsNamed.slice(0, 12).join(", ")}${state.testsNamed.length > 12 ? ", ..." : ""})` : ""}. Crossfire checks that they pass only through the proof commands above.`,
    `- Breaker: ${state.breaker === false ? "off" : `${breakerItems.length} attack(s) proven with failing tests; the builder answered ${answered("FIXED")} FIXED and ${answered("DISPUTED")} DISPUTED${unanswered ? `, ${unanswered} unanswered` : ""}${breakerItems.length ? (breakerItems.some((e) => e.status === "closed") ? "; the answers were in front of the reviewers in a later pass" : "; no review pass ran after the answers") : ""}`}`,
    `- Reviewers read the branch diff against \`${state.base}\` read-only: ${reviewersText ?? "not recorded"}${reviewerFailures.length ? `; ${reviewerFailures.length} reviewer pass(es) did not complete` : ""}.`,
    "- Not verified by crossfire: anything outside the proof commands (the full test suite, lint, migrations, deploys). CI on the pull request is that gate.",
  );
  const accepted = state.ledger.filter((e) => e.status === "wontfix" || (shipped && e.status === "claimed_fixed" && e.severity === "NIT"));
  if (accepted.length) out.push("", `Accepted nits (G7, not re-reviewed): ${accepted.map((e) => e.id).join(", ")}`);
  if (!shipped) {
    const ids = (list) => list.map((e) => `${e.id} (${e.severity})`).join(", ");
    const open = [...openAboveNit(state), ...openNits(state)];
    const claimed = state.ledger.filter((e) => e.status === "claimed_fixed" && e.severity !== "NIT");
    const reflagged = claimed.filter((e) => e.reflaggedPass != null && e.reflaggedPass > (e.claimedPass ?? -1));
    const unreviewed = claimed.filter((e) => !reflagged.includes(e) && (e.claimedPass ?? -1) >= state.reviewPass);
    const disputed = state.ledger.filter((e) => e.status === "disputed_internal" || e.status === "disputed");
    const groups = [
      [open, "Still open"],
      [reflagged, "Claimed fixed, then re-flagged by a reviewer"],
      [unreviewed, "Claimed fixed by the builder, not re-reviewed"],
      [disputed, "Disputed by the builder, not settled by a reviewer"],
    ].filter(([list]) => list.length);
    out.push(
      "",
      "## What the owner needs to decide",
      `- Gate ${t.gate}: ${t.reason}`,
      ...(groups.length ? groups.map(([list, label]) => `- ${label}: ${ids(list)}`) : ["- Nothing else is open."]),
      "- Options: accept as is, give the builder a direction and start a new loop on top of this branch, or drop the change.",
    );
  }
  if (changedFiles.length) out.push("", "## Files changed", ...changedFiles.map((f) => `- ${f}`));
  out.push("", "## Timeline", ...state.history.map((h) => `- ${h.at} ${h.event}${h.detail ? `: ${h.detail}` : ""}`));
  return `${out.join("\n")}\n`;
}
