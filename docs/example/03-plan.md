# fix-traversal Implementation Plan

**Goal:** `resolvePublic` returns a path inside public/ or null; never escapes, never throws.

**Spec:** `<repo>/.crossfire/specs/fix-traversal.md`

## Review Focus

- A sibling directory sharing the prefix (`public-secret`) must not pass a `startsWith` containment check: compare with `path.relative`.
- Decode exactly once; a double-encoded `%252e%252e` must stay literal, not traverse.
- Malformed escapes return null; `decodeURIComponent` is the only thing that throws.
- NUL bytes return null.

### Task 1: containment and decoding

**Files:** Modify `src/serve.mjs`, `test/serve.test.mjs`

- [ ] Tests for E2E-1 to E2E-3 and each Review Focus line, failing first.
- [ ] Decode once inside try/catch; reject NUL; resolve against `path.resolve(root, "public")`; accept only when `path.relative(base, candidate)` is not `..`, does not start with `..` + separator, and is not absolute.
