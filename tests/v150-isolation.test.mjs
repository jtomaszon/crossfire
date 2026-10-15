// 1.5.0: loops cannot step on each other. One active loop per checkout (decided under a lock),
// abandon only a loop that looks stuck, --force never wipes recorded work.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, approve, needs, finding, gitc, sh, CLI, ROOT } from "./helpers.mjs";

const stateFile = (sb, slug) => `${sb.repo}/.crossfire/runs/${slug}/state.json`;
const readState = (sb, slug) => JSON.parse(fs.readFileSync(stateFile(sb, slug), "utf8"));
const init = (sb, slug, ...extra) => sb.cf("init", "--slug", slug, "--spec", sb.spec, "--base", "main", "--breaker", "off", ...extra);

/** Make every recorded step of a loop `ms` old. */
function age(sb, slug, ms) {
  const st = readState(sb, slug);
  const at = new Date(Date.now() - ms).toISOString();
  st.startedAt = at;
  for (const h of st.history) h.at = at;
  fs.writeFileSync(stateFile(sb, slug), JSON.stringify(st));
}
const H = 3600 * 1000;
const M = 60 * 1000;

function cfAsync(sb, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: sb.repo, env: sb.env });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stderr }));
  });
}

test("AC-1: init refuses a second active loop in the checkout, changes nothing, and prints how to use a worktree", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  const before = fs.readdirSync(`${sb.repo}/.crossfire/runs`).sort();
  const r = init(sb, "two", "--e2e", "grep -q v2 app.txt");
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /another loop is active in this checkout/);
  assert.match(r.stderr, / one: last step 0 h 0 min ago\n/);
  assert.doesNotMatch(r.stderr, /looks stuck/);
  assert.ok(r.stderr.includes(`git worktree add ../repo-two -b two main`), r.stderr);
  assert.ok(r.stderr.includes(`crossfire init --slug two --spec ${sb.spec} --e2e 'grep -q v2 app.txt' --base main --breaker off`), r.stderr);
  assert.doesNotMatch(r.stderr, /mkdir|cp /, "no specs to copy");
  assert.deepEqual(fs.readdirSync(`${sb.repo}/.crossfire/runs`).sort(), before, "nothing was created");
  // Stuck: idle 3 h and no lock held.
  age(sb, "one", 3 * H + M);
  assert.match(init(sb, "two").stderr, / one: last step 3 h 1 min ago; it looks stuck; if the person confirms, crossfire abandon --slug one/);
});

test("AC-1: with --from-check, the refusal says the check belongs to this checkout", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  fs.writeFileSync(`${sb.repo}/app.txt`, "v2\n");
  gitc(sb.repo, "commit", "-qam", "change");
  sb.queue("codex", needs(finding("high", "the write is lost")));
  sb.queue("grok", approve);
  sb.cf("check", "--base", "main", "--name", "pr-1");
  assert.equal(init(sb, "one").status, 0);
  const r = init(sb, "fix-pr-1", "--from-check", "pr-1");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Check pr-1 belongs to this checkout: check the pull request out in a worktree of its own, run crossfire check there again/);
  assert.doesNotMatch(r.stderr, /git worktree add/);
});

test("FM-3: finished loops (abandoned, shipped) do not block a new init; archives do not either", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  assert.equal(init(sb, "one", "--force").status, 0, "archives the untouched loop");
  age(sb, "one", 4 * H);
  assert.equal(sb.cf("abandon", "--slug", "one").status, 0);
  assert.equal(init(sb, "two").status, 0);
  const st = readState(sb, "two");
  st.phase = "shipped";
  fs.writeFileSync(stateFile(sb, "two"), JSON.stringify(st));
  assert.equal(init(sb, "three").status, 0);
});

test("AC-1b/FM-2: two concurrent inits with different slugs: exactly one loop starts", async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const results = await Promise.all(["one", "two", "three"].map((s) => cfAsync(sb, "init", "--slug", s, "--spec", sb.spec, "--base", "main", "--breaker", "off")));
  assert.deepEqual(results.map((r) => r.status).sort(), [0, 2, 2], results.map((r) => r.stderr).join("\n"));
  const loops = fs.readdirSync(`${sb.repo}/.crossfire/runs`).filter((n) => fs.existsSync(stateFile(sb, n)));
  assert.equal(loops.length, 1, loops.join(","));
  assert.ok(!fs.existsSync(`${sb.repo}/.crossfire/runs/.init.lock`), "the init lock is released");
});

test("AC-2/FM-1: abandon ends only a loop that looks stuck, under its lock", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  assert.equal(init(sb, "one").status, 0);
  age(sb, "one", 2 * H + 59 * M);
  let r = sb.cf("abandon", "--slug", "one");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not look stuck: its last step was 2 h 59 min ago/);
  age(sb, "one", 3 * H + M);
  const lock = `${sb.repo}/.crossfire/runs/one/.lock`;
  fs.writeFileSync(lock, `${process.pid} ${os.hostname()}\n${new Date().toISOString()}\n`);
  r = sb.cf("abandon", "--slug", "one");
  assert.equal(r.status, 5, "a live holder: a command is running");
  assert.match(init(sb, "two").stderr, /last step 3 h 1 min ago\n/, "a held lock: it does not look stuck");
  assert.equal(readState(sb, "one").phase, "build", "nothing changed");
  fs.rmSync(lock);
  const last = readState(sb, "one").startedAt;
  r = sb.cf("abandon", "--slug", "one");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NEXT ACTION: ESCALATE/);
  assert.match(r.stdout, /GATE: ABANDONED/);
  assert.ok(r.stdout.includes(`REASON: no step since ${last} (3 h 1 min ago); abandoned by the person`), r.stdout);
  assert.match(r.stdout, /# /, "the report is printed");
  const st = readState(sb, "one");
  assert.equal(st.phase, "escalated");
  assert.equal(st.terminal.gate, "ABANDONED");
  assert.ok(fs.existsSync(`${sb.repo}/.crossfire/runs/one/report.md`));
  r = sb.cf("abandon", "--slug", "one");
  assert.equal(r.status, 4, "not active");
});

test("AC-3/FM-4: --force restarts a bare or from-check loop, never one that recorded steps", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  fs.writeFileSync(`${sb.repo}/app.txt`, "v2\n");
  gitc(sb.repo, "commit", "-qam", "change");
  sb.queue("codex", needs(finding("high", "the write is lost")));
  sb.queue("grok", approve);
  sb.cf("check", "--base", "main", "--name", "pr-1");
  assert.equal(init(sb, "demo", "--from-check", "pr-1").status, 0);
  assert.match(init(sb, "demo").stderr, /still running \(build\); pass --force to archive it/);
  let r = init(sb, "demo", "--from-check", "pr-1", "--force", "--json");
  assert.equal(r.status, 0, "a from-check init with nothing recorded since");
  r = init(sb, "demo", "--force", "--json");
  assert.equal(r.status, 0, "a bare init");
  sb.build(r.json().resultFile);
  sb.cf("built", "--slug", "demo");
  const before = fs.readFileSync(stateFile(sb, "demo"), "utf8");
  r = init(sb, "demo", "--force");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has recorded steps since its init .*--force restarts only a loop that finished or has recorded nothing since its init/);
  assert.match(r.stderr, /git worktree add \.\.\/repo-demo -b demo main/);
  r = init(sb, "demo");
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /--force/, "no --force suggestion for a loop with recorded steps");
  assert.equal(fs.readFileSync(stateFile(sb, "demo"), "utf8"), before, "the live loop is untouched");
});

test("FM-7: the printed commands run as printed: branch exists, spec in .crossfire/specs, spec review carried over", (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const files = sb.cf("spec", "--slug", "two", "--json").json();
  fs.writeFileSync(files.specFile, fs.readFileSync(sb.spec));
  fs.writeFileSync(files.planFile, "# Plan\n\n- write v2\n");
  sb.queue("codex", approve);
  sb.queue("grok", approve);
  assert.equal(sb.cf("spec-review", "--slug", "two", "--spec", files.specFile, "--plan", files.planFile, "--base", "main").status, 0);
  sh(sb.repo, "git", ["branch", "two", "main"]);
  assert.equal(init(sb, "one").status, 0);
  const r = sb.cf("init", "--slug", "two", "--spec", ".crossfire/specs/two.md", "--plan", files.planFile, "--base", "main");
  assert.equal(r.status, 2);
  const cmds = r.stderr.split("\n").filter((l) => l.startsWith("  ") && !/last step/.test(l)).map((l) => l.trim());
  assert.ok(cmds.includes("git worktree add ../repo-two two"), cmds.join("\n"));
  assert.ok(cmds.includes("cp .crossfire/specs/two.* ../repo-two/.crossfire/specs/"), cmds.join("\n"));
  assert.ok(cmds.at(-1).includes("--spec .crossfire/specs/two.md --plan .crossfire/specs/two.plan.md"), cmds.at(-1));
  const bin = path.join(sb.tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "crossfire"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  const run = spawnSync("/bin/sh", ["-ec", cmds.join("\n")], { cwd: sb.tmp, env: { ...sb.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /SPEC REVIEW: current \(/);
  const wt = path.join(sb.tmp, "repo-two");
  assert.equal(sh(wt, "git", ["branch", "--show-current"]), "two");
  assert.equal(JSON.parse(fs.readFileSync(`${wt}/.crossfire/runs/two/state.json`, "utf8")).specReview.status, "current");
});

// ---- AC-6: docs ----------------------------------------------------------------------

test("AC-6: the loop skill, README and CHANGELOG 1.5.0 describe one loop per checkout and abandon", () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const skill = read("plugins/crossfire/skills/loop/SKILL.md");
  assert.match(skill, /One loop per checkout is enforced/);
  assert.match(skill, /run the commands it prints/);
  assert.match(skill, /`crossfire abandon --slug <slug>` only on the person's explicit words/);
  assert.match(skill, /Never edit or delete files under `\.crossfire\/` to get around a refusal/);
  const readme = read("README.md");
  assert.match(readme, /One active loop per checkout/);
  assert.match(readme, /crossfire abandon --slug <slug>/);
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /^## 1\.5\.0$/m);
  assert.match(changelog.split("\n## ")[1], /crossfire abandon/);
  assert.match(changelog.split("\n## ")[1], /\.init\.lock/);
});
