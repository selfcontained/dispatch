import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fileRunnerHoldStore,
  RUNNER_HOLD_BOUND_MS,
  RunnerHoldConflict,
  RunnerUpdateHolds,
} from "../src/agents/remote/update-hold.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let dirs: string[] = [];
let opened: RunnerUpdateHolds[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const holds of opened.splice(0)) holds.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function holdFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-holds-"));
  dirs.push(dir);
  return path.join(dir, "runner-update", "holds.json");
}

function open(file: string, now?: () => number, boundMs?: number) {
  const holds = new RunnerUpdateHolds({
    store: fileRunnerHoldStore(file, logger),
    logger,
    ...(now ? { now } : {}),
    ...(boundMs ? { boundMs } : {}),
  });
  opened.push(holds);
  return holds;
}

const create = {
  initialPrompt: "do the thing",
  initialFiles: [
    {
      fileId: 7,
      fileName: "a.txt",
      displayName: "a.txt",
      source: "upload",
      description: null,
    },
  ],
  chatLaunchPost: {
    messageId: "blk_launch",
    attachmentLines: ["- file: a.txt"],
    images: [{ path: "/files/p.png", mimeType: "image/png", runnerName: "p" }],
  },
  jobRunId: "run_1",
};

describe("runner update holds", () => {
  it("holds nothing and writes nothing until a hold begins", async () => {
    const file = await holdFile();
    const holds = open(file);
    await holds.load();
    holds.start();
    expect(holds.isHeld("r1")).toBe(false);
    expect(
      await holds.holdLaunch("r1", { agentId: "agt_a", kind: "start" })
    ).toBe(false);
    await holds.wait("r1");
    expect(holds.counts("r1")).toEqual({
      prompts: 0,
      scheduled: 0,
      launches: 0,
      stops: 0,
    });
    await expect(readdir(path.dirname(file))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("survives a controller restart with its launches, order and bound", async () => {
    const file = await holdFile();
    let now = Date.parse("2026-11-21T10:00:00.000Z");
    const first = open(file, () => now);
    await first.load();
    first.start();
    const began = await first.begin("r1", ATTEMPT);
    expect(began.expiresAt).toBe(
      new Date(now + RUNNER_HOLD_BOUND_MS).toISOString()
    );
    await first.holdLaunch("r1", { agentId: "agt_a", kind: "create", create });
    await first.holdLaunch("r1", { agentId: "agt_b", kind: "start" });
    expect((await import("node:fs")).statSync(file).mode & 0o777).toBe(0o600);
    first.close();

    // A later process: same record, bound not extended.
    now += 60_000;
    const second = open(file, () => now);
    await second.load();
    expect(second.isHeld("r1")).toBe(true);
    expect(second.isHeld("r2")).toBe(false);
    expect(second.current("r1")?.expiresAt).toBe(began.expiresAt);
    expect(second.hasLaunch("agt_a")).toBe(true);
    expect(second.counts("r1").launches).toBe(2);

    const released = vi.fn();
    second.onRelease(released);
    expect(await second.release("r1", ATTEMPT, "committed")).toBe(true);
    expect(released).toHaveBeenCalledTimes(1);
    const { launches } = released.mock.calls[0]![0];
    expect(launches.map((l: { agentId: string }) => l.agentId)).toEqual([
      "agt_a",
      "agt_b",
    ]);
    expect(launches[0]).toMatchObject({ kind: "create", create });

    const third = open(file);
    await third.load();
    expect(third.isHeld("r1")).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      format: 1,
      holds: [],
    });
  });

  it("releases at its bound with outcome expired and resolves waiters", async () => {
    vi.useFakeTimers();
    const file = await holdFile();
    const holds = open(file, undefined, 1_000);
    await holds.load();
    holds.start();
    await holds.begin("r1", ATTEMPT);
    const released = vi.fn();
    holds.onRelease(released);
    let stopped = false;
    void holds.wait("r1", "stop").then(() => {
      stopped = true;
    });
    expect(holds.counts("r1").stops).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1));
    expect(released.mock.calls[0]![0]).toMatchObject({ outcome: "expired" });
    expect(stopped).toBe(true);
    expect(holds.isHeld("r1")).toBe(false);
  });

  it("releases a hold whose bound passed while the controller was down, once started", async () => {
    const file = await holdFile();
    let now = Date.parse("2026-11-21T10:00:00.000Z");
    const first = open(file, () => now, 5_000);
    await first.begin("r1", ATTEMPT);
    await first.holdLaunch("r1", { agentId: "agt_a", kind: "start" });
    first.close();
    now += 10_000;
    const second = open(file, () => now);
    await second.load();
    const released = vi.fn();
    second.onRelease(released);
    // Loading alone opens nothing: boot recovery runs before the bound.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(released).not.toHaveBeenCalled();
    expect(second.isHeld("r1")).toBe(true);
    second.start();
    await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1));
    expect(released.mock.calls[0]![0]).toMatchObject({
      outcome: "expired",
      launches: [expect.objectContaining({ agentId: "agt_a" })],
    });
  });

  it("refuses a second attempt on a held runner and repeats the same one", async () => {
    const holds = open(await holdFile());
    const first = await holds.begin("r1", ATTEMPT);
    expect(await holds.begin("r1", ATTEMPT)).toEqual(first);
    await expect(holds.begin("r1", OTHER)).rejects.toBeInstanceOf(
      RunnerHoldConflict
    );
    await holds.begin("r2", OTHER);
    expect(await holds.release("r1", OTHER, "committed")).toBe(false);
    expect(holds.isHeld("r1")).toBe(true);
  });

  it("keeps one launch per agent and lets a stop cancel it", async () => {
    const holds = open(await holdFile());
    await holds.begin("r1", ATTEMPT);
    await holds.holdLaunch("r1", { agentId: "agt_a", kind: "start" });
    await holds.holdLaunch("r1", { agentId: "agt_b", kind: "start" });
    await holds.holdLaunch("r1", { agentId: "agt_a", kind: "start" });
    expect(holds.current("r1")?.launches.map((l) => l.agentId)).toEqual([
      "agt_b",
      "agt_a",
    ]);
    expect(await holds.takeLaunch("agt_a")).toMatchObject({ agentId: "agt_a" });
    expect(await holds.takeLaunch("agt_a")).toBeUndefined();
    expect(holds.hasLaunch("agt_a")).toBe(false);
    expect(holds.counts("r1").launches).toBe(1);
  });

  it("reads a missing record as nothing held, without complaint", async () => {
    logger.warn.mockClear();
    const holds = open(await holdFile());
    await holds.load();
    expect(holds.isHeld("r1")).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sets aside a record of the wrong shape", async () => {
    const file = await holdFile();
    const seed = open(file);
    await seed.begin("r1", ATTEMPT);
    await writeFile(
      file,
      JSON.stringify({
        format: 1,
        holds: [{ runnerId: "r1", attemptId: "not-a-uuid" }],
      })
    );
    const holds = open(file);
    await holds.load();
    expect(holds.isHeld("r1")).toBe(false);
    expect(
      (await readdir(path.dirname(file))).some((name) =>
        name.startsWith("holds.json.rejected-")
      )
    ).toBe(true);
  });

  it("sets an unreadable or unsafe record aside and holds nothing", async () => {
    const file = await holdFile();
    const seed = open(file);
    await seed.begin("r1", ATTEMPT);
    await writeFile(file, "{not json");
    const corrupt = open(file);
    await corrupt.load();
    expect(corrupt.isHeld("r1")).toBe(false);
    expect(
      (await readdir(path.dirname(file))).some((name) =>
        name.startsWith("holds.json.rejected-")
      )
    ).toBe(true);

    await seed.begin("r2", OTHER);
    await chmod(file, 0o644);
    const unsafe = open(file);
    await unsafe.load();
    expect(unsafe.isHeld("r2")).toBe(false);
  });

  it("opens even if the release cannot be persisted", async () => {
    let fail = false;
    const holds = new RunnerUpdateHolds({
      store: {
        read: async () => [],
        write: async () => {
          if (fail) throw new Error("disk full");
        },
      },
      logger,
    });
    await holds.begin("r1", ATTEMPT);
    fail = true;
    expect(await holds.release("r1", ATTEMPT, "committed")).toBe(true);
    expect(holds.isHeld("r1")).toBe(false);
  });

  it("does not hold when the hold cannot be persisted", async () => {
    const holds = new RunnerUpdateHolds({
      store: {
        read: async () => [],
        write: async () => {
          throw new Error("disk full");
        },
      },
      logger,
    });
    await expect(holds.begin("r1", ATTEMPT)).rejects.toThrow("disk full");
    expect(holds.isHeld("r1")).toBe(false);
  });
});
