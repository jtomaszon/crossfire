# Crossfire check: pr-1

- Result: 2 finding(s)
- Branch: `feature/resolve-public` at `7b9c285825a1`, reviewed against `main` (`3ebb6a717bfd`)
- Reviewers: codex 1/1 passes, grok 1/1 passes
- When: 2026-10-13T12:22:20.262Z

## Findings

### 1. BLOCKER · src/serve.mjs:8 · codex + grok
**Decoded traversal escapes the public directory**

path.join normalizes attacker-controlled '..' segments without enforcing containment. Verified: resolvePublic('/srv/site', '/../secret.txt') returns '/srv/site/secret.txt'; encoded traversal also escapes after decoding. If the returned path is served as intended, requests can expose files outside public/, including application secrets.

Recommendation: Resolve against an absolute public base and reject candidates whose path.relative(base, candidate) is '..', starts with '..' plus the platform separator, or is absolute. Add regression tests for literal and percent-encoded traversal.

### 2. CHANGES · src/serve.mjs:8 · grok
**Malformed percent-encoding throws out of the resolver**

decodeURIComponent(requestPath) throws URIError on truncated or invalid escapes such as % or %ZZ. The function does not catch that, and nothing in this change shows a caller that does. A single crafted request path therefore fails the request synchronously; if the HTTP handler does not catch it, Node treats it as an uncaught exception and can take down the process. That is attacker-controlled input on the path this function is meant to map.

Recommendation: Catch URIError and treat it as a bad request (reject the path, do not throw). Add a test that resolvePublic("%") does not throw and does not return a usable path.
