# A complete crossfire run, start to SHIP

Every file in this folder is real output from one run, on a tiny synthetic repository (`tiny-static`), with local paths replaced by `<repo>`. It shows the most common path: someone opens a pull request, crossfire reviews it, finds problems, and a loop fixes them until both reviewers approve.

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

## 1. Review the PR: `crossfire check` (no builder, no loop)

```
crossfire check --base main --name pr-1 \
  --focus "PR: resolvePublic maps an HTTP request path to the file to serve under public/. It must never return a path outside public/."
```

Result ([01-check-report.md](01-check-report.md)): **both reviewers ran, 2 findings**.

- **BLOCKER**, found by Codex **and** Grok independently: decoded traversal escapes the public directory.
- **CHANGES**, found by Grok: malformed percent-encoding throws out of the resolver.

When two vendors flag the same place, it is real. This is what `/crossfire:review <PR>` does for you.

## 2. Spec and plan

Before any fix, the spec ([02-spec.md](02-spec.md)) states the contract in EARS form (the function returns a path inside `public/` or `null`, never throws), the failure modes to test (encoded and double-encoded traversal, a sibling directory sharing the prefix, malformed escapes, NUL bytes and backslashes), the immutable E2E tests, the proof command (`npm test`), what is out of bounds, and how to roll it back. The plan ([03-plan.md](03-plan.md)) lists the **Review Focus**: the failure modes the planner expects the reviewers to probe. In a real session, `superpowers:brainstorming` and `superpowers:writing-plans` produce these, and you approve them; that is the one checkpoint at the start.

## 3. Start the loop from the review

```
crossfire init --slug fix-traversal --spec <spec> --plan <plan> --base main --from-check pr-1 --e2e "npm test"
```

`--from-check` starts the loop at the **fix round** with the two findings: no builder round re-verifies the existing code first. The check counts as review pass 1.

## 4. The builder fixes (about 1.5 minutes)

The builder reads its brief ([04-builder-brief.md](04-builder-brief.md)), writes failing tests first, fixes, commits, and returns a structured result ([05-builder-result.json](05-builder-result.json)). For each finding it names the **broadest rule** the fix enforces, where the fix is, and tested variants:

- F1: *a path built from untrusted input is returned only after the final normalized filesystem path is proven to be inside public/*, with 10 tested variants (literal and encoded traversal, a sibling `public-secret`, double encoding, backslashes, NUL bytes...).
- F2: *resolvePublic never throws for any requestPath value: every untrusted-input failure is a null result*, with 4 tested variants.

Crossfire then runs the proof command itself (G0: `npm test`, green). A builder's word is not evidence.

## 5. The breaker attacks (about 1 minute)

A cold subagent that has not seen the builder's notes tries to break the fix and must prove every attack with a failing test in a throwaway worktree ([06-breaker-brief.md](06-breaker-brief.md)). Here it fuzzed 300,000 request paths and proved nothing ([07-breaker-result.json](07-breaker-result.json)); its unproven ideas (query strings, symlinks, Windows paths) are listed in its summary, each outside the spec's scope. When the breaker proves an attack, the builder gets one "harden" round before the reviewers see the branch.

## 6. Review pass 2: both approve

Codex approved in 41 seconds, Grok in about 10 minutes ([08-review-pass2-codex.json](08-review-pass2-codex.json), [08-review-pass2-grok.json](08-review-pass2-grok.json)). Both reviewers were told about the earlier findings and how the builder answered them, so they checked that the fixes hold rather than starting over.

## 7. SHIP

The report ([09-ship-report.md](09-ship-report.md)) records the result, the reviewers (`codex 2/2 passes, grok 2/2 passes`), the first pass outcome, the breaker, every finding and how it was closed, the **Evidence** (what crossfire ran itself, which tests the builder named, what nobody verified: CI's job), the files changed and the timeline. The fix itself is [10-the-fix.diff](10-the-fix.diff).

Total: 15 minutes, 2 builder legs (the PR author's and one fix), 2 review passes.

**SHIP is not done.** Next, a person pushes the branch, opens or updates the PR, waits for CI, merges, and verifies it where it runs. See [docs/workflow.md](../workflow.md).

## A note on the timeline

The timeline shows one `malformed` line: this run used a pre-release of 1.1.0 whose referee accepted only single lines in `where` and refused the builder's `src/serve.mjs:15-20`. That is how the bug was found; 1.1.0 accepts line ranges. The report's Breaker line was re-rendered from this run's saved state with the 1.1.0 wording. Running crossfire on real work keeps finding problems in crossfire itself, which is the point.

## What an escalation looks like

Not part of this run. When a gate stops the loop, the last command prints, for example:

```
NEXT ACTION: ESCALATE
REVIEWERS: codex 2/2 passes, grok 1/2 passes (failed: ...)
GATE: G3
REASON: G3: F1 re-flagged after the builder answered it (claimed_fixed): <the finding>
REPORT: .crossfire/runs/<slug>/report.md
```

The report's "What the owner needs to decide" section lists the gate, the open findings and the options: accept as is, give the builder a direction and start a new loop on top of the branch, or drop the change. Crossfire never loops past an escalation.
