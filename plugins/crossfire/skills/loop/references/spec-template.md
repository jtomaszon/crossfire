# Spec: <title>

**Slug:** `<slug>` · **Repository:** `<absolute path>` · **Base:** `<branch>` · **Owner:** <who decides escalations>

## Goal

One paragraph: what changes for whom, and why now.

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

## Proof commands (passed to `crossfire init`)

Crossfire runs these itself after every builder round; review only starts when all exit 0.

- `--e2e "<command that runs the E2E tests>"`
- `--invariant "<command that checks an invariant, e.g. a lint rule or a grep that must find nothing>"`

## Out of bounds

- Files or directories the builder must not touch.
- Owner-built files: small targeted fixes only, no rewrites or restyling.
- Anything external: no pushes, deploys, sends or purchases.

## Not in scope

What a reasonable builder might add that you do not want in this change.
