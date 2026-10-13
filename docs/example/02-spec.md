# Spec: resolvePublic never leaves public/

**Slug:** `fix-traversal` · **Repository:** `<repo>` · **Base:** `main` · **Owner:** the maintainer

## Goal

`resolvePublic(root, requestPath)` maps an HTTP request path to the file to serve. The review of this PR (check `pr-1`) found that a request can escape `public/` and that a malformed escape crashes the resolver. Fix both, so the function can be given untrusted request paths.

## Read before building (absolute paths)

- `<repo>/src/serve.mjs`: the function.
- `<repo>/test/serve.test.mjs`: the existing tests.
- `<repo>/.crossfire/checks/pr-1/report.md`: the two findings, with the reviewers' reproductions.

## Acceptance criteria (EARS)

- AC-1 (ubiquitous): `resolvePublic` shall return an absolute path inside `<root>/public` for every request path it accepts.
- AC-2 (event): When the request path names a file under `public/` (also percent-encoded, e.g. `/a%20b.html`), it shall return that file's absolute path.
- AC-3 (unwanted): If the request path, after one decode, would resolve outside `<root>/public` (`../`, `%2e%2e/`, an absolute path, a backslash path on Windows-style input), then it shall return `null`.
- AC-4 (unwanted): If the request path has malformed percent-encoding (`%`, `%ZZ`, `%E0%A4%A`), then it shall return `null`, never throw.

## How this could fail

- FM-1: encoded traversal (`%2e%2e%2f`, double-encoded `%252e`) decoded once too often or not enough.
- FM-2: a path that equals the public directory itself (`/`, empty string) or a sibling with the same prefix (`/srv/site/public-secret`) passes a naive `startsWith` check.
- FM-3: malformed or truncated escapes throw out of `decodeURIComponent`.
- FM-4: NUL bytes or backslashes produce a path that the filesystem reads differently from the check.

## E2E tests (immutable)

- E2E-1: `/index.html` and `/a%20b.html` resolve inside public/ (AC-2).
- E2E-2: `/../secret.txt`, `/%2e%2e/secret.txt`, `/..%2fsecret.txt`, `/etc/passwd` handled as `/<root>/public/etc/passwd` or null, never outside public/ (AC-1, AC-3).
- E2E-3: `%`, `%ZZ` return null without throwing (AC-4).

## Proof commands

- `--e2e "npm test"`

## Out of bounds

- Only `src/serve.mjs` and its tests. No new dependencies.

## Rollback

A plain revert of the commits; nothing else depends on the function yet.

## Runbook and docs

None (no operated system).

## Not in scope

Serving the file, HTTP handling, caching.
