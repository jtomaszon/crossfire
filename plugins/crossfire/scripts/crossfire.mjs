#!/usr/bin/env node
// crossfire: the referee CLI for the build -> review -> fix loop.
// Claude (the orchestrator) runs these commands; the referee decides every next step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "./lib/git.mjs";
import { ACTIONS, afterBreak, afterBuild, afterReview, collectFindings, compareWithPrevious, isTerminal, newState, noteMalformed } from "./lib/referee.mjs";
import { renderBreakerBrief, renderBrief, validateBreakerResult, validateBuildResult } from "./lib/briefs.mjs";
import { locatePlugins, readiness, usable, versionSkew, OFFICIAL } from "./lib/plugins.mjs";
import { buildCheckFocus, buildFocus, readSpec, runReviewer } from "./lib/reviewers.mjs";
import * as W from "./lib/watch.mjs";
import { crossfireRoot, ensureExcluded, files, listRuns, loadState, runDir, saveState, withLock } from "./lib/store.mjs";
import { renderCheckReport, renderReport, settingsText, statusLine } from "./lib/report.mjs";
import { appendLessons, lessonsBlock, lessonsFromCheck, lessonsFromLoop, memoryFile, readLessons } from "./lib/memory.mjs";
import { autoSkip, classifyProofFailure, grokSocketHint, readHealth, recordAttempt, summarize } from "./lib/health.mjs";
import { appendPrecedent, precedentsBlock, precedentsFile, readPrecedents } from "./lib/precedents.mjs";
import { SPEC_REVIEW_DIR, buildSpecFocus, diffSize, readSpecReview, renderSpecReviewMd, riskHigh, sha256, sizeWarning, specReviewFiles, specReviewStatus } from "./lib/specreview.mjs";
import { testChanges } from "./lib/testguard.mjs";
import { CrossfireError, EXIT, atomicWriteJson, minutesBetween, nowIso, readJsonFile, run, runShell, tail, writeText } from "./lib/util.mjs";

const VERSION = "1.4.0";

const USAGE = `crossfire ${VERSION}: referee for a spec-first build -> review -> fix loop

Usage:
  crossfire doctor [--json]
  crossfire check [--base <ref>] [--focus <text>] [--spec <file>] [--grok auto|on|off] [--name <id>]
                                       review the current branch once (no builder, no loop): a PR review
                 [--since <earlier check id>]   re-check: which earlier findings are fixed, still open, new
  crossfire checks                     list the checks in this repository
  crossfire watch (--pr <n> | --branch <name>) [--remote origin] [--interval-sec 120] [--timeout-min 720]
                 [--from <login>]... [--comments off] [--ack <ID|all>]... [--ack-only] [--reset-cursor]
                 [--repo OWNER/NAME]   (when the remote's URL is not a GitHub address)
                                       wait until the PR's head moves, a comment needs handling (from --from
                                       people only, if given), or it closes; then exit. Comments are shown
                                       until acknowledged with --ack (at least once, never lost)
  crossfire spec --slug <slug>         where to write the spec and plan (git ignores them), and this repo's memory
  crossfire spec-review --slug <slug> --spec <file> [--plan <file>] [--base <ref>] [--grok auto|on|off]
                                       prove the spec before any code: Codex (and Grok) review the spec and
                                       plan as a design; saves .crossfire/specs/<slug>.review.json and .md
  crossfire precedent add "<ruling>"   record a ruling the owner gave (only on the person's own words);
  crossfire precedents                 briefs and reviewers are told not to raise it again
  crossfire respec --from-loop <slug> --slug <new-slug> [--force]
                                       start over: draft a new spec from a finished loop, with every finding
                                       as a known failure mode; the new loop starts from the base
  crossfire memory                     what reviewers found in this repository before
  crossfire init --slug <slug> --spec <file> [--base <ref>] [--e2e <cmd>]... [--invariant <cmd>]...
                 [--max-rounds 2] [--max-minutes 45] [--grok auto|on|off] [--breaker on|off]
                 [--plan <file>] [--force] [--no-preflight] [--no-failure-modes] [--from-check <id>]
                                       --from-check: start at the fix round with that check's findings
                                       init first checks every proof command can run here (preflight)
                                       with a current spec review (lean): grok auto = first code pass only,
                                       breaker off (on with **Risk:** high), max-rounds 2; without one:
                                       grok every pass, breaker on, max-rounds 3. Flags always win.
  crossfire built --slug <slug>        record the builder's result file, run the proof commands (G0)
  crossfire attacked --slug <slug>     record the breaker's result (proven attacks get one harden round)
  crossfire proof --slug <slug> [--e2e <cmd>]... [--invariant <cmd>]...
                                       replace the proof commands of a running loop (when one cannot run here)
  crossfire review --slug <slug> [--timeout-min 20]
                                       run Codex (required) and Grok Build (optional), record findings
  crossfire status [--slug <slug>]     where a loop is, and its next action
  crossfire report --slug <slug>       print the ship or escalation report
  crossfire ladder --slug <slug> [--remote origin] [--branch <name>] [--repo OWNER/NAME]
                                       after SHIP: pushed, PR, CI, merged, as facts (reads only)

Every command prints a NEXT ACTION. Follow it; do not decide the next step yourself.
Global: --cwd <dir> (default: current directory), --json (machine-readable output).
Exit codes: 0 ok, 2 usage, 3 malformed (re-ask, nothing advanced), 4 loop already finished, 5 environment.`;

function parseArgs(argv) {
  const repeat = new Set(["e2e", "invariant", "from", "ack"]);
  const bool = new Set(["json", "force", "help", "no-preflight", "no-failure-modes", "reset-cursor", "ack-only", "version"]);
  const opts = { e2e: [], invariant: [], from: [], ack: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const [rawKey, inline] = a.slice(2).split(/=(.*)/s, 2);
    const key = rawKey;
    if (bool.has(key)) {
      opts[key] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new CrossfireError(`--${key} needs a value`);
    if (repeat.has(key)) opts[key].push(value);
    else opts[key] = value;
  }
  return { cmd: pos[0], rest: pos.slice(1), opts };
}

function intOpt(opts, key, fallback, min, max) {
  if (opts[key] === undefined) return fallback;
  const n = Number(opts[key]);
  if (!Number.isInteger(n) || n < min || n > max) throw new CrossfireError(`--${key} must be an integer from ${min} to ${max}`);
  return n;
}

function out(ctx, text, data) {
  if (ctx.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
}

/** Write whatever the next action needs (brief or report) and print it. */
/** A builder or breaker result sitting on disk that crossfire has not recorded: the loop is stalled. */
export function stalledResult(dir, state) {
  const next = state.next ?? {};
  const file = next.action === ACTIONS.SEND_BUILDER ? files.result(dir, state.round, next.brief) : next.action === ACTIONS.SEND_BREAKER ? files.breakerResult(dir, state.round) : null;
  if (!file || !fs.existsSync(file)) return null;
  const at = fs.statSync(file).mtime;
  // A result crossfire already turned down (malformed) is not stalled until it is written again.
  // One kept back because a proof command could not run is due again once the proof commands change.
  let seen = null;
  let seenKind = null;
  for (const h of state.history ?? []) {
    const t = Date.parse(h.at);
    if (!Number.isFinite(t)) continue;
    if (["malformed", "breaker-malformed", "proof-env-failed"].includes(h.event)) {
      seen = t;
      seenKind = h.event;
    } else if (h.event === "proof-commands-changed" && seenKind === "proof-env-failed") seen = null;
  }
  if (seen != null && seen >= at.getTime()) return null;
  const minutes = Math.max(0, Math.round((Date.now() - at.getTime()) / 60000));
  const then = next.action === ACTIONS.SEND_BUILDER ? "built" : "attacked";
  return { file, minutes, line: `STALLED: the ${next.action === ACTIONS.SEND_BUILDER ? "builder" : "breaker"} wrote its result ${minutes} min ago (${at.toISOString().slice(11, 16)}Z) and crossfire has not recorded it: run crossfire ${then} --slug ${state.slug} now` };
}

/** A finished result that sat unrecorded for 5 minutes or more is a stall: log how long. */
function noteResultWait(state, file, at, who) {
  if (!fs.existsSync(file)) return;
  const minutes = Math.round((Date.parse(at) - fs.statSync(file).mtime.getTime()) / 60000);
  const last = [...(state.history ?? [])].reverse().find((h) => h.event === "result-unrecorded" && h.file === file);
  if (minutes >= 5 && !last) state.history.push({ at, event: "result-unrecorded", detail: `the ${who} result waited ${minutes} min before crossfire recorded it`, minutes, file });
}

function emitNext(ctx, dir, state, extra = []) {
  const minutes = minutesBetween(state.startedAt);
  const next = state.next;
  const stalled = isTerminal(state) ? null : stalledResult(dir, state);
  const lines = [statusLine(state, minutes), ...(stalled ? [stalled.line] : []), ...extra];
  const data = { slug: state.slug, phase: state.phase, round: state.round, reviewPass: state.reviewPass, next, stalled: stalled ? { file: stalled.file, minutes: stalled.minutes } : null };

  if (next.action === ACTIONS.SEND_BUILDER) {
    const brief = files.brief(dir, state.round, next.brief);
    const result = files.result(dir, state.round, next.brief);
    if (!fs.existsSync(brief)) writeText(brief, renderBrief(state, { resultFile: result, branch: git.branch(state.repo), failures: next.failures, lessons: lessonsBlock(state.repo), precedents: precedentsBlock(state.repo) }));
    lines.push(`NEXT ACTION: SEND_BUILDER (${next.brief})`, `BRIEF: ${brief}`, `RESULT FILE: ${result}`, `THEN: crossfire built --slug ${state.slug}`);
    Object.assign(data, { brief, resultFile: result, then: `crossfire built --slug ${state.slug}` });
  } else if (next.action === ACTIONS.SEND_BREAKER) {
    const brief = files.breakerBrief(dir, state.round);
    const result = files.breakerResult(dir, state.round);
    if (!fs.existsSync(brief)) writeText(brief, renderBreakerBrief(state, { resultFile: result, branch: git.branch(state.repo), head: git.head(state.repo), lessons: lessonsBlock(state.repo), precedents: precedentsBlock(state.repo) }));
    lines.push("NEXT ACTION: SEND_BREAKER", `BRIEF: ${brief}`, `RESULT FILE: ${result}`, `THEN: crossfire attacked --slug ${state.slug}`);
    Object.assign(data, { brief, resultFile: result, then: `crossfire attacked --slug ${state.slug}` });
  } else if (next.action === ACTIONS.RUN_REVIEW) {
    lines.push(`NEXT ACTION: RUN_REVIEW (pass ${next.pass})`, `THEN: crossfire review --slug ${state.slug}`);
    data.then = `crossfire review --slug ${state.slug}`;
  } else {
    if (!state.memoryWritten) {
      try {
        appendLessons(state.repo, lessonsFromLoop(state));
      } catch {
        /* memory is advisory */
      }
      state.memoryWritten = true;
      saveState(dir, state);
    }
    const report = files.report(dir);
    writeText(report, renderReport(state, { minutesElapsed: minutes, changedFiles: git.changedFiles(state.repo, state.baseSha), head: git.head(state.repo), reviewersText: reviewersLine(state) }));
    lines.push(`NEXT ACTION: ${next.action}`);
    lines.push(`REVIEWERS: ${reviewersLine(state)}`);
    data.reviewers = reviewersLine(state);
    if (next.gate) lines.push(`GATE: ${next.gate}`);
    lines.push(`REASON: ${next.reason}`, `REPORT: ${report}`);
    Object.assign(data, { report });
  }
  out(ctx, lines.join("\n"), data);
}

/** "codex 2/2 passes, grok 0/2 (failed: ...)" */
export function reviewersLine(state) {
  const runs = state.reviewerRuns ?? [];
  const passes = state.reviewPass || 0;
  if (!passes) return "no review ran";
  const names = [...new Set(["codex", ...runs.map((r) => r.reviewer)])];
  return names
    .map((name) => {
      const mine = runs.filter((r) => r.reviewer === name);
      const ok = mine.filter((r) => r.ok).length;
      const fail = [...mine].reverse().find((r) => !r.ok);
      const last = [...mine].reverse().find((r) => r.ok);
      const verdict = last?.verdict && last.verdict !== "approve" ? ` (last verdict: ${last.verdict})` : "";
      const label = fail?.notRun ? "not run" : fail?.autoSkip ? "skipped" : fail?.skipped ? "not usable" : "failed";
      return `${name} ${ok}/${passes} passes${verdict}${ok < passes && fail ? ` (${label}: ${fail.error})` : ""}`;
    })
    .join(", ");
}

/**
 * Does Grok review this pass? { run, line (printed when it does not), record (a reviewerRuns entry
 * when it does not) }. `--grok on` always runs (the caller has checked it is usable). Under auto:
 * a 1.4 lean loop runs it on its first code pass only, a reviewer that is not usable is noted, and
 * one that failed its last 3 attempts on this machine in the last 7 days is skipped without a call.
 */
export function grokFor({ grok, plugins, state = null, pass = null, health = readHealth() }) {
  if (grok === "off") return { run: false, line: null, record: null };
  if (grok === "on") return { run: true, line: null, record: null };
  if (state?.policy === 2 && state.decided?.grokPasses === "first" && pass !== state.firstCodePass) {
    return { run: false, line: `grok: not run on pass ${pass} (auto: first code pass only)`, record: { reviewer: "grok", ok: false, notRun: true, error: "auto, first code pass only" } };
  }
  if (!usable(plugins.grok)) return { run: false, line: null, record: { reviewer: "grok", ok: false, skipped: true, error: plugins.grok.problems[0] ?? "not installed" } };
  const skip = autoSkip(health, "grok");
  if (skip) return { run: false, line: skip.line, record: { reviewer: "grok", ok: false, skipped: true, autoSkip: true, error: `failed the last ${skip.failures} times on this machine` } };
  return { run: true, line: null, record: null };
}

function requireLoop(cwd, slug) {
  if (!slug) throw new CrossfireError("--slug is required");
  const dir = runDir(cwd, slug);
  return { dir, state: loadState(dir) };
}

function requireNext(state, action) {
  if (isTerminal(state)) throw new CrossfireError(`loop ${state.slug} already ${state.phase}; see \`crossfire report --slug ${state.slug}\``, EXIT.TERMINAL);
  if (state.next.action !== action) {
    throw new CrossfireError(`loop ${state.slug} is waiting for ${state.next.action}, not ${action}; run \`crossfire status --slug ${state.slug}\``);
  }
}

// ---- doctor --------------------------------------------------------------

/** "ok" when Codex's own sandbox can run a command here, else the first error line. */
function codexSandboxStatus() {
  const hook = process.env.CROSSFIRE_ASSUME_CODEX_SANDBOX;
  if (hook) return hook === "1" ? "ok" : hook;
  const r = run("codex", ["sandbox", "--", "true"], { timeoutMs: 30_000 });
  if (r.error?.code === "ENOENT") return "the codex CLI is not on PATH";
  if (r.status === 0) return "ok";
  return ((r.stderr || r.stdout).trim().split("\n").find(Boolean) || `exit ${r.status}`).slice(0, 200);
}

/** "ok", "missing", or the reason bubblewrap cannot create a user-namespace sandbox. */
function bwrapStatus() {
  // Test hook only: "1" = works, "0" = missing, anything else = that failure text.
  const hook = process.env.CROSSFIRE_ASSUME_BWRAP;
  if (hook) return hook === "1" ? "ok" : hook === "0" ? "missing" : hook;
  const r = run("bwrap", ["--unshare-user", "--ro-bind", "/", "/", "true"], { timeoutMs: 10_000 });
  if (r.error?.code === "ENOENT") return "missing";
  if (r.status === 0) return "ok";
  return (r.stderr.trim().split("\n")[0] || `exit ${r.status}`).slice(0, 200);
}

function doctor(ctx) {
  const plugins = locatePlugins();
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: nodeMajor >= 18, required: true, detail: `node ${process.versions.node} (need 18.18+)` });
  for (const key of ["codex", "grok", "superpowers"]) {
    const p = plugins[key];
    const spec = OFFICIAL[key];
    let ok = usable(p);
    let detail = ok ? `${spec.id} ${p.version} from ${spec.repo}` : p.problems.join("; ") || `${spec.id} is not installed`;
    let install = spec.install;
    if (ok && spec.readyCommand) {
      const r = readiness(p, ctx.cwd);
      if (!r.ready) {
        ok = false;
        const steps = r.detail?.nextSteps?.join(" ") || r.detail?.error || "the vendor's readiness check failed";
        detail = `${spec.id} ${p.version} installed, but not ready: ${steps}`;
        install = []; // installed: the vendor's own next steps above are what is missing
      }
    }
    // Codex reads the diff by running git in its own sandbox; where that sandbox cannot start
    // (Linux with user namespaces blocked), it reviews anything but a tiny diff blind.
    if (ok && key === "codex") {
      const sb = codexSandboxStatus();
      if (sb !== "ok") {
        ok = false;
        detail = `${spec.id} ${p.version} is logged in, but Codex's sandbox cannot run commands here (${sb}), so it cannot read a real diff and reviews come back blind.${process.platform === "linux" ? " On Ubuntu 23.10+ this is AppArmor's unprivileged user namespace restriction (see the crossfire README, \"Codex and Grok on Linux\")." : ""}`;
        install = [];
      }
    }
    // Grok Build's read-only sandbox needs a working bubblewrap on Linux; without it every review is refused.
    if (ok && key === "grok" && process.platform === "linux") {
      const sandbox = bwrapStatus();
      if (sandbox !== "ok") {
        ok = false;
        if (sandbox === "missing") {
          detail = `${spec.id} ${p.version} installed and logged in, but its read-only review sandbox needs bubblewrap, which is missing`;
          install = ["sudo apt install -y bubblewrap   (or your distribution's bubblewrap package)"];
        } else {
          detail = `${spec.id} ${p.version} installed and logged in, but bubblewrap cannot start a sandbox here (${sandbox}). On Ubuntu 23.10+ this is AppArmor's unprivileged user namespace restriction`;
          install = ["an owner decision: allow /usr/bin/bwrap user namespaces with an AppArmor profile (see the crossfire README, \"Codex and Grok on Linux\")"];
        }
      }
    }
    if (ok && (key === "codex" || key === "grok")) {
      const h = summarize(readHealth(), key);
      if (h.consecutiveFailures >= 2) {
        ok = false;
        detail = `${spec.id} ${p.version} looks ready, but its last ${h.consecutiveFailures} reviews on this machine failed (latest ${h.lastFailAt}): ${h.lastError}`;
        install = [];
      } else if (key === "grok" && !h.lastOkAt && grokSocketHint()) {
        ok = false;
        detail = `${spec.id} ${p.version} looks ready, but ${grokSocketHint()}; it has never completed a review on this machine`;
        install = [];
      }
    }
    checks.push({ name: key, ok, required: spec.required, detail, install: ok ? [] : install });
  }
  const skew = versionSkew(VERSION, plugins.installedSelf);
  if (skew) checks.unshift({ name: "crossfire", ok: false, required: false, detail: skew });
  const ready = checks.every((c) => c.ok || !c.required);
  const lines = [`crossfire ${VERSION} doctor: ${ready ? "READY" : "NOT READY"}`];
  for (const c of checks) {
    lines.push(`${c.ok ? "ok  " : c.required ? "FAIL" : "warn"} ${c.name.padEnd(11)} ${c.detail}`);
    for (const step of c.install ?? []) lines.push(`       ${step}`);
  }
  if (!checks.find((c) => c.name === "grok").ok) lines.push("", "Grok Build is optional: with it, the spec review and the first code review pass get a second, independent reviewer (every pass with --grok on, or in a loop without a current spec review).");
  out(ctx, lines.join("\n"), { version: VERSION, ready, checks });
  return ready ? EXIT.OK : EXIT.ENVIRONMENT;
}

// ---- init ----------------------------------------------------------------

function init(ctx, opts) {
  const slug = opts.slug;
  if (!slug) throw new CrossfireError("--slug is required");
  if (!opts.spec) throw new CrossfireError("--spec is required (the spec file the builder and reviewers work from)");
  const repo = git.repoRoot(ctx.cwd);
  const spec = path.resolve(ctx.cwd, opts.spec);
  if (!fs.existsSync(spec)) throw new CrossfireError(`spec not found: ${spec}`);
  const base = opts.base ?? git.defaultBase(repo);
  if (!base) throw new CrossfireError("could not find a base branch; pass --base <ref>");
  const baseSha = git.resolveRef(repo, base);
  if (!baseSha) throw new CrossfireError(`base ${base} does not resolve to a commit`);
  const specRel = path.relative(repo, spec);
  if (!specRel.startsWith("..") && git.changedFiles(repo, baseSha).includes(specRel.split(path.sep).join("/"))) {
    throw new CrossfireError(`the spec ${specRel} is committed on this branch, so reviewers would review it as code. Take it out of the branch (git rm --cached ${specRel}, then amend or commit), and next time run \`crossfire spec --slug ${slug}\` before writing it.`);
  }
  const grok = opts.grok ?? "auto";
  if (!["auto", "on", "off"].includes(grok)) throw new CrossfireError("--grok must be auto, on or off");
  let fromCheck = null;
  if (opts["from-check"]) {
    fromCheck = loadCheck(repo, opts["from-check"]);
    if (fromCheck.approved) throw new CrossfireError(`check ${fromCheck.id} approved the branch: there is nothing to fix`);
    const head = git.head(repo);
    if (head !== fromCheck.head) throw new CrossfireError(`the branch moved since check ${fromCheck.id} (checked ${fromCheck.head.slice(0, 12)}, now ${head.slice(0, 12)}); its findings may be stale. Run crossfire check again.`);
    if (fromCheck.baseSha !== baseSha) throw new CrossfireError(`check ${fromCheck.id} reviewed against ${fromCheck.base} (${fromCheck.baseSha.slice(0, 12)}), not ${base} (${baseSha.slice(0, 12)}); use the same --base, or run crossfire check again`);
  }
  if (opts.breaker !== undefined && !["on", "off"].includes(opts.breaker)) throw new CrossfireError("--breaker must be on or off");
  const plan = opts.plan ? path.resolve(ctx.cwd, opts.plan) : null;
  if (plan && !fs.existsSync(plan)) throw new CrossfireError(`plan not found: ${plan}`);
  if (plan && !path.relative(repo, plan).startsWith("..") && git.changedFiles(repo, baseSha).includes(path.relative(repo, plan).split(path.sep).join("/"))) {
    throw new CrossfireError(`the plan ${path.relative(repo, plan)} is committed on this branch, so reviewers would review it as code; keep it under .crossfire/specs/ (crossfire spec --slug ${slug} gives the path)`);
  }
  if (!opts["no-failure-modes"]) {
    const modes = Math.max(countFailureModes(fs.readFileSync(spec, "utf8")), plan ? countFailureModes(fs.readFileSync(plan, "utf8")) : -1);
    if (modes < 3) {
      throw new CrossfireError(`neither the spec's "## How this could fail" nor the plan's "## Review Focus" lists at least 3 failure modes (found ${Math.max(modes, 0)}): concrete ways this change could go wrong (transactions and rollback, stale in-memory state, concurrency, retries, ordering, missing data), each with a test. That is the reviewers' first question, so the spec or plan asks it first. For a trivial change, pass --no-failure-modes.`);
    }
  }

  const plugins = locatePlugins();
  if (!usable(plugins.codex)) {
    throw new CrossfireError(`the Codex reviewer is required and not usable: ${plugins.codex.problems.join("; ") || "codex@openai-codex is not installed"}. Run \`crossfire doctor\`.`, EXIT.ENVIRONMENT);
  }
  let preflight = "skipped (--no-preflight)";
  let preflightMinutes = null;
  const proofCommands = [...opts.e2e, ...opts.invariant];
  if (!opts["no-preflight"] && proofCommands.length) {
    // Before any build: every proof command must at least be able to run here.
    // Failing because the feature is not built yet is expected and fine.
    const preStart = Date.now();
    const pre = runCommands(proofCommands, repo, 10 * 60 * 1000);
    preflightMinutes = (Date.now() - preStart) / 60000;
    const env = pre.failures.filter((f) => f.kind === "environment");
    if (env.length) {
      throw new CrossfireError(`preflight: ${env.length} proof command(s) cannot run in this environment, so the builder could never make them pass:\n${envFailureText(pre.failures)}\nFix the command (toolchain, PATH, version manager) and run init again. Nothing was started.`, EXIT.ENVIRONMENT);
    }
    preflight = `${proofCommands.length} proof command(s) can run here${pre.failures.length ? ` (${pre.failures.length} fail before the build, as expected)` : ""}`;
  }
  if (grok === "on" && !usable(plugins.grok)) {
    throw new CrossfireError(`--grok on, but Grok Build is not usable: ${plugins.grok.problems.join("; ") || "grok-build@xai-grok-build is not installed"}`, EXIT.ENVIRONMENT);
  }

  // Is this the spec the reviewers proved? Only then do the lean defaults apply (never blocks).
  const specBytes = fs.readFileSync(spec);
  const reviewFiles = specReviewFiles(path.join(crossfireRoot(repo), "specs"), slug);
  const specReview = specReviewStatus({ review: readSpecReview(reviewFiles.json), spec: specBytes, plan: plan ? fs.readFileSync(plan) : null, responseFile: reviewFiles.response });
  const lean = specReview.status === "current" || specReview.status === "revised";
  const decided = { lean, grokPasses: grok === "off" ? "none" : grok === "on" || !lean ? "every" : "first" };
  let breaker;
  if (opts.breaker !== undefined) [breaker, decided.breakerFrom] = [opts.breaker === "on", "--breaker"];
  else if (!lean) [breaker, decided.breakerFrom] = [true, "no current spec review"];
  else if (riskHigh(specBytes.toString("utf8"))) [breaker, decided.breakerFrom] = [true, "the spec's Risk: high"];
  else [breaker, decided.breakerFrom] = [false, "lean default"];
  const maxRounds = intOpt(opts, "max-rounds", lean ? 2 : 3, 1, 10);
  decided.maxRoundsFrom = opts["max-rounds"] !== undefined ? "--max-rounds" : lean ? "lean default" : "no current spec review";

  ensureExcluded(repo);
  const dir = runDir(ctx.cwd, slug);
  return withLock(dir, () => {
    if (fs.existsSync(files.state(dir))) {
      const old = loadState(dir);
      if (!isTerminal(old) && !opts.force) throw new CrossfireError(`loop ${slug} is still running (${old.phase}); pass --force to archive it and start over`);
      const archived = `${dir}.archived-${nowIso().replace(/[:.]/g, "")}`;
      fs.mkdirSync(archived, { recursive: true });
      for (const f of fs.readdirSync(dir)) if (f !== ".lock") fs.renameSync(path.join(dir, f), path.join(archived, f));
    }
    const state = newState({
      slug,
      repo,
      spec,
      base,
      baseSha,
      e2e: opts.e2e,
      invariants: opts.invariant,
      maxRounds,
      maxMinutes: intOpt(opts, "max-minutes", 45, 5, 24 * 60),
      grok,
      breaker,
      startedAt: nowIso(),
    });
    state.plan = plan;
    // The spec as approved here is what the referee grants and judges by for the whole loop (the
    // allowed test changes, the reviewers' SPEC); the spec file itself stays writable by the builder.
    const snapshot = files.specSnapshot(dir);
    fs.writeFileSync(snapshot, specBytes);
    state.specSnapshot = { file: snapshot, sha256: sha256(specBytes) };
    // 1.4: the settings this loop decided, read from state from now on (a loop without policy is a 1.3 loop).
    state.policy = 2;
    state.decided = decided;
    state.specReview = { status: specReview.status, at: specReview.at, findings: specReview.findings, line: specReview.line, file: reviewFiles.json, responseFile: specReview.responseFile ?? null };
    // --max-rounds counts the builder legs crossfire runs: a --from-check loop's pull request is not one,
    // and Grok's first code pass is the first pass crossfire runs (the check was pass 1).
    state.roundOffset = fromCheck ? 1 : 0;
    state.firstCodePass = fromCheck ? 2 : 1;
    state.branch = git.branch(repo); // the ladder reads this branch after SHIP
    state.history.push({ at: state.startedAt, event: "init", detail: `base ${base} (${baseSha.slice(0, 12)}), spec ${spec}; preflight: ${preflight}` });
    state.history.push({ at: state.startedAt, event: "spec-review", detail: `${specReview.line}; ${settingsText(state)}` });
    if (fromCheck) {
      // The check was review pass 1 of the branch as it stands: the loop starts at its fix round.
      state.phase = "review";
      state.reviewerRuns = fromCheck.reviewerRuns;
      state.history.push({ at: state.startedAt, event: "from-check", detail: `${fromCheck.id}: ${fromCheck.findings.length} finding(s) at ${fromCheck.head.slice(0, 12)}` });
      afterReview(state, fromCheck.reviews, { at: state.startedAt, minutesElapsed: 0 });
    }
    saveState(dir, state);
    const skew = versionSkew(VERSION, plugins.installedSelf);
    const proofCount = state.e2e.length + state.invariants.length;
    const heavy = [];
    if (proofCount > 6) heavy.push(`${proofCount} proof commands`);
    if (preflightMinutes != null && preflightMinutes > 5) heavy.push(`a ${Math.round(preflightMinutes)}-minute first run`);
    emitNext(ctx, dir, state, [
      specReview.line,
      ...(specReview.note ? [`NOTE: ${specReview.note}`] : []),
      ...(lean ? [] : ["WARNING: no current spec review; using the full review defaults. Run crossfire spec-review first to use the lean ones."]),
      `SETTINGS: ${settingsText(state)}`,
      `PREFLIGHT: ${preflight}`,
      ...(heavy.length ? [`WARNING: ${heavy.join(" and ")}; they run on every builder round. Keep proof commands to what this change touches (the tests for the code it changes, plus a check it must not break); the full suite is CI's job on the pull request.`] : []),
      "AGENTS: this loop needs 2 concurrent agents: you, and one builder or breaker at a time. With a cap of N concurrent agents, run at most N/2 loops at once.",
      ...(skew ? [`WARNING: ${skew}`] : []),
    ]);
    return EXIT.OK;
  });
}

// ---- spec ----------------------------------------------------------------

function specCmd(ctx, opts) {
  if (!opts.slug) throw new CrossfireError("--slug is required");
  runDir(ctx.cwd, opts.slug); // validates the slug
  const repo = git.repoRoot(ctx.cwd);
  ensureExcluded(repo);
  const file = path.join(crossfireRoot(repo), "specs", `${opts.slug}.md`);
  const planFile = path.join(crossfireRoot(repo), "specs", `${opts.slug}.plan.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const template = fileURLToPath(new URL("../skills/loop/references/spec-template.md", import.meta.url));
  const lessons = readLessons(repo, 30);
  out(ctx, [
    `SPEC FILE: ${file}${fs.existsSync(file) ? " (exists)" : ""}`,
    `PLAN FILE: ${planFile}${fs.existsSync(planFile) ? " (exists)" : ""}  (superpowers:writing-plans output goes here, not under docs/)`,
    `TEMPLATE: ${template}`,
    `MEMORY: ${lessons.length ? `${lessons.length} earlier finding(s) in ${memoryFile(repo)}; use them in the spec's failure modes and the plan's Review Focus` : "none yet for this repository"}`,
    ...lessons.map((l) => `  ${l}`),
    "git ignores .crossfire/, so spec and plan are never committed. Then: crossfire init --spec <spec> --plan <plan>.",
  ].join("\n"), { specFile: file, planFile, exists: fs.existsSync(file), template, memory: lessons });
  return EXIT.OK;
}

// ---- spec-review (prove the spec before any code) ---------------------------

/**
 * Run `fn(worktree)` in a throwaway worktree on the base, with the spec (and plan) committed at
 * crossfire-spec-review/<slug>.md on a throwaway branch, so a reviewer's diff against the base is
 * exactly those documents. The worktree, its directory and the branch are removed afterwards,
 * whatever happens; the user's branch, working tree and index are never touched.
 */
function withSpecWorktree(repo, baseSha, slug, specBytes, planBytes, fn) {
  // No hooks: nothing of the user's runs for crossfire's own throwaway commit.
  const g = (cwd, args) => run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd });
  const firstLine = (r) => (r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n")[0];
  const branch = `crossfire/spec-review-${slug}-${Date.now()}-${process.pid}`;
  if (git.resolveRef(repo, `refs/heads/${branch}`)) throw new CrossfireError(`branch ${branch} already exists; run spec-review again`, EXIT.ENVIRONMENT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crossfire-spec-review-"));
  const wt = path.join(tmp, "wt");
  let added = false;
  try {
    const add = g(repo, ["worktree", "add", "-q", "-b", branch, wt, baseSha]);
    if (add.status !== 0) throw new CrossfireError(`could not create the spec review worktree: ${firstLine(add)}`, EXIT.ENVIRONMENT);
    added = true;
    const dir = path.join(wt, SPEC_REVIEW_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.md`), specBytes);
    if (planBytes) fs.writeFileSync(path.join(dir, `${slug}.plan.md`), planBytes);
    const stage = g(wt, ["add", "-f", "--", SPEC_REVIEW_DIR]);
    if (stage.status !== 0) throw new CrossfireError(`could not stage the spec in the review worktree: ${firstLine(stage)}`, EXIT.ENVIRONMENT);
    const commit = g(wt, ["-c", "user.name=crossfire", "-c", "user.email=crossfire@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", `crossfire spec review: ${slug}`]);
    if (commit.status !== 0) throw new CrossfireError(`could not commit the spec in the review worktree: ${firstLine(commit)}`, EXIT.ENVIRONMENT);
    // Fail closed: a reviewer must never be handed an empty diff.
    if (g(wt, ["diff", "--quiet", baseSha, "HEAD", "--", SPEC_REVIEW_DIR]).status !== 1) throw new CrossfireError("the spec review commit is empty; nothing was reviewed", EXIT.ENVIRONMENT);
    return fn(wt);
  } finally {
    if (added) g(repo, ["worktree", "remove", "--force", wt]);
    fs.rmSync(tmp, { recursive: true, force: true });
    g(repo, ["worktree", "prune"]);
    if (git.resolveRef(repo, `refs/heads/${branch}`)) g(repo, ["branch", "-D", branch]);
  }
}

function specReviewCmd(ctx, opts) {
  const slug = opts.slug;
  if (!slug) throw new CrossfireError("--slug is required");
  runDir(ctx.cwd, slug); // validates the slug
  if (!opts.spec) throw new CrossfireError("--spec is required (the spec to review)");
  const repo = git.repoRoot(ctx.cwd);
  const spec = path.resolve(ctx.cwd, opts.spec);
  if (!fs.existsSync(spec)) throw new CrossfireError(`spec not found: ${spec}`);
  const plan = opts.plan ? path.resolve(ctx.cwd, opts.plan) : null;
  if (plan && !fs.existsSync(plan)) throw new CrossfireError(`plan not found: ${plan}`);
  const base = opts.base ?? git.defaultBase(repo);
  if (!base) throw new CrossfireError("could not find a base branch; pass --base <ref>");
  const baseSha = git.resolveRef(repo, base);
  if (!baseSha) throw new CrossfireError(`base ${base} does not resolve to a commit`);
  const grok = opts.grok ?? "auto";
  if (!["auto", "on", "off"].includes(grok)) throw new CrossfireError("--grok must be auto, on or off");
  const timeoutMs = opts["timeout-sec"] !== undefined ? intOpt(opts, "timeout-sec", 60, 1, 7200) * 1000 : intOpt(opts, "timeout-min", 20, 1, 120) * 60 * 1000;

  const plugins = locatePlugins();
  if (!usable(plugins.codex)) throw new CrossfireError(`the Codex reviewer is required and not usable: ${plugins.codex.problems.join("; ") || "codex@openai-codex is not installed"}. Run \`crossfire doctor\`.`, EXIT.ENVIRONMENT);
  if (grok === "on" && !usable(plugins.grok)) throw new CrossfireError(`--grok on, but Grok Build is not usable: ${plugins.grok.problems.join("; ") || "grok-build@xai-grok-build is not installed"}`, EXIT.ENVIRONMENT);
  const grokPlan = grokFor({ grok, plugins });
  const reviewers = [plugins.codex, ...(grokPlan.run ? [plugins.grok] : [])];

  ensureExcluded(repo);
  const specsDir = path.join(crossfireRoot(repo), "specs");
  const out_ = specReviewFiles(specsDir, slug);
  const specBytes = fs.readFileSync(spec);
  const planBytes = plan ? fs.readFileSync(plan) : null;
  const focus = buildSpecFocus({ slug, base, hasPlan: Boolean(plan), precedents: readPrecedents(repo) });
  const results = withSpecWorktree(repo, baseSha, slug, specBytes, planBytes, (wt) => reviewers.map((p) => runReviewer(p, { cwd: wt, base: baseSha, focus, timeoutMs })));
  const at = nowIso();
  for (const r of results) recordAttempt(r.reviewer, { ok: r.ok, at, seconds: r.seconds, error: r.error });
  const reviewerRuns = results.map((r) => ({ pass: 1, reviewer: r.reviewer, ok: r.ok, seconds: r.seconds, verdict: r.verdict ?? null, findings: r.ok ? r.findings.length : null, error: r.ok ? null : String(r.error).split("\n")[0].slice(0, 300) }));
  if (grokPlan.record) reviewerRuns.push({ pass: 1, ...grokPlan.record });
  const reviewersText = reviewersLine({ reviewPass: 1, reviewerRuns });
  const codex = results.find((r) => r.reviewer === "codex");
  if (!codex.ok) {
    out(ctx, [`SPEC REVIEW ${slug}: the Codex review failed: ${codex.error}`, "Nothing was saved. Run crossfire spec-review again; if it keeps failing, run crossfire doctor."].join("\n"), { slug, error: codex.error });
    return EXIT.MALFORMED;
  }
  const findings = collectFindings(results.filter((r) => r.ok));
  const record = { version: 1, slug, at, repo, spec, plan, base, baseSha, specSha256: sha256(specBytes), planSha256: planBytes ? sha256(planBytes) : null, reviewers: reviewerRuns, reviewersText, findings, responseFile: out_.response };
  atomicWriteJson(out_.json, record);
  writeText(out_.md, renderSpecReviewMd(record));
  const sev = (f) => f.reviewerSeverity ?? f.severity;
  const counts = ["high", "medium", "low"].map((x) => `${findings.filter((f) => (["critical", "high"].includes(String(sev(f)).toLowerCase()) ? "high" : String(sev(f)).toLowerCase() === "medium" ? "medium" : "low") === x).length} ${x}`).join(", ");
  const lines = [
    `SPEC REVIEW ${slug} · ${spec}${plan ? ` + ${plan}` : ""} against ${base} (${baseSha.slice(0, 12)})`,
    `REVIEWERS: ${reviewersText}`,
    ...(grokPlan.line ? [grokPlan.line] : []),
    ...results.filter((r) => !r.ok).map((r) => `WARNING: ${r.reviewer} did not review (${r.error}); this spec review rests on Codex alone.`),
    `FINDINGS: ${findings.length ? `${findings.length} (${counts})` : "none"}`,
    ...findings.map((f, i) => `  ${i + 1}. ${sev(f)} ${f.file ?? ""}${f.lineStart ? `:${f.lineStart}` : ""} ${f.title} (${f.reviewers.join("+")})`),
    `REVIEW: ${out_.json}`,
    `REPORT: ${out_.md}`,
    `NEXT: revise the spec for each finding, write ${out_.response} (one line per finding: how it was addressed, or why not), and show the person the revised spec with the findings and responses. Then crossfire init reports it as revised after review.`,
  ];
  out(ctx, lines.join("\n"), { slug, review: out_.json, report: out_.md, findings, reviewers: reviewersText, responseFile: out_.response });
  return EXIT.OK;
}

// ---- precedents ------------------------------------------------------------

function precedentCmd(ctx, rest) {
  if (rest[0] !== "add") throw new CrossfireError("usage: crossfire precedent add \"<the person's ruling, in one sentence>\"");
  const repo = git.repoRoot(ctx.cwd);
  const line = appendPrecedent(repo, rest.slice(1).join(" "));
  out(ctx, [`PRECEDENT: ${line}`, `FILE: ${precedentsFile(repo)}`, "Builders, the breaker and reviewers are told not to raise it again (the latest 30)."].join("\n"), { line, file: precedentsFile(repo) });
  return EXIT.OK;
}

function precedentsCmd(ctx) {
  const repo = git.repoRoot(ctx.cwd);
  const lines = readPrecedents(repo, 10_000);
  out(ctx, lines.length ? [`PRECEDENTS ${precedentsFile(repo)} (${lines.length}; prompts carry the latest 30)`, ...lines].join("\n") : "No precedents in this repository: the owner adds them with crossfire precedent add.", { file: precedentsFile(repo), precedents: lines });
  return EXIT.OK;
}

// ---- built ---------------------------------------------------------------

function runCommands(commands, repo, timeoutMs) {
  const failures = [];
  const log = [];
  for (const command of commands) {
    const r = runShell(command, { cwd: repo, timeoutMs });
    const output = tail(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`, 6000);
    log.push(`$ ${command}\n(exit ${r.timedOut ? "timeout" : r.status})\n${output}\n`);
    if (r.status !== 0 || r.timedOut) {
      const status = r.timedOut ? "timeout" : r.status;
      failures.push({ command, status, output, kind: r.timedOut ? "code" : classifyProofFailure({ status, output }) });
    }
  }
  return { passed: failures.length === 0, failures, log: log.join("\n") };
}

function runProof(state, dir) {
  const result = runCommands([...state.e2e, ...state.invariants], state.repo, 30 * 60 * 1000);
  writeText(files.g0(dir, state.round), result.log || "(no proof commands declared)\n");
  return result;
}

function envFailureText(failures) {
  return failures
    .filter((f) => f.kind === "environment")
    .map((f) => `- \`${f.command}\` exited ${f.status}:\n${f.output.split("\n").filter(Boolean).slice(0, 4).map((l) => `    ${l}`).join("\n")}`)
    .join("\n");
}

/**
 * The spec as approved at init: its snapshot, checked against the sha256 recorded then. Null for a
 * loop started before 1.4 (no snapshot). A snapshot that is gone or changed throws (fail closed).
 */
function approvedSpec(state) {
  if (!state.specSnapshot) return null;
  const { file, sha256: want } = state.specSnapshot;
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    bytes = null;
  }
  if (!bytes || sha256(bytes) !== want) throw new CrossfireError(`the spec as approved at init (${file}) is missing or no longer matches the sha256 recorded then; nothing is judged against a changed spec. Restore it, or start a new loop from the revised spec (crossfire respec).`);
  return bytes.toString("utf8");
}

function built(ctx, opts) {
  const { dir } = requireLoop(ctx.cwd, opts.slug);
  return withLock(dir, () => {
    const state = loadState(dir);
    requireNext(state, ACTIONS.SEND_BUILDER);
    const kind = state.next.brief;
    const resultFile = files.result(dir, state.round, kind);
    const key = `build-r${state.round}-${kind}`;
    const at = nowIso();
    noteResultWait(state, resultFile, at, "builder");

    let result = null;
    let problems = [];
    if (!fs.existsSync(resultFile)) problems = [`no result file at ${resultFile}`];
    else {
      try {
        result = readJsonFile(resultFile);
      } catch (e) {
        problems = [`result file is not valid JSON: ${e.message}`];
      }
    }
    if (result) {
      problems = validateBuildResult(result, state, {
        head: git.head(state.repo),
        dirty: git.dirtyPaths(state.repo),
        ahead: git.commitsAhead(state.repo, state.baseSha),
      });
      // The builder never weakens tests: read from the branch itself, not from the result.
      if (!problems.length && result.status === "DONE") {
        // Exemptions come from the spec as approved at init, never from the file as it is now. A loop
        // without a snapshot (started before 1.4) has none.
        let specText = "";
        try {
          specText = approvedSpec(state) ?? "";
        } catch (e) {
          problems = [e.message];
        }
        if (!problems.length) problems = testChanges(state.repo, state.baseSha, specText).problems.map((p) => `weakens tests: ${p} (existing test files are not changed unless the spec allows it; add new tests in new files; a file the "## Allowed test changes" section of the spec as approved at init names is exempt)`);
      }
    }
    if (problems.length) {
      const esc = noteMalformed(state, key, problems.join("; "), at);
      saveState(dir, state);
      if (esc) {
        emitNext(ctx, dir, state);
        return EXIT.OK;
      }
      out(ctx, [statusLine(state, minutesBetween(state.startedAt)), "MALFORMED: the builder's result was not accepted (nothing advanced).", ...problems.map((p) => `- ${p}`), `RE-ASK: send the builder back to ${files.brief(dir, state.round, kind)} with the problems above, then run crossfire built --slug ${state.slug} again. A second malformed result escalates (G1).`].join("\n"), { malformed: true, problems });
      return EXIT.MALFORMED;
    }

    if (result.status === "SPEC_MISMATCH") {
      // The spec does not fit: no proof command runs and nothing in the ledger changes; the owner decides.
      afterBuild(state, result, null, { at, minutesElapsed: minutesBetween(state.startedAt) });
      saveState(dir, state);
      emitNext(ctx, dir, state, [`SPEC MISMATCH (${result.handoff.severity}): ${result.handoff.summary.split("\n")[0].slice(0, 300)}`, "No proof command ran. Show the person the handoff in the report; revising the spec (crossfire respec) is their call."]);
      return EXIT.OK;
    }

    const builtRound = state.round;
    state.lastBuildHead = git.head(state.repo);
    const g0 = runProof(state, dir);
    if (g0.failures.some((f) => f.kind === "environment")) {
      // The command cannot run here: not the builder's fault, so no round is spent.
      state.history.push({ at, event: "proof-env-failed", detail: g0.failures.filter((f) => f.kind === "environment").map((f) => f.command).join(" ; ") });
      saveState(dir, state);
      out(ctx, [statusLine(state, minutesBetween(state.startedAt)), "PROOF ENVIRONMENT: a proof command cannot run here (toolchain or PATH), so this is not the builder's fault. Nothing advanced; the builder's result is kept.", envFailureText(g0.failures), `FIX: crossfire proof --slug ${state.slug} --e2e "<working command>" [--invariant "<working command>"]... then run crossfire built --slug ${state.slug} again.`, `LOG: ${files.g0(dir, builtRound)}`].join("\n"), { environment: true, failures: g0.failures.filter((f) => f.kind === "environment") });
      return EXIT.ENVIRONMENT;
    }
    // Evidence for the report: what crossfire itself ran, and which tests the builder named.
    state.lastProof = { round: builtRound, at, commands: [...state.e2e, ...state.invariants].map((command) => ({ command, status: g0.failures.find((f) => f.command === command)?.status ?? 0 })) };
    state.testsNamed = [...new Set([...(state.testsNamed ?? []), ...(Array.isArray(result.tests) ? result.tests : []).map((t) => t?.name), ...(Array.isArray(result.fixes) ? result.fixes : []).flatMap((f) => (Array.isArray(f?.variants) ? f.variants : []).map((v) => v?.test))].filter(Boolean))];
    afterBuild(state, result, g0, { at, minutesElapsed: minutesBetween(state.startedAt) });
    saveState(dir, state);
    const proofCount = state.e2e.length + state.invariants.length;
    const extra = [`G0: ${proofCount === 0 ? "no proof commands declared" : g0.passed ? "all proof commands passed" : `${g0.failures.length} of ${proofCount} proof command(s) failed`} (${files.g0(dir, builtRound)})`];
    emitNext(ctx, dir, state, extra);
    return EXIT.OK;
  });
}

// ---- check (review only) -------------------------------------------------

function checksDir(repo) {
  return path.join(crossfireRoot(repo), "checks");
}

function loadCheck(repo, id) {
  const file = path.join(checksDir(repo), id, "check.json");
  if (!fs.existsSync(file)) throw new CrossfireError(`no check "${id}" in this repository; see crossfire checks`);
  return readJsonFile(file);
}

function check(ctx, opts) {
  const repo = git.repoRoot(ctx.cwd);
  const base = opts.base ?? git.defaultBase(repo);
  if (!base) throw new CrossfireError("could not find a base branch; pass --base <ref>");
  const baseSha = git.resolveRef(repo, base);
  if (!baseSha) throw new CrossfireError(`base ${base} does not resolve to a commit`);
  const dirty = git.dirtyPaths(repo);
  if (dirty.length) throw new CrossfireError(`the working tree has uncommitted changes (${dirty[0]}...); reviewers only see commits. Commit or stash, then check again.`);
  if (git.commitsAhead(repo, baseSha) < 1) throw new CrossfireError(`nothing to review: no commits on top of ${base}`);
  const grok = opts.grok ?? "auto";
  if (!["auto", "on", "off"].includes(grok)) throw new CrossfireError("--grok must be auto, on or off");

  const plugins = locatePlugins();
  if (!usable(plugins.codex)) throw new CrossfireError(`the Codex reviewer is required and not usable: ${plugins.codex.problems.join("; ") || "codex@openai-codex is not installed"}. Run \`crossfire doctor\`.`, EXIT.ENVIRONMENT);
  if (grok === "on" && !usable(plugins.grok)) throw new CrossfireError(`--grok on, but Grok Build is not usable: ${plugins.grok.problems.join("; ")}`, EXIT.ENVIRONMENT);
  const grokPlan = grokFor({ grok, plugins });
  const reviewers = [plugins.codex, ...(grokPlan.run ? [plugins.grok] : [])];

  ensureExcluded(repo);
  const head = git.head(repo);
  const branch = git.branch(repo);
  const at = nowIso();
  const id = opts.name ?? `${String(branch ?? "head").replace(/[^a-z0-9._-]+/gi, "-").toLowerCase().slice(0, 40)}-${head.slice(0, 8)}`;
  runDir(ctx.cwd, id); // validates the id as a slug
  const dir = path.join(checksDir(repo), id);
  const specText = opts.spec ? fs.readFileSync(path.resolve(ctx.cwd, opts.spec), "utf8") : "";
  const prev = opts.since ? loadCheck(repo, opts.since) : null;
  if (prev && prev.head === head) throw new CrossfireError(`nothing new since check ${prev.id}: the branch is still at ${head.slice(0, 12)}`);
  if (prev && opts.name === undefined && id === prev.id) throw new CrossfireError("pass --name for the re-check; it must differ from the earlier check");
  const focus = buildCheckFocus({ base, specText, focusText: opts.focus ?? prev?.focus ?? "", previous: prev?.findings ?? [], precedents: readPrecedents(repo) });
  const timeoutMs = intOpt(opts, "timeout-min", 20, 1, 120) * 60 * 1000;
  const size = diffSize(repo, baseSha);
  const tooBig = sizeWarning(size);

  const results = reviewers.map((p) => {
    return runReviewer(p, { cwd: repo, base: baseSha, focus, timeoutMs });
  });
  const reviewerRuns = results.map((r) => ({ pass: 1, reviewer: r.reviewer, ok: r.ok, seconds: r.seconds, verdict: r.verdict ?? null, findings: r.ok ? r.findings.length : null, error: r.ok ? null : String(r.error).split("\n")[0].slice(0, 300) }));
  if (grokPlan.record) reviewerRuns.push({ pass: 1, ...grokPlan.record });
  const reviewersText = reviewersLine({ reviewPass: 1, reviewerRuns });

  if (git.head(repo) !== head) {
    out(ctx, `CHECK ${id}: the branch moved while the reviewers were reading it (${head.slice(0, 12)} -> ${String(git.head(repo)).slice(0, 12)}); nothing was recorded. Run crossfire check again.`, { id, discarded: true });
    return EXIT.MALFORMED;
  }
  for (const r of results) {
    recordAttempt(r.reviewer, { ok: r.ok, at, seconds: r.seconds, error: r.error });
    atomicWriteJson(path.join(dir, `review-${r.reviewer}.json`), r);
  }
  const codex = results.find((r) => r.reviewer === "codex");
  if (!codex.ok) {
    out(ctx, [`CHECK ${id}: the Codex review failed: ${codex.error}`, "Nothing was recorded as a review. Run crossfire check again; if it keeps failing, run crossfire doctor."].join("\n"), { id, error: codex.error });
    return EXIT.MALFORMED;
  }
  const ok = results.filter((r) => r.ok);
  const findings = collectFindings(ok);
  let since = null;
  if (prev) {
    const d = compareWithPrevious(prev.findings, findings);
    since = { id: prev.id, head: prev.head, resolved: d.resolved, stillOpen: d.stillOpen, unclear: d.unclear, fresh: d.fresh.length, near: d.fresh.filter((f) => f.nearPrevious).map((f) => ({ title: f.title, near: f.nearPrevious.map((n) => `P${n}`).join(", ") })) };
  }
  const record = { version: 1, id, at, repo, branch, head, base, baseSha, focus: opts.focus ?? prev?.focus ?? null, spec: opts.spec ? path.resolve(ctx.cwd, opts.spec) : null, reviewerRuns, reviewersText, reviews: ok, findings, approved: findings.length === 0, since, size: size ? { ...size, warning: Boolean(tooBig) } : null };
  atomicWriteJson(path.join(dir, "check.json"), record);
  try {
    appendLessons(repo, lessonsFromCheck(record));
  } catch {
    /* memory is advisory */
  }
  const report = path.join(dir, "report.md");
  writeText(report, renderCheckReport(record));

  const counts = ["BLOCKER", "CHANGES", "NIT"].map((sev) => `${findings.filter((f) => f.severity === sev).length} ${sev.toLowerCase()}`).join(", ");
  const lines = [
    `CHECK ${id} · ${branch ?? "HEAD"} ${head.slice(0, 12)} against ${base}`,
    `REVIEWERS: ${reviewersText}`,
    ...(grokPlan.line ? [grokPlan.line] : []),
    ...(tooBig ? [tooBig] : []),
    ...results.filter((r) => !r.ok).map((r) => `WARNING: ${r.reviewer} did not review (${r.error}); this check rests on Codex alone.`),
    ...(since ? [`SINCE ${since.id} (${since.head.slice(0, 12)}): ${since.resolved.length} fixed, ${since.stillOpen.length} still open, ${since.unclear.length} unclear, ${since.fresh} new`, ...since.resolved.map((p) => `  fixed: [P${p.index}] ${p.title}`), ...since.stillOpen.map((s) => `  still open: [P${s.previous.index}] ${s.previous.title}`), ...since.unclear.map((p) => `  unclear: [P${p.index}] ${p.title} (a new finding is near it; read both)`), ...since.near.map((n) => `  new (near ${n.near}): ${n.title}`)] : []),
    `VERDICT: ${findings.length ? `${findings.length} finding(s): ${counts}` : "APPROVED, nothing to fix"}`,
    ...findings.map((f, i) => `  ${i + 1}. ${f.severity} ${f.file ?? ""}${f.lineStart ? `:${f.lineStart}` : ""} ${f.title} (${f.reviewers.join("+")})`),
    `REPORT: ${report}`,
  ];
  if (findings.length) lines.push(`TO FIX WITH A LOOP: write a spec (crossfire spec --slug <slug>), then crossfire init --slug <slug> --spec <file> --base ${base} --from-check ${id} [--e2e <cmd>]...`);
  out(ctx, lines.join("\n"), { id, report, approved: record.approved, findings, reviewers: reviewersText });
  return EXIT.OK;
}

function memoryCmd(ctx) {
  const repo = git.repoRoot(ctx.cwd);
  const lines = readLessons(repo, 200);
  out(ctx, lines.length ? [`MEMORY ${memoryFile(repo)} (${lines.length})`, ...lines].join("\n") : "No memory yet for this repository: it fills in as loops finish and checks run.", { file: memoryFile(repo), lessons: lines });
  return EXIT.OK;
}

function checks(ctx) {
  const repo = git.repoRoot(ctx.cwd);
  const root = checksDir(repo);
  const list = fs.existsSync(root) ? fs.readdirSync(root).filter((id) => fs.existsSync(path.join(root, id, "check.json"))).map((id) => readJsonFile(path.join(root, id, "check.json"))) : [];
  list.sort((a, b) => a.at.localeCompare(b.at));
  out(ctx, list.length ? list.map((c) => `${c.at.slice(0, 16)} ${c.id} · ${c.approved ? "approved" : `${c.findings.length} finding(s)`} · ${c.reviewersText}`).join("\n") : "No checks in this repository.", { checks: list.map((c) => ({ id: c.id, at: c.at, approved: c.approved, findings: c.findings.length })) });
  return EXIT.OK;
}

// ---- watch ----------------------------------------------------------------

function watch(ctx, opts) {
  const repo = git.repoRoot(ctx.cwd);
  if (!opts.pr === !opts.branch) throw new CrossfireError("give exactly one of --pr <number> or --branch <name>");
  if (opts.pr && !/^\d+$/.test(String(opts.pr))) throw new CrossfireError("--pr must be a pull request number");
  const remote = opts.remote ?? "origin";
  const ref = opts.pr ? `refs/pull/${opts.pr}/head` : `refs/heads/${opts.branch}`;
  const label = opts.pr ? `PR #${opts.pr}` : `branch ${opts.branch}`;
  const acks = opts.ack;

  // The inbox: acknowledged comment ids and pending deliveries, per PR. The lock is taken
  // before the inbox is read, and held through every change to it, on every path.
  const started = Date.now();
  // GitHub timestamps have second resolution: a comment in the start's own second is new.
  const startIso = new Date(Math.floor(started / 1000) * 1000).toISOString().replace(".000Z", "Z");
  let file = null;
  let inbox = null;
  if (opts.pr) {
    ensureExcluded(repo);
    file = W.inboxFile(crossfireRoot(repo), remote, opts.pr);
    const lock = W.acquireLock(`${file}.lock`);
    if (lock.heldBy) throw new CrossfireError(`PR #${opts.pr} is already being watched (process ${lock.heldBy}); one watcher per PR. Stop it first, or wait for it.`, EXIT.ENVIRONMENT);
    inbox = (opts["reset-cursor"] ? null : W.loadInbox(file)) ?? W.newInbox(startIso);
    W.saveInbox(file, inbox); // the first watch's start is the baseline from now on, even if GitHub is down
  }
  if (acks.length) {
    if (!opts.pr) throw new CrossfireError("--ack applies to PR comments: use it with --pr");
    const n = W.acknowledge(inbox, acks);
    W.saveInbox(file, inbox);
    process.stderr.write(`crossfire watch ${label}: acknowledged ${n} comment(s); ${inbox.pending.length} still pending\n`);
    if (opts["ack-only"]) return EXIT.OK;
  }
  const commentsOn = Boolean(opts.pr) && opts.comments !== "off";

  const deliver = (pending, sha) => {
    // Saved first, printed second: if anything dies in between, the next run shows them again.
    W.saveInbox(file, inbox);
    if (process.env.CROSSFIRE_TEST_DIE_BEFORE_PRINT === "1") process.exit(9);
    const lines = [`WATCH ${label}: ${pending.length} comment(s) to handle`];
    // The full body, never cut: a comment is acknowledged as handled, so all of it must be seen.
    for (const c of pending) lines.push("", `ID: ${c.id}`, `COMMENT by ${c.user} (${c.kind}, ${c.at}) ${c.url ?? ""}`, c.body.trim() || "(no text)");
    lines.push("", `NEXT: handle each comment per the review skill, then acknowledge the handled ones while watching again: crossfire watch --pr ${opts.pr} --ack <ID>... (or --ack all). Unacknowledged comments are shown again.`);
    out(ctx, lines.join("\n"), { status: "comment", from: sha, ref, comments: pending });
    return EXIT.OK;
  };

  // Comments already saved for delivery go out first: they are local, so no outage can hold them back.
  if (commentsOn && inbox.pending.length) return deliver(inbox.pending.slice(), opts.since ?? null);

  const intervalMs = intOpt(opts, "interval-sec", 120, 1, 3600) * 1000;
  const timeoutMs = opts["timeout-sec"] !== undefined ? intOpt(opts, "timeout-sec", 60, 1, 7 * 24 * 3600) * 1000 : intOpt(opts, "timeout-min", 720, 1, 7 * 24 * 60) * 60 * 1000;
  const first = W.remoteSha(repo, remote, ref);
  if (first.error) throw new CrossfireError(`cannot read ${ref} from ${remote}: ${first.error}`, EXIT.ENVIRONMENT);
  if (!first.sha) throw new CrossfireError(`${remote} has no ${ref}`);
  // The last head the session acknowledged is the baseline, so a push that lands while a
  // comment is being handled is still reported after the restart. First watch: today's head.
  if (inbox && !inbox.head) {
    inbox.head = opts.since ?? first.sha;
    W.saveInbox(file, inbox);
  }
  const from = opts.since ?? inbox?.head ?? first.sha;

  let watching = false;
  let target = null;
  let note = "comments: not watched (--comments off)";
  if (opts.pr) {
    // The PR's repository is resolved for closure checks too, whether or not comments are watched.
    const t = W.resolveGh(repo, remote, opts.repo ?? null);
    if (!t.error) target = t;
    else process.stderr.write(`crossfire watch ${label}: PR comments and closure not watched: ${t.error}\n`);
    if (commentsOn && t.error && t.permanent) note = `comments: not watched (${t.error})`;
    else if (commentsOn) {
      watching = true;
      note = `comments: watched${opts.from.length ? ` from ${opts.from.join(", ")}` : ""} in ${target?.nwo ?? "(resolving)"}${t.error ? ` (gh failed at start: ${t.error}; retrying every poll)` : ""}`;
    }
  } else if (!opts.pr) note = "comments: not watched (branch, not a PR)";
  process.stderr.write(`crossfire watch ${label}: head ${from.slice(0, 12)}; ${note}\n`);

  let errors = 0;
  let lastGhError = null;
  let current = first.sha;
  for (;;) {
    if (current && !current.startsWith(from) && !from.startsWith(current)) {
      if (inbox) W.saveInbox(file, inbox);
      out(ctx, [`WATCH ${label}: CHANGED ${from.slice(0, 12)} -> ${current.slice(0, 12)}`, ...(opts.pr ? [`ID: head:${current}`] : []), `NEXT: update the review worktree to ${current.slice(0, 12)} (fetch ${remote} ${ref}), then crossfire check --since <last check id> --name <new id>, then watch again${opts.pr ? ` acknowledging it: --ack head:${current}` : ""}. Until acknowledged, this push is reported again.`].join("\n"), { status: "changed", from, to: current, ref, id: opts.pr ? `head:${current}` : null });
      return EXIT.OK;
    }
    if (watching) {
      if (!target) {
        const t = W.resolveGh(repo, remote, opts.repo ?? null);
        if (!t.error) target = t;
        else lastGhError = t.error;
      }
      const now = target ? W.prComments(repo, target, opts.pr) : { error: lastGhError };
      if (now.error && now.permanent) {
        // e.g. gh missing, not logged in, or the PR not found: retrying cannot help. Keep watching pushes.
        watching = false;
        process.stderr.write(`crossfire watch ${label}: comments: no longer watched (${now.error}); still watching pushes and closure\n`);
        lastGhError = now.error;
      } else if (now.error && lastGhError === null) {
        process.stderr.write(`crossfire watch ${label}: comments: gh failing (${now.error}); retrying every poll\n`);
        lastGhError = now.error;
      } else if (!now.error) {
        W.applyBaseline(inbox, now.comments);
        const pending = W.takeDeliveries(inbox, now.comments, { from: opts.from });
        if (pending.length) return deliver(pending, from);
        W.saveInbox(file, inbox);
      } else lastGhError = now.error;
    }
    if (opts.pr && target) {
      const st = W.prState(repo, target, opts.pr);
      if (st && st !== "OPEN") {
        out(ctx, `WATCH ${label}: ${st}; stopped watching`, { status: st.toLowerCase(), from, ref });
        return EXIT.OK;
      }
    }
    if (Date.now() - started >= timeoutMs) {
      const span = timeoutMs < 60000 ? `${Math.round(timeoutMs / 1000)} s` : `${Math.round(timeoutMs / 60000)} min`;
      out(ctx, `WATCH ${label}: no new commits or comments in ${span} (still ${from.slice(0, 12)})${lastGhError && watching ? `; gh kept failing: ${lastGhError}` : ""}; stopped watching`, { status: "timeout", from, ref, ghError: lastGhError });
      return EXIT.TERMINAL;
    }
    W.sleepMs(intervalMs);
    const next = W.remoteSha(repo, remote, ref);
    if (next.error) {
      errors += 1;
      if (errors >= 10) throw new CrossfireError(`cannot read ${ref} from ${remote} (10 tries in a row): ${next.error}`, EXIT.ENVIRONMENT);
      continue;
    }
    errors = 0;
    current = next.sha;
    if (!current) {
      out(ctx, `WATCH ${label}: ${ref} is gone from ${remote} (deleted or closed); stopped watching`, { status: "gone", from, ref });
      return EXIT.OK;
    }
  }
}

// ---- attacked (breaker result) ---------------------------------------------

function attacked(ctx, opts) {
  const { dir } = requireLoop(ctx.cwd, opts.slug);
  return withLock(dir, () => {
    const state = loadState(dir);
    requireNext(state, ACTIONS.SEND_BREAKER);
    const at = nowIso();
    const file = files.breakerResult(dir, state.round);
    noteResultWait(state, file, at, "breaker");
    let problems = [];
    let attacks = [];
    let result = null;
    if (!fs.existsSync(file)) problems = [`no result file at ${file}`];
    else {
      try {
        result = readJsonFile(file);
        ({ problems, attacks } = validateBreakerResult(result));
      } catch (e) {
        problems = [`result file is not valid JSON: ${e.message}`];
      }
    }
    const dirty = git.dirtyPaths(state.repo);
    if (dirty.length) problems.push(`the breaker changed the working tree (${dirty[0]}...); it must only use a throwaway worktree. Restore the tree before continuing.`);
    const headMoved = Boolean(state.lastBuildHead && git.head(state.repo) !== state.lastBuildHead);
    if (headMoved) problems.push(`HEAD moved from the builder's commit ${state.lastBuildHead.slice(0, 12)}; the breaker must not commit. Restore the branch to that commit before continuing.`);

    if (problems.length) {
      state.breakerMalformed = (state.breakerMalformed ?? 0) + 1;
      state.history.push({ at, event: "breaker-malformed", detail: problems.join("; ") });
      // An integrity breach (a changed tree or HEAD) never falls through to the
      // "skip the breaker" fallback: the branch must be restored first, every time.
      if (state.breakerMalformed < 2 || dirty.length || headMoved) {
        saveState(dir, state);
        out(ctx, [statusLine(state, minutesBetween(state.startedAt)), "MALFORMED: the breaker's result was not accepted (nothing advanced).", ...problems.map((p) => `- ${p}`), `RE-ASK: send the breaker back to ${files.breakerBrief(dir, state.round)} with the problems above, then run crossfire attacked --slug ${state.slug} again.`].join("\n"), { malformed: true, problems });
        return EXIT.MALFORMED;
      }
      // The breaker is internal: a second malformed result skips it instead of stopping the loop.
      state.history.push({ at, event: "breaker-skipped", detail: "malformed twice; going to review without it" });
      attacks = [];
    } else if (result?.status === "FAILED") {
      state.history.push({ at, event: "breaker-failed", detail: String(result.summary ?? "").slice(0, 300) });
    }
    state.breakerMalformed = 0;
    afterBreak(state, attacks, { at, minutesElapsed: minutesBetween(state.startedAt) });
    saveState(dir, state);
    emitNext(ctx, dir, state, [`BREAKER: ${attacks.length} proven attack(s)${attacks.length ? `: ${attacks.map((a) => a.title).join(" | ").slice(0, 300)}` : ""}`]);
    return EXIT.OK;
  });
}

/** Items under the spec's "## How this could fail" heading; -1 when the section is missing. */
export function countFailureModes(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s*(how (this|it) could fail|review focus)\b/i.test(l.trim()));
  if (start === -1) return -1;
  let n = 0;
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l)) break;
    if (/^\s*(?:[-*]|\d+[.)])\s+\S/.test(l)) n += 1;
  }
  return n;
}

// ---- respec (start over from a rewritten spec) ----------------------------

/**
 * Draft a new spec from a finished loop: the old spec plus every finding and proven attack as a
 * known failure mode the new loop must test from the start. Writes only the draft; no git.
 */
export function renderRespec(old, specText) {
  const loc = (e) => (e.file ? `${e.file}${e.lineStart ? `:${e.lineStart}` : ""}` : "no location");
  // The evidence itself (scenario, failing test, rule), indented under its item so it stays one list item.
  const detail = (text, label) => {
    const t = String(text ?? "").trim();
    if (!t) return "";
    return `\n  > ${label}: ${t.replace(/\n+/g, "\n  > ")}`;
  };
  const known = (old.ledger ?? []).filter((e) => e.severity !== "NIT").map((e) => {
    const rule = [...(e.history ?? [])].reverse().find((h) => h.rule)?.rule;
    const fixAt = [...(e.history ?? [])].reverse().find((h) => h.builder && h.where)?.where;
    const reflag = [...(e.history ?? [])].reverse().find((h) => h.reflagged);
    const again = reflag?.reflagged;
    return `- (known from loop ${old.slug}, ${e.id} ${e.severity}, ${e.source === "breaker" ? "proven by the breaker" : `found by ${(e.reviewers ?? []).join(" + ")}`}) ${e.title} [${loc(e)}]${rule ? ` Rule the fix had to enforce: ${rule}.` : ""}${fixAt ? ` The last attempt fixed it at ${fixAt}.` : ""}${again ? ` A reviewer re-flagged that fix: ${again}.` : ""} Status when the loop stopped: ${e.status}. This loop tests it from the start.${detail(e.body, "What was found")}${detail(e.recommendation, "Recommended")}${reflag ? detail(`${reflag.where ? `at ${reflag.where}: ` : ""}${reflag.body ?? ""}`, "What defeated the last fix") : ""}`;
  });
  const header = [
    `<!-- crossfire respec: drafted from loop "${old.slug}" (${old.terminal?.kind ?? old.phase}${old.terminal?.gate ? ` at ${old.terminal.gate}` : ""}). Review and simplify it with the person who owns the change before crossfire init. -->`,
    "",
  ];
  const restart = [
    "",
    `## Starting over from loop ${old.slug}`,
    "",
    `- The previous attempt is a reference only: its branch is not merged and this loop does not build on it. Start from \`${old.base}\`.`,
    "- Where the known failure modes cluster, prefer a simpler design over more guards. Name what you removed or changed in the design, and why it avoids those failures.",
    "",
  ];
  const lines = String(specText ?? "").split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s*how (this|it) could fail\b/i.test(l.trim()));
  if (start === -1) return [...header, ...lines, ...restart, "## How this could fail", "", ...known, ""].join("\n");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^#{1,3}\s/.test(lines[i])) {
    end = i;
    break;
  }
  while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
  return [...header, ...lines.slice(0, end), ...known, ...lines.slice(end), ...restart].join("\n");
}

function respec(ctx, opts) {
  if (!opts["from-loop"]) throw new CrossfireError("--from-loop <slug> is required: the loop to start over from");
  if (!opts.slug) throw new CrossfireError("--slug <new-slug> is required: the new loop's name");
  if (opts.slug === opts["from-loop"]) throw new CrossfireError("the new loop needs its own --slug");
  const { state: old } = requireLoop(ctx.cwd, opts["from-loop"]);
  if (!isTerminal(old)) throw new CrossfireError(`loop ${old.slug} is still running (${old.phase}); start over only after it ships or escalates`);
  runDir(ctx.cwd, opts.slug); // validates the slug
  const repo = git.repoRoot(ctx.cwd);
  ensureExcluded(repo);
  const file = path.join(crossfireRoot(repo), "specs", `${opts.slug}.md`);
  if (fs.existsSync(file) && !opts.force) throw new CrossfireError(`${file} exists; pass --force to overwrite it`);
  if (!old.spec || !fs.existsSync(old.spec)) throw new CrossfireError(`loop ${old.slug}'s spec ${old.spec ?? "(none recorded)"} is gone; write the new spec by hand from crossfire report --slug ${old.slug}`);
  const draft = renderRespec(old, readSpec(old.spec));
  writeText(file, draft);
  const known = (old.ledger ?? []).filter((e) => e.severity !== "NIT").length;
  out(ctx, [
    `RESPEC ${old.slug} -> ${opts.slug}`,
    `SPEC FILE: ${file} (draft: the old spec plus ${known} known failure mode(s) and a "Starting over" section)`,
    `NEXT: review and simplify the draft with the person who owns the change, get their yes, then start from the base, not from ${old.slug}'s branch:`,
    `  git switch -c <new-branch> ${old.base}`,
    `  crossfire init --slug ${opts.slug} --spec ${file} --base ${old.base} [--e2e <cmd>]...`,
    "Nothing else changed: no branch, no loop, no commit.",
  ].join("\n"), { from: old.slug, slug: opts.slug, specFile: file, known, base: old.base });
  return EXIT.OK;
}

// ---- proof ---------------------------------------------------------------

function proof(ctx, opts) {
  const { dir } = requireLoop(ctx.cwd, opts.slug);
  if (!opts.e2e.length && !opts.invariant.length) throw new CrossfireError("give the full new set: --e2e <cmd>... and/or --invariant <cmd>...");
  return withLock(dir, () => {
    const state = loadState(dir);
    if (isTerminal(state)) throw new CrossfireError(`loop ${state.slug} already ${state.phase}`, EXIT.TERMINAL);
    if (state.next?.action !== ACTIONS.SEND_BUILDER) {
      throw new CrossfireError(`proof commands can change only while the builder is next (this loop is waiting for ${state.next?.action}), so the new commands run on the next crossfire built before any review.`);
    }
    const before = [...state.e2e, ...state.invariants].join(" ; ");
    state.e2e = opts.e2e;
    state.invariants = opts.invariant;
    state.history.push({ at: nowIso(), event: "proof-commands-changed", detail: `was: ${before}` });
    saveState(dir, state);
    emitNext(ctx, dir, state, ["PROOF: commands replaced; the loop continues where it was."]);
    return EXIT.OK;
  });
}

// ---- review --------------------------------------------------------------

function review(ctx, opts) {
  const { dir } = requireLoop(ctx.cwd, opts.slug);
  const timeoutMs = intOpt(opts, "timeout-min", 20, 1, 120) * 60 * 1000;
  return withLock(dir, () => {
    const state = loadState(dir);
    requireNext(state, ACTIONS.RUN_REVIEW);
    const dirty = git.dirtyPaths(state.repo);
    if (dirty.length) throw new CrossfireError(`the working tree has uncommitted changes (${dirty[0]}...); reviewers only see commits. Commit or stash, then run review again.`);
    if (state.lastBuildHead && git.head(state.repo) !== state.lastBuildHead) {
      throw new CrossfireError(`HEAD is not the commit the proof commands verified (${state.lastBuildHead.slice(0, 12)}); only a verified commit is reviewed. Restore the branch to it, or record a new builder round first.`);
    }

    const plugins = locatePlugins();
    if (!usable(plugins.codex)) {
      throw new CrossfireError(`the Codex reviewer is required and not usable: ${plugins.codex.problems.join("; ")}. Run \`crossfire doctor\`, fix it, then run review again (nothing advanced).`, EXIT.ENVIRONMENT);
    }
    if (state.grok === "on" && !usable(plugins.grok)) {
      throw new CrossfireError(`this loop requires Grok Build (--grok on) and it is not usable: ${plugins.grok.problems.join("; ")}`, EXIT.ENVIRONMENT);
    }

    const pass = state.reviewPass + 1;
    const grokPlan = grokFor({ grok: state.grok, plugins, state, pass });
    const reviewers = [plugins.codex, ...(grokPlan.run ? [plugins.grok] : [])];
    const size = diffSize(state.repo, state.baseSha);
    const tooBig = sizeWarning(size);
    const focus = buildFocus(state, { specText: approvedSpec(state) ?? readSpec(state.spec), precedents: readPrecedents(state.repo) });
    const results = reviewers.map((p) => runReviewer(p, { cwd: state.repo, base: state.baseSha, focus, timeoutMs }));
    const at = nowIso(); // the timeline records when the reviews finished, not when they started

    // Reviewers read the live checkout: if HEAD moved meanwhile, they may have read another
    // commit. Discard them before anything is recorded; nothing advances.
    if (state.lastBuildHead && git.head(state.repo) !== state.lastBuildHead) {
      state.history.push({ at, event: "review-discarded", detail: "HEAD moved during the review" });
      saveState(dir, state);
      out(ctx, [statusLine(state, minutesBetween(state.startedAt)), `DISCARDED: HEAD moved while the reviewers were reading the branch (verified ${state.lastBuildHead.slice(0, 12)}, now ${String(git.head(state.repo)).slice(0, 12)}); their verdicts are not recorded. Restore the branch to the verified commit and run review again.`].join("\n"), { discarded: true });
      return EXIT.MALFORMED;
    }
    state.reviewerRuns ??= [];
    for (const r of results) {
      atomicWriteJson(files.review(dir, pass, r.reviewer), r);
      recordAttempt(r.reviewer, { ok: r.ok, at, seconds: r.seconds, error: r.error });
      state.reviewerRuns.push({ pass, reviewer: r.reviewer, ok: r.ok, seconds: r.seconds, verdict: r.verdict ?? null, findings: r.ok ? r.findings.length : null, error: r.ok ? null : String(r.error).split("\n")[0].slice(0, 300) });
    }
    if (grokPlan.record) state.reviewerRuns.push({ pass, ...grokPlan.record });
    const codex = results.find((r) => r.reviewer === "codex");
    if (!codex.ok) {
      const esc = noteMalformed(state, `review-p${pass}-codex`, codex.error, at);
      saveState(dir, state);
      if (esc) {
        emitNext(ctx, dir, state);
        return EXIT.OK;
      }
      out(ctx, [statusLine(state, minutesBetween(state.startedAt)), `MALFORMED: the Codex review failed (nothing advanced): ${codex.error}`, `RE-ASK: run crossfire review --slug ${state.slug} again. A second failure escalates (G1).`].join("\n"), { malformed: true, error: codex.error });
      return EXIT.MALFORMED;
    }
    const extra = results.map((r) => (r.ok ? `${r.reviewer}: ${r.verdict}, ${r.findings.length} finding(s) in ${r.seconds}s` : `${r.reviewer}: FAILED (${r.error}); continuing without it`));
    if (grokPlan.line) extra.push(grokPlan.line);
    if (tooBig) {
      extra.push(tooBig);
      (state.sizeWarnings ??= []).push({ pass, lines: size.lines, files: size.files });
    }
    const lone = results.filter((r) => !r.ok && !r.required).map((r) => r.reviewer);
    if (lone.length) extra.push(`WARNING: ${lone.join(", ")} did not review this pass, so this pass rests on Codex alone. Tell the user when you report.`);
    for (const r of results.filter((x) => !x.ok)) state.history.push({ at, event: `reviewer-failed:${r.reviewer}`, detail: r.error });
    afterReview(state, results.filter((r) => r.ok), { at, minutesElapsed: minutesBetween(state.startedAt) });
    saveState(dir, state);
    emitNext(ctx, dir, state, extra);
    return EXIT.OK;
  });
}

// ---- status / report -----------------------------------------------------

function status(ctx, opts) {
  if (!opts.slug) {
    const runs = listRuns(ctx.cwd);
    if (!runs.length) {
      out(ctx, "No crossfire loops in this repository.", { runs: [] });
      return EXIT.OK;
    }
    const rows = runs.map((s) => ({ s, stalled: isTerminal(s) ? null : stalledResult(runDir(ctx.cwd, s.slug), s) }));
    out(ctx, rows.map(({ s, stalled }) => `${statusLine(s, minutesBetween(s.startedAt))}${stalled ? `\n  ${stalled.line}` : ""}`).join("\n"), { runs: rows.map(({ s, stalled }) => ({ slug: s.slug, phase: s.phase, round: s.round, next: s.next, stalled: stalled ? { file: stalled.file, minutes: stalled.minutes } : null })) });
    return EXIT.OK;
  }
  const { dir, state } = requireLoop(ctx.cwd, opts.slug);
  emitNext(ctx, dir, state);
  return EXIT.OK;
}

function report(ctx, opts) {
  const { dir, state } = requireLoop(ctx.cwd, opts.slug);
  if (!isTerminal(state)) throw new CrossfireError(`loop ${state.slug} has not finished (${state.phase}); next action ${state.next.action}`);
  const file = files.report(dir);
  out(ctx, fs.readFileSync(file, "utf8"), { report: file, terminal: state.terminal });
  return EXIT.OK;
}

/**
 * CI for one commit: its check runs (GitHub Actions and apps, latest per name) and its commit
 * statuses (older integrations), plus required checks the PR still expects. Counted as pass,
 * fail, pending and skipping. { counts } or { error } (anything incomplete or unrecognised).
 */
function ciForCommit(target, sha, cwd, expected = []) {
  const api = (endpoint, jq) => run(W.ghBin(), W.ghArgs(target.gh, ["api", endpoint, "--paginate", "--jq", jq]), { cwd, timeoutMs: 30_000 });
  const pages = (r) => r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const fail = (r) => ({ error: (r.stderr || `exit ${r.status}`).trim().split("\n")[0] });
  const runsR = api(`repos/${target.nwo}/commits/${sha}/check-runs?filter=latest&per_page=100`, "{total: .total_count, rows: [.check_runs[] | {name, status, conclusion}]}");
  if (runsR.status !== 0) return fail(runsR);
  const statR = api(`repos/${target.nwo}/commits/${sha}/status?per_page=100`, "{total: .total_count, rows: [.statuses[] | {name: .context, state}]}");
  if (statR.status !== 0) return fail(statR);
  let runs;
  let stats;
  try {
    runs = pages(runsR);
    stats = pages(statR);
  } catch {
    return { error: "gh returned something that is not JSON" };
  }
  const rows = (ps) => ps.flatMap((p) => p.rows ?? []);
  const complete = (ps) => ps.length > 0 && rows(ps).length === Number(ps[0].total ?? -1);
  if (!complete(runs) || !complete(stats)) return { error: "GitHub returned fewer checks than it counts; the list is incomplete" };
  const items = [];
  for (const r of rows(runs)) {
    if (["queued", "in_progress", "waiting", "requested", "pending"].includes(r.status) || (r.status === "completed" && r.conclusion === "stale")) items.push(["run", r.name, "pending"]);
    else if (r.status !== "completed") return { error: `check ${r.name} has a status crossfire does not know (${r.status})` };
    else if (r.conclusion === "success") items.push(["run", r.name, "pass"]);
    else if (["neutral", "skipped"].includes(r.conclusion)) items.push(["run", r.name, "skipping"]);
    else if (["failure", "timed_out", "action_required", "cancelled", "startup_failure"].includes(r.conclusion)) items.push(["run", r.name, "fail"]);
    else return { error: `check ${r.name} finished with an outcome crossfire does not know (${r.conclusion})` };
  }
  for (const x of rows(stats)) {
    if (x.state === "success") items.push(["status", x.name, "pass"]);
    else if (x.state === "pending") items.push(["status", x.name, "pending"]);
    else if (["failure", "error"].includes(x.state)) items.push(["status", x.name, "fail"]);
    else return { error: `status ${x.name} has a state crossfire does not know (${x.state})` };
  }
  // Checks GitHub still awaits (not created yet, or a rerun queued over an earlier result) are
  // pending: they replace a settled row of the same kind and name, or are added.
  for (const { kind, name } of expected) {
    const row = items.find(([k, n]) => k === kind && n === name);
    if (row) row[2] = "pending";
    else items.push([kind, name, "pending"]);
  }
  const n = (b) => items.filter(([, , x]) => x === b).length;
  return { counts: { total: items.length, pass: n("pass"), fail: n("fail"), pending: n("pending"), skipping: n("skipping") } };
}

// ---- ladder (read-only, after SHIP) ---------------------------------------

/**
 * Where a shipped loop's commit is now: pushed, PR, CI, merged. It reports facts and
 * never recommends an action: what to do next is the person's call. Reads only; never
 * pushes, merges or posts. Whatever it cannot establish is printed as unknown.
 */
function ladder(ctx, opts) {
  const { state } = requireLoop(ctx.cwd, opts.slug);
  if (state.terminal?.kind !== "shipped") throw new CrossfireError(`loop ${state.slug} has not shipped (${state.phase}); the ladder starts at SHIP`);
  const remote = opts.remote ?? "origin";
  const shipHead = state.lastBuildHead;
  const branch = opts.branch ?? state.branch; // recorded at init; never the checkout you happen to be on
  // The loop's base as GitHub names it: "origin/main", "upstream/main" and "refs/heads/main" are "main".
  const remotes = run("git", ["remote"], { cwd: state.repo }).stdout.split("\n").map((x) => x.trim()).filter(Boolean);
  let base = String(state.base ?? "").replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
  const owner = remotes.find((r) => base.startsWith(`${r}/`));
  if (owner) base = base.slice(owner.length + 1);
  if (!shipHead) throw new CrossfireError("this loop recorded no shipped commit");
  if (!branch || branch === "HEAD") throw new CrossfireError("this loop has no recorded branch (started before 1.2.0, or on a detached HEAD): pass --branch <name>");
  const short = (sha) => String(sha ?? "").slice(0, 12);
  const shallow = run("git", ["rev-parse", "--is-shallow-repository"], { cwd: state.repo }).stdout.trim() === "true";
  /** true, false, or null (unknown: this clone lacks the commit, or its history is shallow). */
  const contains = (tip) => {
    if (!tip) return null;
    if (tip === shipHead) return true;
    const r = run("git", ["merge-base", "--is-ancestor", shipHead, tip], { cwd: state.repo });
    if (r.status === 0) return true;
    return r.status === 1 && !shallow ? false : null;
  };
  const rungs = [];
  const data = { slug: state.slug, branch, base, shipHead, remote, pushed: null, pr: null, ci: null, merged: null };

  // 1. pushed
  const rs = W.remoteSha(state.repo, remote, `refs/heads/${branch}`);
  if (rs.error) rungs.push(`1. pushed:  unknown (${rs.error})`);
  else if (!rs.sha) {
    data.pushed = false;
    rungs.push(`1. pushed:  no branch ${branch} on ${remote} (never pushed, or deleted after a merge)`);
  } else {
    data.pushed = contains(rs.sha);
    rungs.push(`1. pushed:  ${data.pushed === true ? (rs.sha === shipHead ? `yes (${remote}/${branch} at ${short(rs.sha)})` : `yes, with later commits on top (${remote}/${branch} at ${short(rs.sha)})`) : data.pushed === false ? `no (${remote}/${branch} is at ${short(rs.sha)}, which does not contain ${short(shipHead)})` : `unknown (${remote}/${branch} is at ${short(rs.sha)}; this clone ${shallow ? "is shallow" : "does not have that commit"}: fetch to compare)`}`);
  }

  // 2-4 through gh, on the watched remote's own repository (--repo only when it has none)
  const fromRemote = W.resolveGh(state.repo, remote, null);
  let target = fromRemote;
  if (opts.repo) {
    const explicit = W.resolveGh(state.repo, remote, opts.repo);
    if (!fromRemote.error && !explicit.error && explicit.nwo.toLowerCase() !== fromRemote.nwo.toLowerCase()) {
      throw new CrossfireError(`--repo ${opts.repo} is not ${remote}'s repository (${fromRemote.nwo}); the ladder reads the repository the branch is pushed to`);
    }
    if (fromRemote.error) target = explicit;
  }
  const LIMIT = 100;
  let prs = null;
  let why = null;
  if (target.error) why = target.error;
  else {
    const r = run(W.ghBin(), W.ghArgs(target.gh, ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,url,headRefOid,baseRefName,isDraft,isCrossRepository", "--limit", String(LIMIT)]), { cwd: state.repo, timeoutMs: 30_000 });
    try {
      prs = r.status === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      prs = null;
    }
    if (!Array.isArray(prs)) {
      prs = null;
      why = `gh: ${(r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n")[0]}`;
    }
  }
  if (!prs) {
    rungs.push(`2. PR:      unknown (${why})`, "3. CI:      unknown", "4. merged:  unknown");
  } else {
    // Every PR on this branch in this repository, forks included: ancestry decides which carry the commit.
    const own = prs.map((p) => ({ ...p, has: contains(p.headRefOid) }));
    const onBase = (p) => !base || p.baseRefName === base;
    const find = (pred) => own.find(pred) ?? null;
    const mergedHere = find((p) => p.state === "MERGED" && p.has === true && onBase(p));
    const mergedUnknown = find((p) => p.state === "MERGED" && p.has === null);
    const pr = mergedHere ?? mergedUnknown ?? find((p) => p.state === "OPEN" && p.has === true) ?? find((p) => p.state === "CLOSED" && p.has === true) ?? find((p) => p.state === "MERGED" && p.has === true) ?? find((p) => p.has === null);
    data.pr = pr;
    const truncatedList = prs.length >= LIMIT;
    const truncated = truncatedList ? ` (only the newest ${LIMIT} PRs on this branch were read)` : "";
    // Merged into the loop's base: yes if any PR shows it; unknown if a merged PR's ancestry or the list is incomplete.
    const mergedFact = mergedHere ? true : mergedUnknown || truncatedList ? null : false;
    const othersMerged = own.filter((p) => p !== pr && p.state === "MERGED" && p.has !== false);
    if (!pr) {
      const others = own.filter((p) => p.has === false);
      rungs.push(`2. PR:      none from ${branch} contains ${short(shipHead)}${others.length ? ` (other PRs on this branch: ${others.map((p) => `#${p.number} ${p.state.toLowerCase()}`).join(", ")})` : ""}${truncated}`, "3. CI:      -", `4. merged:  ${mergedFact === false ? "no" : "unknown"}`);
      data.merged = mergedFact;
    } else if (pr.has === null) {
      rungs.push(`2. PR:      #${pr.number} ${pr.state.toLowerCase()} into ${pr.baseRefName ?? "?"} ${pr.url}, head ${short(pr.headRefOid)}: unknown whether it contains ${short(shipHead)} (this clone ${shallow ? "is shallow" : "does not have that commit"}: fetch to compare)${truncated}`, "3. CI:      unknown", "4. merged:  unknown");
    } else {
      const extra = pr.headRefOid === shipHead ? "head is the shipped commit" : `head ${short(pr.headRefOid)} has commits on top of the shipped commit that this loop did not review`;
      const rung2 = rungs.length;
      rungs.push(`2. PR:      #${pr.number} ${pr.state.toLowerCase()}${pr.isDraft ? " (draft)" : ""}${pr.isCrossRepository ? " (from a fork)" : ""} into ${pr.baseRefName ?? "?"} ${pr.url}; ${extra}${othersMerged.length ? `; also merged: ${othersMerged.map((p) => `#${p.number} into ${p.baseRefName}`).join(", ")}` : ""}${truncated}`);
      // The PR is read back (head, state, and the checks it still awaits), CI is read for that exact
      // commit, then the PR is read once more: CI is reported only if the head held throughout.
      const view = () => {
        const v = run(W.ghBin(), W.ghArgs(target.gh, ["pr", "view", String(pr.number), "--json", "headRefOid,state,statusCheckRollup"]), { cwd: state.repo, timeoutMs: 30_000 });
        try {
          const j = v.status === 0 ? JSON.parse(v.stdout || "null") : null;
          return j && typeof j === "object" ? { ok: j } : { error: (v.stderr || `exit ${v.status}`).trim().split("\n")[0] };
        } catch {
          return { error: "gh returned something that is not JSON" };
        }
      };
      const moved = (now) => {
        // Nothing read for the old head is a fact about the PR any more.
        data.headNow = now.headRefOid;
        data.pr = { number: pr.number, url: pr.url, baseRefName: pr.baseRefName, state: now.state ?? null, headRefOid: now.headRefOid, headMoved: true, has: null };
        rungs[rung2] = `2. PR:      #${pr.number} ${pr.url}: its head moved from ${short(pr.headRefOid)} to ${short(now.headRefOid)} while the ladder read it; unknown whether it contains ${short(shipHead)}: run the ladder again`;
        rungs.push("3. CI:      unknown (the PR's head moved)");
      };
      const first = view();
      let after = first.ok ?? null;
      if (!after) rungs.push(`3. CI:      unknown (could not read PR #${pr.number} back: ${first.error})`);
      else if (after.headRefOid !== pr.headRefOid) moved(after);
      else {
        const rollup = Array.isArray(after.statusCheckRollup) ? after.statusCheckRollup : null;
        const awaited = (c) => c?.state === "EXPECTED" || (c?.__typename === "CheckRun" && ["QUEUED", "REQUESTED", "WAITING", "PENDING", "IN_PROGRESS"].includes(c.status));
        const expected = (rollup ?? []).filter(awaited).map((c) => ({ kind: c.__typename === "CheckRun" ? "run" : "status", name: c.context ?? c.name })).filter((e) => e.name);
        // gh reads at most 100 rollup entries; past that, a check still awaited could be missing.
        const ci = !rollup || rollup.length >= 100 ? { error: !rollup ? "the PR's check rollup could not be read" : "the PR has 100 or more checks, more than crossfire can confirm complete" } : ciForCommit(target, pr.headRefOid, state.repo, expected);
        const second = ci.error ? null : view();
        if (ci.error) rungs.push(`3. CI:      unknown (${ci.error})`);
        else if (!second.ok) {
          after = null;
          rungs.push(`3. CI:      unknown (could not read PR #${pr.number} back after reading its checks: ${second.error})`);
        } else if (second.ok.headRefOid !== pr.headRefOid) {
          after = second.ok;
          moved(after);
        } else {
          after = second.ok;
          data.ci = { ...ci.counts, head: pr.headRefOid };
          const c = ci.counts;
          rungs.push(`3. CI:      ${c.total ? `${c.pass} passed, ${c.fail} failed, ${c.pending} pending${c.skipping ? `, ${c.skipping} skipped` : ""}` : "no checks reported yet"} (on ${short(pr.headRefOid)})`);
        }
      }
      // The state read back last is the newest; if it is missing, merged is unknown unless another PR settles it.
      const nowState = after && after.headRefOid === pr.headRefOid ? after.state : null;
      if (data.headNow) data.merged = mergedFact === true ? true : null;
      else if (mergedFact === true) data.merged = true;
      else if (nowState === "MERGED" && onBase(pr)) data.merged = true;
      else if (!nowState) data.merged = null;
      else data.merged = mergedFact;
      const where = data.merged === true ? `yes, into ${base || pr.baseRefName}` : data.merged === null ? "unknown" : nowState === "MERGED" || pr.state === "MERGED" ? `into ${pr.baseRefName}, not the loop's base ${base}` : "no";
      rungs.push(`4. merged:  ${where}`);
    }
  }
  const lines = [`LADDER ${state.slug} · shipped ${short(shipHead)} on ${branch} (base ${base || "?"})${target.nwo ? ` · ${target.gh.host}/${target.nwo}` : ""}`, ...rungs, "Facts only: crossfire does not push, merge, post or recommend; what to do next is your call."];
  out(ctx, lines.join("\n"), data);
  return EXIT.OK;
}

// ---- main ----------------------------------------------------------------

export function main(argv = process.argv.slice(2)) {
  let ctx = { json: argv.includes("--json"), cwd: process.cwd() };
  try {
    const { cmd, rest, opts } = parseArgs(argv);
    ctx = { json: Boolean(opts.json), cwd: path.resolve(opts.cwd ?? process.cwd()) };
    if (opts.version || cmd === "version") {
      process.stdout.write(`${VERSION}\n`);
      return EXIT.OK;
    }
    if (!cmd || opts.help || cmd === "help") {
      process.stdout.write(`${USAGE}\n`);
      return cmd || opts.help ? EXIT.OK : EXIT.USAGE;
    }
    const commands = { doctor: () => doctor(ctx), memory: () => memoryCmd(ctx), check: () => check(ctx, opts), checks: () => checks(ctx), watch: () => watch(ctx, opts), spec: () => specCmd(ctx, opts), proof: () => proof(ctx, opts), attacked: () => attacked(ctx, opts), init: () => init(ctx, opts), built: () => built(ctx, opts), review: () => review(ctx, opts), status: () => status(ctx, opts), report: () => report(ctx, opts), ladder: () => ladder(ctx, opts), respec: () => respec(ctx, opts), "spec-review": () => specReviewCmd(ctx, opts), precedent: () => precedentCmd(ctx, rest), precedents: () => precedentsCmd(ctx) };
    if (!commands[cmd]) throw new CrossfireError(`unknown command "${cmd}"\n\n${USAGE}`);
    return commands[cmd]();
  } catch (e) {
    if (e instanceof CrossfireError) {
      if (ctx.json) process.stdout.write(`${JSON.stringify({ error: e.message, exitCode: e.exitCode })}\n`);
      else process.stderr.write(`crossfire: ${e.message}\n`);
      return e.exitCode;
    }
    process.stderr.write(`crossfire: internal error: ${e.stack ?? e}\n`);
    return 70;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
