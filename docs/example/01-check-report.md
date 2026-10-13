# Crossfire check: pr-1

- Result: 2 finding(s)
- Branch: `feature/resolve-public` at `7b9c285825a1`, reviewed against `main` (`3ebb6a717bfd`)
- Reviewers: codex 1/1 passes (last verdict: needs-attention), grok 1/1 passes (last verdict: needs-attention)
- When: 2026-10-13T14:34:58.738Z

## Findings

### 1. BLOCKER · src/serve.mjs:8 · codex + grok
**Decoded parent segments escape the public directory**

path.join normalizes decoded '..' segments without checking containment. Verified that resolvePublic('/srv/site', '/%2e%2e/%2e%2e/etc/passwd') returns '/srv/etc/passwd'. If the server serves the returned path as intended, an attacker can read accessible files outside public/.

Recommendation: Resolve the candidate against the absolute public directory, then reject it if path.relative(publicRoot, candidate) is '..', starts with '..' plus the platform separator, or is absolute. Add regression tests for plain and percent-encoded traversal.

### 2. BLOCKER · src/serve.mjs:8 · grok
**decodeURIComponent throws on bad percent-encoding**

decodeURIComponent(requestPath) throws URIError on malformed sequences such as "%" or "%ZZ". Nothing in this function catches that. If the HTTP handler calls resolvePublic on the raw URL path, one bad request becomes an unhandled exception instead of a 400. That is a crash or 500 path on ordinary client input, and it happens before any containment check could run.

Recommendation: Catch URIError and reject the request as invalid. Do not join a path that failed to decode.
