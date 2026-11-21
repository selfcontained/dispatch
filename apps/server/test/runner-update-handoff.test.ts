import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { requiresQuiescence } from "../src/agents/remote/update-handoff.js";
import { readRunnerCompatibility } from "../src/agents/remote/update-probe.js";

// Frozen read-side projection of the pre-epoch supervisor's binding format.
function previousReader(raw: string) {
  const { scope, pid, start, marker } = JSON.parse(raw);
  if (
    typeof scope !== "string" ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    typeof start !== "string" ||
    !/^\d+$/.test(start) ||
    typeof marker !== "string" ||
    !/^DISPATCH_OWNED_[a-f0-9]{32}=1$/.test(marker)
  )
    throw new Error("Invalid runner host identity");
  return { scope, pid, start, marker };
}

it("preserves the N−1 reader's binding key and process identity", () => {
  const binding = {
    scope: "boot:namespace",
    pid: 100,
    start: "500",
    marker: "DISPATCH_OWNED_00000000000000000000000000000000=1",
  };
  const trial = {
    ...binding,
    handoffFormat: 2,
    sessionId: "../opaque",
    hostInstanceId: "01234567-89ab-4cde-8fab-0123456789ab",
    hostBuild: { version: "1.7.29", revision: "f".repeat(40) },
  };
  expect(previousReader(JSON.stringify(trial))).toEqual(
    previousReader(JSON.stringify(binding))
  );
});

describe("bidirectional handoff compatibility", () => {
  const previous = { reads: [1, 2], writes: 2 };
  const candidate = { reads: [2, 3], writes: 3 };

  it.each([
    ["compatible", [2], previous, { ...candidate, writes: 2 }, false],
    ["unreadable N−2", [2, 1], previous, { ...candidate, writes: 2 }, true],
    ["rollback cannot read trial writes", [2], previous, candidate, true],
    [
      "unknown retained identity",
      [2, null],
      previous,
      { ...candidate, writes: 2 },
      true,
    ],
    ["empty but rollback incompatible", [], previous, candidate, true],
    [
      "empty and rollback compatible",
      [],
      previous,
      { ...candidate, writes: 2 },
      false,
    ],
    ["probe failed", [], previous, null, true],
  ] as const)("%s", (_name, formats, old, next, expected) => {
    expect(requiresQuiescence(formats, old, next)).toBe(expected);
  });
});

describe("candidate compatibility probe", () => {
  const compatibility = {
    version: "1.7.29",
    revision: "f".repeat(40),
    handoff: { reads: [1, 2], writes: 2 },
  };
  const emit = (value: unknown, expectedVersion = compatibility.version) =>
    readRunnerCompatibility(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`],
      expectedVersion
    );

  it("accepts bounded JSON for the expected version and projects its fields", async () => {
    await expect(emit({ ...compatibility, extra: "ignored" })).resolves.toEqual(
      compatibility
    );
  });

  it.each([
    { version: "1.7.30" },
    { revision: null },
    { revision: "f".repeat(12) },
    { handoff: { reads: Array(33).fill(2), writes: 2 } },
    { handoff: { reads: [2, "1"], writes: 2 } },
    { handoff: { reads: [2], writes: -1 } },
    { handoff: { reads: [1], writes: 2 } },
  ])("rejects malformed compatibility %j", async (override) => {
    await expect(emit({ ...compatibility, ...override })).rejects.toThrow(
      "Invalid runner compatibility response"
    );
  });

  it("rejects garbage and a nonzero exit", async () => {
    await expect(
      readRunnerCompatibility(
        "/bin/sh",
        ["-c", "printf garbage"],
        compatibility.version
      )
    ).rejects.toThrow("Invalid runner compatibility response");
    await expect(
      readRunnerCompatibility(
        "/bin/sh",
        ["-c", "exit 1"],
        compatibility.version
      )
    ).rejects.toThrow("probe failed");
  });

  it("caps combined stdout and stderr", async () => {
    await expect(
      readRunnerCompatibility(
        process.execPath,
        [
          "-e",
          "process.stdout.write('x'.repeat(3000)); process.stderr.write('x'.repeat(3000));",
        ],
        compatibility.version
      )
    ).rejects.toThrow("output was too large");
  });

  it("kills descendants when the probe exceeds the deadline", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runner-probe-timeout-"));
    const marker = path.join(dir, "survived");
    try {
      await expect(
        readRunnerCompatibility(
          "/bin/sh",
          ["-c", '(sleep 0.3; touch "$1") & wait', "probe", marker],
          compatibility.version,
          undefined,
          100
        )
      ).rejects.toThrow("timed out");
      await delay(350);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
