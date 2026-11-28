import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

const { runRemoteRunner } = vi.hoisted(() => ({ runRemoteRunner: vi.fn() }));
vi.mock(
  "../../../packages/runner/src/workload/agents/remote/runner.js",
  () => ({ runRemoteRunner })
);

it("passes the embedded repository helper to the enrolled runner entry", async () => {
  const argv = process.argv;
  process.argv = [argv[0]!, "dispatch", "remote-runner", "fixture.json"];
  try {
    await import("../src/main.js");
    const expected = readFileSync(
      new URL("../../../bin/dispatch-stream", import.meta.url),
      "utf8"
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(runRemoteRunner).toHaveBeenCalledWith(
      "fixture.json",
      expect.objectContaining({ streamHelper: expected })
    );
  } finally {
    process.argv = argv;
  }
});
