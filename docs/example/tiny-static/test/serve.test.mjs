import test from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_DIR } from "../src/serve.mjs";

test("public dir is configured", () => {
  assert.equal(PUBLIC_DIR, "public");
});
