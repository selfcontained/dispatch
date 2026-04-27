import { describe, expect, it } from "vitest";
import {
  isLegalTransition,
  isTerminalPhase,
  type AssistedPhase,
} from "../src/assisted-update-store.js";

describe("assisted-update-store transitions", () => {
  it("allows the canonical forward sequence", () => {
    const seq: AssistedPhase[] = [
      "inspect",
      "prepare",
      "apply",
      "restarting",
      "validate",
      "done",
    ];
    for (let i = 0; i < seq.length - 1; i++) {
      expect(isLegalTransition(seq[i]!, seq[i + 1]!)).toBe(true);
    }
  });

  it("allows skipping forward phases", () => {
    expect(isLegalTransition("inspect", "apply")).toBe(true);
    expect(isLegalTransition("prepare", "validate")).toBe(true);
  });

  it("disallows moving backward through forward phases", () => {
    expect(isLegalTransition("apply", "inspect")).toBe(false);
    expect(isLegalTransition("validate", "prepare")).toBe(false);
  });

  it("allows moving to terminal sideways states from any non-terminal phase", () => {
    for (const start of [
      "inspect",
      "prepare",
      "apply",
      "restarting",
      "validate",
    ] as AssistedPhase[]) {
      expect(isLegalTransition(start, "rollback")).toBe(true);
      expect(isLegalTransition(start, "blocked")).toBe(true);
      expect(isLegalTransition(start, "failed")).toBe(true);
    }
  });

  it("forbids transitions out of terminal states", () => {
    for (const start of [
      "done",
      "rollback",
      "blocked",
      "failed",
    ] as AssistedPhase[]) {
      expect(isLegalTransition(start, "inspect")).toBe(false);
      expect(isLegalTransition(start, "validate")).toBe(false);
    }
    // Idempotent re-report of the same phase is allowed (the agent may
    // duplicate-post on retry).
    expect(isLegalTransition("done", "done")).toBe(true);
  });

  it("isTerminalPhase identifies the right set", () => {
    expect(isTerminalPhase("done")).toBe(true);
    expect(isTerminalPhase("rollback")).toBe(true);
    expect(isTerminalPhase("blocked")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
    expect(isTerminalPhase("inspect")).toBe(false);
    expect(isTerminalPhase("validate")).toBe(false);
  });
});

describe("writeAssistedUpdateState concurrent writes (CRU-146 #1242)", () => {
  it("uses a unique tmp filename per write so concurrent writers don't race", async () => {
    // Without the per-call `<final>.tmp.<pid>.<rand>`, two writers
    // would both stage to the same shared tmp, and one rename could
    // move it out from under the other (ENOENT or last-writer-wins
    // state loss). Burst N concurrent writes; afterwards the only file
    // in the dir should be the canonical store, with no .tmp orphans.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "dispatch-assisted-store-")
    );
    const target = path.join(dir, "assisted-update.json");
    process.env.DISPATCH_ASSISTED_UPDATE_STORE_PATH = target;
    try {
      const { writeAssistedUpdateState } =
        await import("../src/assisted-update-store.js");

      // Build N distinct states and write them all in flight at once.
      // Whichever loses the rename race writes a different content,
      // but no caller should hit ENOENT on its own .tmp file because
      // every caller owns its own unique path.
      const writes = Array.from({ length: 32 }, (_, i) =>
        writeAssistedUpdateState({
          tag: `v0.${i}.0`,
          fromTag: null,
          metadata: null,
          migrations: null,
          requiredChecks: [],
          phase: "inspect",
          token: `token-${i}`,
          agentId: null,
          startedAt: "2026-04-27T00:00:00Z",
          updatedAt: "2026-04-27T00:00:00Z",
          completedAt: null,
          error: null,
          checks: [],
          notes: {},
        })
      );
      await Promise.all(writes);

      const entries = await fs.readdir(dir);
      // Only the canonical file should remain — no .tmp orphans.
      expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
      expect(entries).toContain("assisted-update.json");
    } finally {
      delete process.env.DISPATCH_ASSISTED_UPDATE_STORE_PATH;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
