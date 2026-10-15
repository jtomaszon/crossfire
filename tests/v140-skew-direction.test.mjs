import assert from "node:assert/strict";
import test from "node:test";
import { versionSkew } from "../plugins/crossfire/scripts/lib/plugins.mjs";

// Spec: v140-skew-direction — versionSkew only warns when the running
// session is OLDER than the installed crossfire. A newer running build
// (e.g. a dev session on 1.4.0 with 1.3.0 installed) must not be told to
// "reload" into an older version.

test("version skew: equal versions never warn (FM-1)", () => {
  assert.equal(versionSkew("1.4.0", { id: "crossfire@jtomaszon", version: "1.4.0" }), null);
});

test("version skew: a newer running build is not warned about an older install (FM-2)", () => {
  assert.equal(versionSkew("1.4.0", { id: "crossfire@jtomaszon", version: "1.3.0" }), null);
});

test("version skew: an older running session is warned about the newer install (FM-3)", () => {
  const msg = versionSkew("1.3.0", { id: "crossfire@jtomaszon", version: "1.4.0" });
  assert.match(msg, /runs crossfire 1\.3\.0, but crossfire@jtomaszon 1\.4\.0 is installed: run \/reload-plugins/);
});
