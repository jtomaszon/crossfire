// Prove the spec before any code exists: the cross-vendor reviewers read the spec and plan as a
// design, and `init` checks that the spec it starts from is the one they reviewed. Also the two
// small facts the lean defaults read: the spec's Risk line, and the size of a diff.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "./util.mjs";
import { precedentsFocus } from "./precedents.mjs";

export const SPEC_REVIEW_DIR = "crossfire-spec-review";

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Where a slug's spec review lives, next to its spec: .crossfire/specs/<slug>.review.{json,md}, and the response file. */
export function specReviewFiles(specsDir, slug) {
  return {
    json: path.join(specsDir, `${slug}.review.json`),
    md: path.join(specsDir, `${slug}.review.md`),
    response: path.join(specsDir, `${slug}.review-response.md`),
  };
}

/** The reviewers' focus for a spec review: the document as a design, never the pull-request focus. */
export function buildSpecFocus({ slug, base, hasPlan, precedents = [] }) {
  const spec = `${SPEC_REVIEW_DIR}/${slug}.md`;
  const plan = `${SPEC_REVIEW_DIR}/${slug}.plan.md`;
  return [
    `Crossfire spec review "${slug}". This diff against ${base} adds only a spec (${spec})${hasPlan ? ` and its implementation plan (${plan})` : ""} for a change that has not been built: no code for it exists yet. Everything else in this checkout is the repository's current code, which the spec will change.`,
    "",
    "Review the document as a design against the repository's current code. Report:",
    "- gaps: what the change needs that the spec does not say;",
    "- contradictions between its parts;",
    "- untestable or ambiguous acceptance criteria;",
    "- missing failure modes (transactions and rollback, stale state, concurrency, retries, ordering, missing data, the boundaries it touches);",
    "- conflicts with the code it names: a file, function, behaviour or assumption that is not what the repository has;",
    "- cheaper ways to the same goal.",
    "",
    "A finding about something missing cites the heading where it belongs (the line of that heading in the spec or plan).",
    "Severity: high = the builder would build the wrong thing or a hole would ship; medium = an ambiguity that would cost a round; low = wording.",
    ...precedentsFocus(precedents),
  ].join("\n");
}

/** The saved review, or null when there is none or it cannot be read as one. */
export function readSpecReview(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { unreadable: true };
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * AC-3: is the spec (and plan) init starts from the one that was reviewed?
 * current: same bytes. revised: changed, with a non-empty response file newer than the review.
 * stale: changed without one. none: no usable review. Returns { status, line, at, findings }.
 */
export function specReviewStatus({ review, spec, plan, responseFile }) {
  const usable = review && !review.unreadable && HEX64.test(String(review.specSha256 ?? "")) && (review.planSha256 === null || HEX64.test(String(review.planSha256 ?? ""))) && Number.isFinite(Date.parse(review.at ?? "")) && Array.isArray(review.findings);
  if (!usable) return { status: "none", line: "SPEC REVIEW: none", at: null, findings: null, note: review ? "the saved spec review could not be read as one; run crossfire spec-review again" : null };
  const at = review.at;
  const n = review.findings.length;
  const same = review.specSha256 === sha256(spec) && review.planSha256 === (plan ? sha256(plan) : null);
  if (same) return { status: "current", line: `SPEC REVIEW: current (${at}, ${n} findings)`, at, findings: n };
  let responded = false;
  try {
    const st = fs.statSync(responseFile);
    responded = st.mtimeMs > Date.parse(at) && fs.readFileSync(responseFile, "utf8").trim().length > 0;
  } catch {
    responded = false;
  }
  if (responded) return { status: "revised", line: `SPEC REVIEW: revised after review (${at}, ${n} findings; responses in ${responseFile})`, at, findings: n, responseFile };
  return { status: "stale", line: `SPEC REVIEW: stale (the spec changed after ${at} with no recorded response)`, at, findings: n };
}

/** The spec's `**Risk:** high` line (high turns the breaker on in a lean loop). */
export function riskHigh(specText) {
  return /^\s*[-*]?\s*\*\*Risk:\*\*\s*high\b/im.test(String(specText ?? ""));
}

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Gemfile.lock", "Cargo.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "composer.lock", "go.sum", "mix.lock", "pubspec.lock", "Podfile.lock", "packages.lock.json", "flake.lock"]);

export function isLockfile(file) {
  return LOCKFILES.has(String(file ?? "").split("/").at(-1));
}

/** Changed lines (added + removed) and files of base...HEAD, lockfiles excluded; null when git fails. */
export function diffSize(repo, baseSha) {
  const r = run("git", ["-c", "core.quotePath=false", "diff", "-M", "--numstat", "-z", "--no-ext-diff", `${baseSha}...HEAD`], { cwd: repo });
  if (r.status !== 0) return null;
  const tokens = r.stdout.split("\0");
  let lines = 0;
  let files = 0;
  for (let i = 0; i < tokens.length; ) {
    const head = tokens[i];
    if (!head) {
      i += 1;
      continue;
    }
    const [added, removed, file] = head.split("\t");
    let name = file;
    if (file === "") {
      name = tokens[i + 2]; // a rename: "<a>\t<d>\t\0<old>\0<new>\0"
      i += 3;
    } else i += 1;
    if (isLockfile(name)) continue;
    files += 1;
    lines += (Number(added) || 0) + (Number(removed) || 0);
  }
  return { lines, files };
}

export const SIZE_LINES = 400;
export const SIZE_FILES = 10;

/** The size warning line, or null when the change is within about 400 lines and 10 files. */
export function sizeWarning(size) {
  if (!size || (size.lines <= SIZE_LINES && size.files <= SIZE_FILES)) return null;
  return `WARNING: this change is ${size.lines} lines in ${size.files} files; past about ${SIZE_LINES} lines or ${SIZE_FILES} files, split it`;
}

/** The readable spec review. */
export function renderSpecReviewMd(record) {
  const out = [
    `# Crossfire spec review: ${record.slug}`,
    "",
    `- Spec: \`${record.spec}\` (sha256 ${record.specSha256.slice(0, 12)})`,
    `- Plan: ${record.plan ? `\`${record.plan}\` (sha256 ${record.planSha256.slice(0, 12)})` : "none"}`,
    `- Base: \`${record.base}\` (\`${record.baseSha.slice(0, 12)}\`)`,
    `- Reviewers: ${record.reviewersText}`,
    `- When: ${record.at}`,
    `- Locations: \`${SPEC_REVIEW_DIR}/${record.slug}.md\` is the spec and \`${SPEC_REVIEW_DIR}/${record.slug}.plan.md\` the plan, line for line.`,
    "",
    "## Findings",
  ];
  if (!record.findings.length) out.push("None.");
  for (const [i, f] of record.findings.entries()) {
    out.push(
      "",
      `### ${i + 1}. ${f.reviewerSeverity ?? f.severity} · ${f.file ? `${f.file}${f.lineStart ? `:${f.lineStart}` : ""}` : "(no location)"} · ${f.reviewers.join(" + ")}`,
      `**${f.title}**`,
      "",
      f.body || "",
      f.recommendation ? `\nRecommendation: ${f.recommendation}` : "",
    );
  }
  out.push("", "## Next", "", `Revise the spec for each finding, then write \`${path.basename(record.responseFile)}\` next to it: one line per finding, how it was addressed or why not. \`crossfire init\` then reports the spec as revised after review.`);
  return `${out.join("\n")}\n`;
}
