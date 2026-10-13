#!/usr/bin/env node
// crossfire: the referee CLI for the build -> review -> fix loop.
// Claude (the orchestrator) runs these commands; the referee decides every next step.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "./lib/git.mjs";
import { ACTIONS, afterBreak, afterBuild, afterReview, collectFindings, compareWithPrevious, isTerminal, newState, noteMalformed } from "./lib/referee.mjs";
import { renderBreakerBrief, renderBrief, validateBreakerResult, validateBuildResult } from "./lib/briefs.mjs";
import { locatePlugins, readiness, usable, OFFICIAL } from "./lib/plugins.mjs";
import { buildCheckFocus, buildFocus, readSpec, runReviewer } from "./lib/reviewers.mjs";
import * as W from "./lib/watch.mjs";
import { crossfireRoot, ensureExcluded, files, listRuns, loadState, runDir, saveState, withLock } from "./lib/store.mjs";
import { renderCheckReport, renderReport, statusLine } from "./lib/report.mjs";
import { appendLessons, lessonsBlock, lessonsFromCheck, lessonsFromLoop, memoryFile, readLessons } from "./lib/memory.mjs";
import { classifyProofFailure, grokSocketHint, readHealth, recordAttempt, summarize } from "./lib/health.mjs";
import { CrossfireError, EXIT, atomicWriteJson, minutesBetween, nowIso, readJsonFile, run, runShell, tail, writeText } from "./lib/util.mjs";

const VERSION = "1.1.0";

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
  crossfire memory                     what reviewers found in this repository before
  crossfire init --slug <slug> --spec <file> [--base <ref>] [--e2e <cmd>]... [--invariant <cmd>]...
                 [--max-rounds 5] [--max-minutes 45] [--grok auto|on|off] [--breaker on|off]
                 [--plan <file>] [--force] [--no-preflight] [--no-failure-modes] [--from-check <id>]
                                       --from-check: start at the fix round with that check's findings
                                       init first checks every proof command can run here (preflight)
  crossfire built --slug <slug>        record the builder's result file, run the proof commands (G0)
  crossfire attacked --slug <slug>     record the breaker's result (proven attacks get one harden round)
  crossfire proof --slug <slug> [--e2e <cmd>]... [--invariant <cmd>]...
                                       replace the proof commands of a running loop (when one cannot run here)
  crossfire review --slug <slug> [--timeout-min 20]
                                       run Codex (required) and Grok Build (optional), record findings
  crossfire status [--slug <slug>]     where a loop is, and its next action
  crossfire report --slug <slug>       print the ship or escalation report

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
function emitNext(ctx, dir, state, extra = []) {
  const minutes = minutesBetween(state.startedAt);
  const next = state.next;
  const lines = [statusLine(state, minutes), ...extra];
  const data = { slug: state.slug, phase: state.phase, round: state.round, reviewPass: state.reviewPass, next };

  if (next.action === ACTIONS.SEND_BUILDER) {
    const brief = files.brief(dir, state.round, next.brief);
    const result = files.result(dir, state.round, next.brief);
    if (!fs.existsSync(brief)) writeText(brief, renderBrief(state, { resultFile: result, branch: git.branch(state.repo), failures: next.failures, lessons: lessonsBlock(state.repo) }));
    lines.push(`NEXT ACTION: SEND_BUILDER (${next.brief})`, `BRIEF: ${brief}`, `RESULT FILE: ${result}`, `THEN: crossfire built --slug ${state.slug}`);
    Object.assign(data, { brief, resultFile: result, then: `crossfire built --slug ${state.slug}` });
  } else if (next.action === ACTIONS.SEND_BREAKER) {
    const brief = files.breakerBrief(dir, state.round);
    const result = files.breakerResult(dir, state.round);
    if (!fs.existsSync(brief)) writeText(brief, renderBreakerBrief(state, { resultFile: result, branch: git.branch(state.repo), head: git.head(state.repo), lessons: lessonsBlock(state.repo) }));
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
      return `${name} ${ok}/${passes} passes${verdict}${ok < passes && fail ? ` (${fail.skipped ? "not usable" : "failed"}: ${fail.error})` : ""}`;
    })
    .join(", ");
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
  const ready = checks.every((c) => c.ok || !c.required);
  const lines = [`crossfire ${VERSION} doctor: ${ready ? "READY" : "NOT READY"}`];
  for (const c of checks) {
    lines.push(`${c.ok ? "ok  " : c.required ? "FAIL" : "warn"} ${c.name.padEnd(11)} ${c.detail}`);
    for (const step of c.install ?? []) lines.push(`       ${step}`);
  }
  if (!checks.find((c) => c.name === "grok").ok) lines.push("", "Grok Build is optional: with it, every review pass gets a second, independent reviewer.");
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
  const breakerOpt = opts.breaker ?? "on";
  if (!["on", "off"].includes(breakerOpt)) throw new CrossfireError("--breaker must be on or off");
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
  const proofCommands = [...opts.e2e, ...opts.invariant];
  if (!opts["no-preflight"] && proofCommands.length) {
    // Before any build: every proof command must at least be able to run here.
    // Failing because the feature is not built yet is expected and fine.
    const pre = runCommands(proofCommands, repo, 10 * 60 * 1000);
    const env = pre.failures.filter((f) => f.kind === "environment");
    if (env.length) {
      throw new CrossfireError(`preflight: ${env.length} proof command(s) cannot run in this environment, so the builder could never make them pass:\n${envFailureText(pre.failures)}\nFix the command (toolchain, PATH, version manager) and run init again. Nothing was started.`, EXIT.ENVIRONMENT);
    }
    preflight = `${proofCommands.length} proof command(s) can run here${pre.failures.length ? ` (${pre.failures.length} fail before the build, as expected)` : ""}`;
  }
  if (grok === "on" && !usable(plugins.grok)) {
    throw new CrossfireError(`--grok on, but Grok Build is not usable: ${plugins.grok.problems.join("; ") || "grok-build@xai-grok-build is not installed"}`, EXIT.ENVIRONMENT);
  }

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
      maxRounds: intOpt(opts, "max-rounds", 5, 1, 10),
      maxMinutes: intOpt(opts, "max-minutes", 45, 5, 24 * 60),
      grok,
      breaker: breakerOpt === "on",
      startedAt: nowIso(),
    });
    state.plan = plan;
    state.history.push({ at: state.startedAt, event: "init", detail: `base ${base} (${baseSha.slice(0, 12)}), spec ${spec}; preflight: ${preflight}` });
    if (fromCheck) {
      // The check was review pass 1 of the branch as it stands: the loop starts at its fix round.
      state.phase = "review";
      state.reviewerRuns = fromCheck.reviewerRuns;
      state.history.push({ at: state.startedAt, event: "from-check", detail: `${fromCheck.id}: ${fromCheck.findings.length} finding(s) at ${fromCheck.head.slice(0, 12)}` });
      afterReview(state, fromCheck.reviews, { at: state.startedAt, minutesElapsed: 0 });
    }
    saveState(dir, state);
    emitNext(ctx, dir, state, [`PREFLIGHT: ${preflight}`]);
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

function built(ctx, opts) {
  const { dir } = requireLoop(ctx.cwd, opts.slug);
  return withLock(dir, () => {
    const state = loadState(dir);
    requireNext(state, ACTIONS.SEND_BUILDER);
    const kind = state.next.brief;
    const resultFile = files.result(dir, state.round, kind);
    const key = `build-r${state.round}-${kind}`;
    const at = nowIso();

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
  const reviewers = [plugins.codex];
  if (grok !== "off" && usable(plugins.grok)) reviewers.push(plugins.grok);

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
  const focus = buildCheckFocus({ base, specText, focusText: opts.focus ?? prev?.focus ?? "", previous: prev?.findings ?? [] });
  const timeoutMs = intOpt(opts, "timeout-min", 20, 1, 120) * 60 * 1000;

  const results = reviewers.map((p) => {
    return runReviewer(p, { cwd: repo, base: baseSha, focus, timeoutMs });
  });
  const reviewerRuns = results.map((r) => ({ pass: 1, reviewer: r.reviewer, ok: r.ok, seconds: r.seconds, verdict: r.verdict ?? null, findings: r.ok ? r.findings.length : null, error: r.ok ? null : String(r.error).split("\n")[0].slice(0, 300) }));
  if (grok !== "off" && !usable(plugins.grok)) reviewerRuns.push({ pass: 1, reviewer: "grok", ok: false, skipped: true, error: plugins.grok.problems[0] ?? "not installed" });
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
  const record = { version: 1, id, at, repo, branch, head, base, baseSha, focus: opts.focus ?? prev?.focus ?? null, spec: opts.spec ? path.resolve(ctx.cwd, opts.spec) : null, reviewerRuns, reviewersText, reviews: ok, findings, approved: findings.length === 0, since };
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
    ...results.filter((r) => !r.ok).map((r) => `WARNING: ${r.reviewer} did not review (${r.error}); this check rests on Codex alone.`),
    ...(since ? [`SINCE ${since.id} (${since.head.slice(0, 12)}): ${since.resolved.length} fixed, ${since.stillOpen.length} still open, ${since.unclear.length} unclear, ${since.fresh} new`, ...since.resolved.map((p) => `  fixed: [P${p.index}] ${p.title}`), ...since.stillOpen.map((s) => `  still open: [P${s.previous.index}] ${s.previous.title}`), ...since.unclear.map((p) => `  unclear: [P${p.index}] ${p.title} (a new finding is near it; read both)`), ...since.near.map((n) => `  new (near P${n.near}): ${n.title}`)] : []),
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
    const reviewers = [plugins.codex];
    if (state.grok !== "off" && usable(plugins.grok)) reviewers.push(plugins.grok);
    if (state.grok === "on" && !usable(plugins.grok)) {
      throw new CrossfireError(`this loop requires Grok Build (--grok on) and it is not usable: ${plugins.grok.problems.join("; ")}`, EXIT.ENVIRONMENT);
    }

    const pass = state.reviewPass + 1;
    const focus = buildFocus(state, { specText: readSpec(state.spec) });
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
    if (state.grok !== "off" && !usable(plugins.grok)) state.reviewerRuns.push({ pass, reviewer: "grok", ok: false, skipped: true, error: plugins.grok.problems[0] ?? "not installed" });
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
    out(ctx, runs.map((s) => statusLine(s, minutesBetween(s.startedAt))).join("\n"), { runs: runs.map((s) => ({ slug: s.slug, phase: s.phase, round: s.round, next: s.next })) });
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

// ---- main ----------------------------------------------------------------

export function main(argv = process.argv.slice(2)) {
  let ctx = { json: argv.includes("--json"), cwd: process.cwd() };
  try {
    const { cmd, opts } = parseArgs(argv);
    ctx = { json: Boolean(opts.json), cwd: path.resolve(opts.cwd ?? process.cwd()) };
    if (opts.version || cmd === "version") {
      process.stdout.write(`${VERSION}\n`);
      return EXIT.OK;
    }
    if (!cmd || opts.help || cmd === "help") {
      process.stdout.write(`${USAGE}\n`);
      return cmd || opts.help ? EXIT.OK : EXIT.USAGE;
    }
    const commands = { doctor: () => doctor(ctx), memory: () => memoryCmd(ctx), check: () => check(ctx, opts), checks: () => checks(ctx), watch: () => watch(ctx, opts), spec: () => specCmd(ctx, opts), proof: () => proof(ctx, opts), attacked: () => attacked(ctx, opts), init: () => init(ctx, opts), built: () => built(ctx, opts), review: () => review(ctx, opts), status: () => status(ctx, opts), report: () => report(ctx, opts) };
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
