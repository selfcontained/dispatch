import { test } from "node:test";
import assert from "node:assert/strict";
import { runStapler } from "./macos-stapler.mjs";

const lost = {
  status: 68,
  stderr:
    'NSURLErrorDomain Code=-1005 "The network connection was lost." https://api.apple-cloudkit.com/database/lookup',
};
function harness(results) {
  const calls = [],
    waits = [],
    output = [];
  return {
    calls,
    waits,
    output,
    options: {
      spawn: (...args) => {
        calls.push(args);
        return results.shift();
      },
      sleep: async (delay) => {
        waits.push(delay);
      },
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
    },
  };
}
test("retries observed CloudKit transport loss, then requires success", async () => {
  const h = harness([lost, lost, { status: 0, stdout: "validated" }]);
  await runStapler("validate", "/tmp/Dispatch.app", h.options);
  assert.deepEqual(h.waits, [5000, 10000]);
  assert.deepEqual(
    h.calls.map((c) => c.slice(0, 2)),
    Array(3).fill(["xcrun", ["stapler", "validate", "/tmp/Dispatch.app"]])
  );
  assert.ok(h.output.includes("validated"));
});
test("transport retries are bounded and exhausted validation fails", async () => {
  const h = harness(Array(4).fill(lost));
  await assert.rejects(
    runStapler("validate", "app", h.options),
    /failed \(68\)/
  );
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.waits, [5000, 10000, 20000]);
});
test("ticket errors, unclassified error68 and process failures fail immediately", async () => {
  for (const result of [
    { status: 65, stderr: "Record not found" },
    { status: 68, stderr: "Bad ticket" },
    { status: null, error: new Error("spawn failed") },
  ]) {
    const h = harness([result]);
    await assert.rejects(runStapler("staple", "app", h.options));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.waits, []);
  }
});
