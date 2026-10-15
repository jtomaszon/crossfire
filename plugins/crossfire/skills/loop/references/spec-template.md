# Spec: <title>

**Slug:** `<slug>` · **Repository:** `<absolute path>` · **Base:** `<branch>` · **Owner:** <who decides escalations>

## Goal

One paragraph: what changes for whom, and why now.

## Requirements and owners

Question each requirement before it is built: who asked for it, and what breaks without it? Each one has an owner (the person who can say what it means and decides when it is in doubt). Mark the one to **drop first** if the change grows past about 400 lines or 10 files.

- R1 `<requirement>` (owner: `<person>`).
- R2 `<requirement>` (owner: `<person>`). **Drop first** if this grows.

## What we're deleting

What this change removes or narrows: code, flags, options, steps, defaults. The cheapest code is the code that is deleted; if nothing goes, say "nothing" and why.

- `<what goes>`: `<why it is not needed any more>`.

**Risk:** low | high (one word, then why in brackets: high turns on the breaker, crossfire's internal attacker, for this loop; for changes to deploys, data, permissions, money, validation, or anything hard to undo)

## Read before building (absolute paths)

- `/abs/path/to/the/code/area/README.md`: why
- `/abs/path/to/the/decision-or-design.md`: why
- Every rule file the repository has for contributors (contribution guide, agent instructions).

## Acceptance criteria (EARS)

Each one testable. Use the EARS shapes:

- AC-1 (ubiquitous): The `<component>` shall `<response>`.
- AC-2 (event): When `<trigger>`, the `<component>` shall `<response>`.
- AC-3 (state): While `<state>`, the `<component>` shall `<response>`.
- AC-4 (unwanted): If `<bad condition>`, then the `<component>` shall `<fail-closed response>`.
- AC-5 (optional feature): Where `<feature is enabled>`, the `<component>` shall `<response>`.

## How this could fail (required, at least 3)

Ask the reviewers' question before any code exists. For each item: the scenario, and the AC and E2E test that cover it. Go through every category that applies:

- Transactions and rollback: several saves in one transaction; a nested transaction (savepoint) that rolls back; callbacks that run after commit or after rollback.
- Stale in-memory state: an object, cache or flag that no longer matches what was committed.
- Concurrency: two requests, jobs or processes at once; check-then-act races.
- Retries and idempotency: the same job, webhook or request twice; failure halfway through.
- Ordering: events or callbacks in a different order, or not at all.
- Missing or unexpected data: nil, empty, deleted, archived, very large, another tenant's.
- The boundaries this change touches: limits, permissions, time, money, an external service failing.

Example: "FM-1: an order is marked paid, then a nested transaction that refunds it rolls back; the committed state is paid, so the receipt must still be sent (AC-7, E2E-5)."

## E2E tests (immutable)

The builder may add tests but never edits, weakens or deletes these.

- E2E-1: `<scenario>` -> expected `<observable result>`; covers AC-1, AC-2
- E2E-2: `<failure scenario>` -> expected `<refusal / error>`; covers AC-4

## Allowed test changes (optional)

Leave this section out unless an existing test file must change: existing test files are not changed unless the spec allows it; add new tests in new files. By default crossfire refuses a builder round that deletes, renames away or changes any line of a test file that exists on the base, or adds a skip or focus call (`.skip(`, `.only(`, `xit(`, `@pytest.mark.skip`, ...) in a new test file. A test file is known by its name: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, `test_*.py`, or under `__tests__/`; helpers and fixtures are not test files. List each existing test file that may change here, with why; nothing else is exempt.

- `tests/old_feature.test.js`: the feature it tests is deleted (see What we're deleting).

## Proof commands (passed to `crossfire init`)

Crossfire runs these itself after every builder round; review only starts when all exit 0. They run every round, so keep them to what this change touches, and say what each one proves. A command that proves nothing about this change is cost, not safety; the full suite is CI's job on the pull request.

- `--e2e "<command that runs the E2E tests for this change>"`. Proves: `<which acceptance criteria>`
- `--invariant "<command that checks an invariant, e.g. a lint rule or a grep that must find nothing>"`. Proves: `<what must not break>`

Example: a docs-only change declares a link check (`--invariant "npm run check-links"`. Proves: no broken links), not the full test suite.

## Out of bounds

- Files or directories the builder must not touch.
- Owner-built files: small targeted fixes only, no rewrites or restyling.
- Anything external: no pushes, deploys, sends or purchases.
- Destructive git: no `reset --hard` on the branch, no history rewrite, no branch deletion.
- Data: migrations and data changes only against a local or test database; no deleting or truncating real data.
- Secrets: never read `.env*`, credential files or CI secrets into a prompt, test or commit. A diff that adds something secret-looking is a BLOCKER (a secret scanner such as `gitleaks` works well as an `--invariant`).
- Network: no calls to production services, no package publishes.

## Rollback

How this change is undone if it misbehaves after it ships: a feature flag to turn off, a plain revert, a revert-safe migration, a reversible backfill. If it cannot be undone cleanly, say so here; that is something the owner must decide before the loop starts.

## Runbook and docs

The runbook or operational doc this change affects, if it touches something people operate, and what must change in it. The builder updates it in the same change.

## Not in scope

What a reasonable builder might add that you do not want in this change.
