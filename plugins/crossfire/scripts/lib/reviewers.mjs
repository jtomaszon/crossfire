// Run the official reviewer plugins' own scripts (read-only) and normalise
// their shared review-output schema into crossfire findings.
import fs from "node:fs";
import path from "node:path";
import { run, tail } from "./util.mjs";
import { OFFICIAL, reviewerEnv } from "./plugins.mjs";
import { severityOf } from "./referee.mjs";
import { precedentsFocus } from "./precedents.mjs";

const SPEC_MAX_CHARS = 12_000;

/** The focus text both reviewers receive on top of their own adversarial framing. */
export function buildFocus(state, { specText, specFile = state.spec, precedents = [] }) {
  const ledger = state.ledger.filter((e) => e.status !== "open" && e.source !== "breaker");
  const internal = state.ledger.filter((e) => e.source === "breaker");
  const lines = [
    `Crossfire loop "${state.slug}", review pass ${state.reviewPass + 1}. Review the branch diff against ${state.base} for correctness against the spec below, security, and regressions.`,
    "",
    "Severity: critical or high = must be fixed before this ships; medium = should be fixed; low = nit.",
    "Only report a finding you can tie to a file and line in this diff.",
  ];
  if (ledger.length) {
    lines.push(
      "",
      "Earlier findings and how the builder answered them. If one of these is still not resolved, report it again and START ITS TITLE WITH ITS TAG, for example \"[F2] still racy\". Do not re-report resolved ones.",
      ...ledger.map((e) => `- [${e.id}] ${e.severity} ${e.file ?? ""}${e.lineStart ? `:${e.lineStart}` : ""} ${e.title} -> builder: ${answer(e)}`),
    );
  }
  if (internal.length) {
    lines.push(
      "",
      "Before your review, an internal adversarial pass (same vendor as the builder) attacked the change with failing tests. What it proved and how the builder answered. Check that the fixes hold; where the builder DISPUTED an attack, decide yourself and report it if you agree it is a bug:",
      ...internal.map((e) => `- ${e.title} -> builder: ${answer(e)}`),
    );
  }
  lines.push(...precedentsFocus(precedents));
  const spec = specText.length > SPEC_MAX_CHARS ? `${specText.slice(0, SPEC_MAX_CHARS)}\n[spec truncated; full text at ${specFile}]` : specText;
  lines.push("", "SPEC:", spec);
  return lines.join("\n");
}

/** The builder's last answer to a finding: FIXED (at file:line), DISPUTED, with its note. */
function answer(e) {
  const h = e.history.at(-1);
  if (!h) return e.status;
  return `${h.builder}${h.where ? ` at ${h.where}` : ""}${h.note ? ` (${h.note})` : ""}`;
}

/** Reviewers disagree on paths (Grok gives absolute ones): make them repo-relative so places match. */
function relativeFile(file, cwd) {
  if (!file || !cwd || !path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file);
  return rel.startsWith("..") ? file : rel.split(path.sep).join("/");
}

function normaliseFinding(f) {
  const lineStart = Number.isInteger(f.line_start) ? f.line_start : null;
  return {
    severity: severityOf(f.severity),
    reviewerSeverity: f.severity,
    title: String(f.title ?? "").trim() || "(untitled finding)",
    body: String(f.body ?? "").trim(),
    file: f.file ? String(f.file) : null,
    lineStart,
    lineEnd: Number.isInteger(f.line_end) ? f.line_end : lineStart,
    recommendation: String(f.recommendation ?? "").trim(),
    confidence: typeof f.confidence === "number" ? f.confidence : null,
  };
}

/**
 * The review object inside a payload. Codex's companion puts it in `result`; xAI's
 * bridge wraps it: `result.structuredOutput`, or a JSON string in `result.text`
 * (sometimes fenced). Returns the object, or null.
 */
export function unwrapResult(result) {
  if (!result || typeof result !== "object") return null;
  if ("verdict" in result && "findings" in result) return result;
  const so = result.structuredOutput;
  if (so && typeof so === "object" && "verdict" in so) return so;
  if (typeof so === "string" || typeof result.text === "string") {
    const raw = String(typeof so === "string" ? so : result.text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "verdict" in parsed) return parsed;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/** Parse a companion/bridge `--json` payload. Returns {ok, verdict, summary, findings, error}. */
export function parseReviewPayload(stdout, { cwd = null } = {}) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `output is not JSON: ${tail(stdout, 300)}` };
  }
  const result = unwrapResult(payload?.result);
  if (!result || typeof result !== "object") {
    return { ok: false, error: `no structured result${payload?.parseError ? `: ${payload.parseError}` : ""}` };
  }
  if (!["approve", "needs-attention"].includes(result.verdict) || !Array.isArray(result.findings)) {
    return { ok: false, error: "result does not match the review-output schema" };
  }
  // "needs-attention" with nothing itemised is a reviewer that could not review (e.g. its
  // sandbox could not run git): not something a builder can fix. Treat it as a failed review.
  if (result.verdict === "needs-attention" && result.findings.length === 0) {
    return { ok: false, error: `the reviewer could not complete the review: ${String(result.summary ?? "no findings and no reason").split("\n")[0].slice(0, 300)}` };
  }
  return {
    ok: true,
    verdict: result.verdict,
    summary: String(result.summary ?? ""),
    findings: result.findings.map(normaliseFinding).map((f) => ({ ...f, file: relativeFile(f.file, cwd) })),
    nextSteps: Array.isArray(result.next_steps) ? result.next_steps : [],
  };
}

/** The reviewer's own error line, not the whole payload. */
export function failureReason(r, parsed) {
  let payload = null;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  const own = payload?.parseError || payload?.codex?.stderr || payload?.grok?.stderr || payload?.error || r.stderr;
  const line = String(own || parsed.error || "").trim().split("\n").find(Boolean) ?? "";
  return `${r.status !== 0 ? `exit ${r.status}: ` : ""}${line.slice(0, 400) || parsed.error}`;
}

/** Run one reviewer. Never throws; a failure comes back as ok:false. */
export function runReviewer(plugin, { cwd, base, focus, timeoutMs }) {
  const spec = OFFICIAL[plugin.key];
  const args = [plugin.script, spec.reviewCommand, "--wait", "--json", "--base", base, "--cwd", cwd, focus];
  const started = Date.now();
  const r = run(process.execPath, args, { cwd, env: reviewerEnv(plugin.key), timeoutMs });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (r.timedOut) return { reviewer: plugin.key, required: spec.required, ok: false, seconds, error: `timed out after ${seconds}s` };
  const parsed = parseReviewPayload(r.stdout, { cwd });
  if (!parsed.ok) return { reviewer: plugin.key, required: spec.required, ok: false, seconds, error: failureReason(r, parsed) };
  return { reviewer: plugin.key, required: spec.required, seconds, ...parsed };
}

/** Focus for a review-only check: no loop, so no ledger; the spec or the user's focus, when given. */
export function buildCheckFocus({ base, specText = "", focusText = "", previous = [], precedents = [] }) {
  const lines = [
    `Review the branch diff against ${base} as a pull request reviewer: correctness, security, data integrity and regressions.`,
    "Pay particular attention to how it could fail in production: transactions and rollback (including nested transactions), stale in-memory state, concurrency, retries and idempotency, ordering, missing or unexpected data.",
    "",
    "Severity: critical or high = must be fixed before this merges; medium = should be fixed; low = nit.",
    "Only report a finding you can tie to a file and line in this diff.",
  ];
  if (focusText.trim()) lines.push("", "WHAT THIS CHANGE IS FOR:", focusText.trim().slice(0, 4000));
  if (previous.length) {
    lines.push(
      "",
      "An earlier review of this pull request found the issues below, and the author has pushed changes since. For each one still present, report it again and START ITS TITLE WITH ITS TAG, for example \"[P2] still unchecked\". Do not report one that is now fixed. Also report anything new, including problems the new changes introduce.",
      ...previous.map((p, i) => `- [P${i + 1}] ${p.severity} ${p.file ?? ""}${p.lineStart ? `:${p.lineStart}` : ""} ${p.title}`),
    );
  }
  lines.push(...precedentsFocus(precedents));
  if (specText.trim()) lines.push("", "SPEC:", specText.length > SPEC_MAX_CHARS ? `${specText.slice(0, SPEC_MAX_CHARS)}\n[spec truncated]` : specText);
  return lines.join("\n");
}

export function readSpec(specPath) {
  return fs.readFileSync(specPath, "utf8");
}
