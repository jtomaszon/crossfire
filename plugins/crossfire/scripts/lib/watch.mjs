// Watching a pull request for pushes and comments.
//
// Comment delivery is AT LEAST ONCE, with acknowledgement: a comment that wakes the
// watcher is first saved as pending, then printed, and stays pending until the session
// acknowledges it (`crossfire watch --ack <id>`). A crash between saving and printing,
// or a consumer that dies before handling it, means the comment is shown again, never
// lost. Every comment has a stable id, so a repeat is recognisable. Comments that must
// never wake (crossfire's own, or from people not on --from) are acknowledged at once.
import fs from "node:fs";
import path from "node:path";
import { run, atomicWriteJson, readJsonFile, nowIso, tryCreate as createAtomically } from "./util.mjs";

/** Marker crossfire puts in every comment it posts, so its own comments never wake a watcher. */
export const COMMENT_MARKER = "<!-- crossfire -->";

export function ghBin() {
  return process.env.CROSSFIRE_GH_BIN || "gh";
}

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The GitHub repository a git remote points at: { host, owner, repo } or null.
 * Handles git@host:owner/repo(.git), ssh://git@host[:port]/owner/repo and https://host/owner/repo.
 */
export function parseRemoteUrl(url) {
  const s = String(url ?? "").trim();
  let m = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (m) return { host: m[1], owner: m[2], repo: m[3] };
  m = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (m) return { host: m[1], owner: m[2], repo: m[3] };
  return null;
}

/** Resolve which GitHub repository the watched remote is, so gh never guesses. */
export function remoteRepo(cwd, remote) {
  const r = run("git", ["remote", "get-url", remote], { cwd });
  return r.status === 0 ? parseRemoteUrl(r.stdout) : null;
}

export function remoteSha(cwd, remote, ref) {
  const r = run("git", ["ls-remote", remote, ref], { cwd, timeoutMs: 60_000 });
  if (r.status !== 0) return { error: (r.stderr || `exit ${r.status}`).trim().split("\n")[0] };
  return { sha: r.stdout.split(/\s+/)[0] || null };
}

/** A gh failure, classified: permanent (no gh, not logged in, not found) or transient (retry). */
export function ghFailure(r, fallback) {
  const error = (r.stderr || r.stdout || fallback).trim().split("\n")[0] || fallback;
  // 403 is not permanent: GitHub rate limits answer 403. Only clear auth or not-found errors are.
  const permanent = r.timedOut ? false : /gh auth login|not logged in|HTTP 401|HTTP 404|Could not resolve to a/i.test(error);
  return { error, permanent };
}

/** Always name the host and repository explicitly: gh otherwise honors GH_HOST or its default repo. */
export function ghArgs(gh, args) {
  // gh api takes --hostname; other commands take --repo HOST/OWNER/REPO.
  if (!gh) return args;
  if (args[0] === "api") return [...args, "--hostname", gh.host];
  return [...args, "--repo", `${gh.host}/${gh.owner}/${gh.repo}`];
}

/** Parse an explicit --repo: OWNER/NAME or HOST/OWNER/NAME. */
export function parseRepoOption(value) {
  const parts = String(value ?? "").trim().replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length === 2) return { host: "github.com", owner: parts[0], repo: parts[1] };
  if (parts.length === 3) return { host: parts[0], owner: parts[1], repo: parts[2] };
  return null;
}

/**
 * The GitHub repository the watched PR lives in: an explicit --repo, else the watched
 * remote's own URL. Never gh's default repository: guessing could watch an unrelated PR.
 */
export function resolveGh(cwd, remote, explicit = null) {
  const parsed = explicit ? parseRepoOption(explicit) : remoteRepo(cwd, remote);
  if (explicit && !parsed) return { error: `--repo ${explicit} is not OWNER/NAME or HOST/OWNER/NAME`, permanent: true };
  if (!parsed) return { error: `cannot tell which GitHub repository remote "${remote}" is (its URL is not a GitHub address); pass --repo OWNER/NAME`, permanent: true };
  return { gh: parsed, nwo: `${parsed.owner}/${parsed.repo}` };
}

export function prState(cwd, target, pr) {
  const r = run(ghBin(), ghArgs(target.gh, ["pr", "view", String(pr), "--json", "state", "-q", ".state"]), { cwd, timeoutMs: 30_000 });
  return r.status === 0 ? r.stdout.trim() : null; // OPEN, MERGED, CLOSED; null when gh cannot tell
}

/** Every comment on a PR (conversation, inline review comments, reviews), or { error, permanent }. */
export function prComments(cwd, target, pr) {
  const sources = [
    ["comment", `repos/${target.nwo}/issues/${pr}/comments`],
    ["inline", `repos/${target.nwo}/pulls/${pr}/comments`],
    ["review", `repos/${target.nwo}/pulls/${pr}/reviews`],
  ];
  const all = [];
  for (const [kind, endpoint] of sources) {
    const r = run(ghBin(), ghArgs(target.gh, ["api", endpoint, "--paginate", "--jq", ".[] | {id, user: .user.login, at: (.created_at // .submitted_at), body, url: .html_url}"]), { cwd, timeoutMs: 60_000 });
    if (r.error?.code === "ENOENT") return { error: "gh is not installed", permanent: true };
    if (r.status !== 0) return ghFailure(r, `gh api ${endpoint} failed`);
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      try {
        const c = JSON.parse(line);
        all.push({ id: `${kind}:${c.id}`, kind, user: c.user, at: c.at, body: String(c.body ?? ""), url: c.url });
      } catch {
        /* skip a malformed line */
      }
    }
  }
  return { comments: all };
}

// ---- the inbox: acknowledged ids plus pending deliveries --------------------

export function inboxFile(crossfireDir, remote, pr) {
  return path.join(crossfireDir, "watch", `${String(remote).replace(/[^a-z0-9._-]+/gi, "-")}-pr-${pr}.json`);
}

/**
 * { acked: Set, pending: [comment], since, baselined } or null when this PR was never
 * watched. `since` is the start of the first watch: comments older than it are the
 * baseline; it is persisted before any network call and kept until a fetch succeeds.
 */
export function loadInbox(file) {
  try {
    const j = readJsonFile(file);
    return { acked: new Set(j.acked ?? j.keys ?? []), pending: Array.isArray(j.pending) ? j.pending : [], since: j.since ?? null, baselined: j.baselined ?? Boolean(j.keys), head: j.head ?? null };
  } catch {
    return null;
  }
}

export function newInbox(since) {
  return { acked: new Set(), pending: [], since, baselined: false, head: null };
}

export function saveInbox(file, inbox) {
  atomicWriteJson(file, { acked: [...inbox.acked], pending: inbox.pending, since: inbox.since, baselined: inbox.baselined, head: inbox.head, updatedAt: nowIso() });
}

/** First successful fetch: everything older than the first watch's start is history. */
export function applyBaseline(inbox, comments) {
  if (inbox.baselined) return;
  for (const c of comments) if (c.at && inbox.since && String(c.at) < inbox.since) inbox.acked.add(c.id);
  inbox.baselined = true;
}

/**
 * Fold a fresh comment list into the inbox. Returns the comments to deliver now: every
 * pending one (never acknowledged) plus every new one that may wake. New comments that
 * must never wake are acknowledged directly.
 */
export function takeDeliveries(inbox, comments, { from = [] } = {}) {
  const known = new Set([...inbox.acked, ...inbox.pending.map((p) => p.id)]);
  for (const c of comments) {
    if (known.has(c.id)) continue;
    const wakes = !c.body.includes(COMMENT_MARKER) && (!from.length || from.includes(c.user));
    if (wakes) inbox.pending.push(c);
    else inbox.acked.add(c.id);
  }
  return inbox.pending.slice();
}

/** Acknowledge handled comments (ids, or "all" for every pending one) and a handled push ("head:<sha>"). Returns how many. */
export function acknowledge(inbox, ids) {
  let heads = 0;
  for (const id of ids.filter((i) => i.startsWith("head:"))) {
    inbox.head = id.slice(5);
    heads += 1;
  }
  ids = ids.filter((i) => !i.startsWith("head:"));
  const all = ids.includes("all");
  const before = inbox.pending.length;
  inbox.pending = inbox.pending.filter((p) => {
    if (all || ids.includes(p.id)) {
      inbox.acked.add(p.id);
      return false;
    }
    return true;
  });
  return before - inbox.pending.length + heads;
}

// ---- one watcher per PR -----------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** The shared atomic create (util.mjs); here any error counts as not created, as before. */
function tryCreate(file, content) {
  try {
    return createAtomically(file, content);
  } catch {
    return false;
  }
}

/** A lock whose content is not a pid is being created (or was abandoned mid-way): stale only when old. */
function holderOf(file, ttlMs) {
  const raw = String(safeRead(file)).trim();
  const pid = Number(raw);
  if (/^\d+$/.test(raw) && pid > 0) return { pid, stale: !pidAlive(pid) };
  const age = Date.now() - (safeStat(file)?.mtimeMs ?? Date.now());
  return { pid: "starting", stale: age > ttlMs };
}

/**
 * Take the per-PR lock. A lock whose process is gone is stale; taking it over happens
 * under a second exclusive "takeover" file, so two watchers that both see the same stale
 * lock cannot both win. Returns { release } or { heldBy }.
 */
export function acquireLock(file, { takeoverTtlMs = 10_000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const me = String(process.pid);
  const takeover = `${file}.takeover`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (tryCreate(file, me)) return { release: releaser(file, me) };
    const holder = holderOf(file, takeoverTtlMs);
    if (!holder.stale) return { heldBy: holder.pid };
    // Stale. Only the process holding the takeover file may remove it.
    if (!tryCreate(takeover, me)) {
      const age = Date.now() - (safeStat(takeover)?.mtimeMs ?? Date.now());
      if (age > takeoverTtlMs) fs.rmSync(takeover, { force: true }); // a takeover that crashed
      else sleepMs(100);
      continue;
    }
    try {
      if (holderOf(file, takeoverTtlMs).stale) fs.rmSync(file, { force: true });
      if (tryCreate(file, me)) return { release: releaser(file, me) };
    } finally {
      fs.rmSync(takeover, { force: true });
    }
  }
  return { heldBy: holderOf(file, takeoverTtlMs).pid };
}

function releaser(file, me) {
  const release = () => {
    if (String(safeRead(file)).trim() === me) fs.rmSync(file, { force: true });
  };
  process.once("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => process.exit(130));
  return release;
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
