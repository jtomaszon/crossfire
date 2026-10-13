# A complete crossfire run, start to SHIP

Every file in this folder is real output from one run of crossfire 1.1.0, on a tiny synthetic repository (`tiny-static`, included here: see [Reproduce it](#reproduce-it)), with local paths replaced by `<repo>`. It shows the most common path: someone opens a pull request, crossfire reviews it, finds problems, and a loop fixes them until both reviewers approve.

Times are wall-clock on a Linux host with Codex and Grok Build both usable.

## The pull request

`tiny-static` has a skeleton on `main`. A pull request adds one function:

```js
export function resolvePublic(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  return path.join(root, PUBLIC_DIR, decoded);
}
```

Its own test (serving `/index.html`) passes. It has two bugs: `/../secret.txt` resolves outside `public/`, and a malformed escape such as `%` throws.

## Reproduce it

[tiny-static/](tiny-static/) is the run's `main`, byte for byte, and [00-the-pr.diff](00-the-pr.diff) is the pull request (rebuilt from the function above and the fix diff; the run's PR commit was not kept). From the root of a crossfire checkout:

```bash
EX="$PWD/docs/example"
cp -R "$EX/tiny-static" /tmp/tiny-static && cd /tmp/tiny-static
git init -q -b main && git add -A && git commit -qm "skeleton"
git switch -qc feature/resolve-public && git apply "$EX/00-the-pr.diff" && git commit -qam "serve: resolvePublic"
npm test                                 # 2 tests pass; neither bug is tested
echo "/.crossfire/" >> .git/info/exclude # crossfire adds this itself on first use
mkdir -p .crossfire/specs                # the spec and plan of step 2, with <repo> filled in
sed "s|<repo>|$PWD|g" "$EX/02-spec.md" > .crossfire/specs/fix-traversal.md
sed "s|<repo>|$PWD|g" "$EX/03-plan.md" > .crossfire/specs/fix-traversal.plan.md
```

Then, in that directory, in a Claude Code session where `/crossfire:setup` says **READY**, run step 1's command and step 3's (with `--spec .crossfire/specs/fix-traversal.md --plan .crossfire/specs/fix-traversal.plan.md`), and let the session follow each `NEXT ACTION` through steps 4 to 7. The builder and the reviewers are models: expect the same two bugs, not the same words, line numbers or times. Reports from crossfire 1.2 and later also count breaker legs completed, skipped and failed. To see only the fix, on `main`: `git apply "$EX/10-the-fix.diff" && npm test` (18 tests).

## 1. Review the PR: `crossfire check` (no builder, no loop)

```
crossfire check --base main --name pr-1 \
  --focus "PR: resolvePublic maps an HTTP request path to the file to serve under public/. It must never return a path outside public/."
```

Result ([01-check-report.md](01-check-report.md)): **both reviewers ran, 2 findings**.

- **BLOCKER**, found by Codex **and** Grok independently: decoded parent segments escape the public directory.
- **BLOCKER**, found by Grok: `decodeURIComponent` throws on bad percent-encoding.

When two vendors flag the same place, it is real. This is what `/crossfire:review <PR>` does for you.

## 2. Spec and plan

Before any fix, the spec ([02-spec.md](02-spec.md)) states the contract in EARS form (the function returns a path inside `public/` or `null`, never throws), the failure modes to test (encoded and double-encoded traversal, a sibling directory sharing the prefix, malformed escapes, NUL bytes and backslashes), the immutable E2E tests, the proof command (`npm test`), what is out of bounds, and how to roll it back. The plan ([03-plan.md](03-plan.md)) lists the **Review Focus**: the failure modes the planner expects the reviewers to probe. In a real session, `superpowers:brainstorming` and `superpowers:writing-plans` produce these, and you approve them; that is the one checkpoint at the start.

## 3. Start the loop from the review

```
crossfire init --slug fix-traversal --spec <spec> --plan <plan> --base main --from-check pr-1 --e2e "npm test"
```

`--from-check` starts the loop at the **fix round** with the two findings: no builder round re-verifies the existing code first. The check counts as review pass 1, and the PR's own code as round 1, so the first crossfire builder leg is round 2 (the report's "Builder legs: 2 of 5" is that round counter).

## 4. The builder fixes (about 1 minute)

The builder reads its brief ([04-builder-brief.md](04-builder-brief.md)), writes failing tests first, fixes, commits, and returns a structured result ([05-builder-result.json](05-builder-result.json)). For each finding it names the **broadest rule** the fix enforces, `where` the fix is (file:line, ranges allowed), and tested variants:

- F1, fixed at `src/serve.mjs:25-33`: *every filesystem path built from untrusted request input is accepted only after the final, fully resolved path is verified (by path.relative, not string prefix) to lie strictly inside the served base directory, and any input the filesystem could read differently from the check (NUL, backslash) is rejected*, with 9 tested variants (plain, encoded and double-encoded traversal, a sibling directory sharing the prefix, `public/` itself, backslashes, NUL bytes...).
- F2, fixed at `src/serve.mjs:13-21`: *untrusted request input is validated and decoded without letting any exception escape; any input that cannot be parsed is rejected (null)*, with 4 tested variants.

Crossfire then runs the proof command itself (G0: `npm test`, green). A builder's word is not evidence.

## 5. The breaker attacks (about 1 minute)

A cold subagent that has not seen the builder's notes tries to break the fix and must prove every attack with a failing test in a throwaway worktree ([06-breaker-brief.md](06-breaker-brief.md)). Here it fuzzed 300,000 request paths and proved nothing ([07-breaker-result.json](07-breaker-result.json)); its unproven ideas (Windows path semantics, query strings, symlinks) are listed in its summary, each outside the spec's scope or not provable on this platform. When the breaker proves an attack, the builder gets one "harden" round before the reviewers see the branch.

## 6. Review pass 2: both approve

Codex approved in 31 seconds, Grok in about 9 minutes ([08-review-pass2-codex.json](08-review-pass2-codex.json), [08-review-pass2-grok.json](08-review-pass2-grok.json)). Both reviewers were told about the earlier findings and how the builder answered them, so they checked that the fixes hold rather than starting over.

## 7. SHIP

The report ([09-ship-report.md](09-ship-report.md)) records the result, the reviewers (`codex 2/2 passes, grok 2/2 passes`), the first pass outcome, the breaker, every finding and how it was closed, the **Evidence** (what crossfire ran itself, which tests the builder named, what nobody verified: CI's job), the files changed and the timeline, with each fix's `file:line` next to its finding. The fix itself is [10-the-fix.diff](10-the-fix.diff).

Total: 12 minutes from `init` to SHIP (the check before it took a few more): one crossfire builder leg, one breaker pass, 2 review passes.

**SHIP is not done.** Next, a person pushes the branch, opens or updates the PR, waits for CI, merges, and verifies it where it runs. See [docs/workflow.md](../workflow.md).

## What an escalation looks like

Not part of this run. When a gate stops the loop, the last command prints lines of this shape (an illustration, not captured output):

```
NEXT ACTION: ESCALATE
REVIEWERS: codex 2/2 passes (last verdict: needs-attention), grok 1/2 passes (failed: ...)
GATE: G3
REASON: G3: F1 re-flagged after the builder answered it (claimed_fixed): <the finding>
REPORT: <repo>/.crossfire/runs/<slug>/report.md
```

The report's "What the owner needs to decide" section lists the gate, the open findings and the options: accept as is, give the builder a direction and start a new loop on top of the branch, or drop the change. Crossfire never loops past an escalation.
