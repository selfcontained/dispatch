import assert from "node:assert/strict";
import test from "node:test";

import { synchronizeManifestVersion } from "./sync-browser-extension-manifest-version.mjs";

test("updates exactly one semantic top-level version field", () => {
  const result = synchronizeManifestVersion(
    '{"version":"0.28.5","meta":{"version":"unchanged"}}\n',
    "0.29.0"
  );

  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.source), {
    version: "0.29.0",
    meta: { version: "unchanged" },
  });
});

test("rejects escaped duplicate top-level version fields", () => {
  assert.throws(
    () =>
      synchronizeManifestVersion(
        '{"version":"0.28.5","\\u0076ersion":"9.9.9"}',
        "0.29.0"
      ),
    /found 2/
  );
});

test("rejects a nested-only version field", () => {
  assert.throws(
    () => synchronizeManifestVersion('{"meta":{"version":"0.28.5"}}', "0.29.0"),
    /found 0/
  );
});

test("validates synchronized output even when no update is needed", () => {
  const source = '{"version":"0.29.0"}\n';
  assert.deepEqual(synchronizeManifestVersion(source, "0.29.0"), {
    changed: false,
    source,
  });
});
