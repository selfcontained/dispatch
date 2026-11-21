/**
 * A runner update hold against the real ACP runtime and scripted hosts on
 * real sockets: new work for a held runner waits in the runtime's own queue
 * and goes out once, in order, when the hold opens. Other runners and local
 * agents are untouched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PromptImage } from "../src/agents/acp/prompt-source.js";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";
import { scriptedHost } from "./runner-update-hold-fixtures.js";
import { RunnerUpdateFenced } from "../src/agents/remote/service.js";
import {
  RunnerUpdateHolds,
  type RunnerHoldState,
} from "../src/agents/remote/update-hold.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => logger,
  level: "silent",
} as unknown as Parameters<typeof createAcpRuntime>[0]["logger"];

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const OTHER_ATTEMPT = "22222222-2222-4222-8222-222222222222";

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

function memoryHolds() {
  let saved: RunnerHoldState = { holds: [], resuming: [] };
  const holds = new RunnerUpdateHolds({
    store: {
      read: async () => saved,
      write: async (next) => {
        saved = next;
      },
    },
    logger,
  });
  cleanup.push(() => holds.close());
  return holds;
}

/**
 * Agents `agt_held` on runner r1, `agt_other` on runner r2, `agt_local`
 * native. The runner request seam records every operation by agent.
 */
async function fixture(
  options: {
    preparePromptFiles?: (
      agentId: string,
      images: PromptImage[]
    ) => Promise<PromptImage[]>;
    attach?: boolean;
  } = {}
) {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-hold-"));
  cleanup.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  const held = await scriptedHost(cleanup, stateRoot, "agt_held");
  const other = await scriptedHost(cleanup, stateRoot, "agt_other");
  const local = await scriptedHost(cleanup, stateRoot, "agt_local");
  const sockets: Record<string, string> = {
    agt_held: held.socket,
    agt_other: other.socket,
  };
  const placements: Record<string, { runner: string; workspace: string }> = {
    agt_held: { runner: "r1", workspace: "proof" },
    agt_other: { runner: "r2", workspace: "proof" },
  };
  const operations: string[] = [];
  /** Refuse the next request of a kind as fenced, after running a hook. */
  const refuse = new Map<string, () => Promise<void>>();
  const requestSession = vi.fn(
    async (
      _placement: unknown,
      operation: { kind: string; agentId: string }
    ) => {
      operations.push(`${operation.kind}:${operation.agentId}`);
      const refusal = refuse.get(operation.kind);
      if (refusal) {
        refuse.delete(operation.kind);
        await refusal();
        throw new RunnerUpdateFenced("The runner is updating.");
      }
      if (operation.kind === "attach")
        return {
          value: true,
          channel: net.createConnection(sockets[operation.agentId]!),
        };
      return { value: true, channel: undefined };
    }
  );
  const holds = memoryHolds();
  const runtime = createAcpRuntime({
    config: {
      agentStateRoot: stateRoot,
      agentRuntime: "acp",
      dispatchBinDir: "/nonexistent",
    },
    logger,
    hostSeq: async () => ({ seq: 0, journalId: null }),
    syncJournal: async () => {},
    placement: async (id) => placements[id] ?? null,
    remote: { requestSession, available: () => true } as never,
    holds,
    ...(options.preparePromptFiles
      ? { preparePromptFiles: options.preparePromptFiles }
      : {}),
  });
  if (options.attach !== false)
    for (const id of ["agt_held", "agt_other", "agt_local"])
      expect(await runtime.attach(id)).toBe(true);
  return { runtime, holds, held, other, local, operations, refuse };
}

/** Let sockets and microtasks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("runner update hold in the runtime queue", () => {
  it("holds only the held runner's prompts and delivers them once, in order, on release", async () => {
    const { runtime, holds, held, other, local } = await fixture();
    await holds.begin("r1", ATTEMPT);

    const queued = ["first", "second", "third"].map((text) =>
      runtime.prompt("agt_held", text)
    );
    const elsewhere = runtime.prompt("agt_other", "on r2");
    const native = runtime.prompt("agt_local", "local");
    await Promise.all([elsewhere.settled, native.settled]);
    await settle();

    expect(other.prompts.map((p) => p.text)).toEqual(["on r2"]);
    expect(local.prompts.map((p) => p.text)).toEqual(["local"]);
    expect(held.prompts).toEqual([]);
    expect(holds.counts("r1")).toMatchObject({ prompts: 3, scheduled: 0 });
    expect(holds.counts("r2")).toMatchObject({ prompts: 0 });

    expect(await holds.release("r1", ATTEMPT, "committed")).toBe(true);
    await Promise.all(queued.map((d) => d.settled));
    await settle();
    expect(held.prompts.map((p) => p.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(holds.counts("r1")).toMatchObject({ prompts: 0 });
  });

  it("does not reach for a host on a held runner before release", async () => {
    const { runtime, holds, held, operations } = await fixture({
      attach: false,
    });
    await holds.begin("r1", ATTEMPT);
    const delivery = runtime.prompt("agt_held", "first contact");
    await settle();
    expect(operations).toEqual([]);
    await holds.release("r1", ATTEMPT, "committed");
    await delivery.settled;
    await settle();
    expect(operations).toEqual(["attach:agt_held"]);
    expect(held.prompts.map((p) => p.text)).toEqual(["first contact"]);
  });

  it("opens the gate exactly once and ignores a stale attempt", async () => {
    const { runtime, holds, held } = await fixture();
    await holds.begin("r1", ATTEMPT);
    const listener = vi.fn();
    holds.onRelease(listener);
    const delivery = runtime.prompt("agt_held", "once");
    await settle();

    expect(await holds.release("r1", OTHER_ATTEMPT, "committed")).toBe(false);
    await settle();
    expect(held.prompts).toEqual([]);

    const [a, b] = await Promise.all([
      holds.release("r1", ATTEMPT, "rolled_back"),
      holds.release("r1", ATTEMPT, "committed"),
    ]);
    expect([a, b]).toEqual([true, false]);
    await delivery.settled;
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ runnerId: "r1", outcome: "rolled_back" })
    );
    expect(held.prompts.map((p) => p.text)).toEqual(["once"]);
  });

  it("drops work cancelled during the hold and never sends it", async () => {
    const { runtime, holds, held } = await fixture();
    await holds.begin("r1", ATTEMPT);
    const controller = new AbortController();
    const scheduled = runtime.prompt(
      "agt_held",
      "scheduled",
      {
        source: "chat",
        chatMessageId: "blk_sched",
        scheduleId: "sch_1",
        scheduleDeliveryId: "occ_1",
      },
      { signal: controller.signal, alone: true }
    );
    const post = runtime.prompt("agt_held", "deleted post", {
      source: "chat",
      chatMessageId: "blk_post",
    });
    const kept = runtime.prompt("agt_held", "kept");
    await settle();
    expect(holds.counts("r1")).toMatchObject({ prompts: 2, scheduled: 1 });

    controller.abort();
    await expect(scheduled.accepted).rejects.toMatchObject({
      name: "ScheduledDeliveryCancelledError",
    });
    expect(
      runtime.controlQueuedPrompt?.(["agt_held"], "blk_post", "delete")
    ).toBe(true);
    await expect(post.accepted).rejects.toMatchObject({
      name: "QueuedPromptDeletedError",
    });

    await holds.release("r1", ATTEMPT, "cancelled");
    await kept.settled;
    await settle();
    expect(held.prompts.map((p) => p.text)).toEqual(["kept"]);
  });

  it("transfers an attachment only after release, once, then delivers the prompt once", async () => {
    const prepared = vi.fn(async (_agentId: string, images: PromptImage[]) =>
      images.map((image) => ({
        path: `/runner/files/${image.runnerName}`,
        mimeType: image.mimeType,
      }))
    );
    const { runtime, holds, held } = await fixture({
      preparePromptFiles: prepared,
    });
    await holds.begin("r1", ATTEMPT);
    const delivery = runtime.prompt("agt_held", "see attached", undefined, {
      images: [
        { path: "/local/shot.png", mimeType: "image/png", runnerName: "a.png" },
      ],
    });
    await settle();
    expect(prepared).not.toHaveBeenCalled();
    expect(held.prompts).toEqual([]);

    await holds.release("r1", ATTEMPT, "committed");
    await delivery.settled;
    await settle();
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(held.prompts).toEqual([
      {
        text: "see attached",
        images: [{ path: "/runner/files/a.png", mimeType: "image/png" }],
      },
    ]);
  });

  it("re-queues a file transfer the fence refused instead of failing the prompt", async () => {
    let holds!: RunnerUpdateHolds;
    let refusals = 0;
    const prepared = vi.fn(async (_agentId: string, images: PromptImage[]) => {
      if (refusals++ === 0) {
        // The fence closed while this transfer was on its way.
        await holds.begin("r1", ATTEMPT);
        throw new RunnerUpdateFenced("The runner is updating.");
      }
      return images.map((image) => ({
        path: `/runner/files/${image.runnerName}`,
        mimeType: image.mimeType,
      }));
    });
    const built = await fixture({ preparePromptFiles: prepared });
    holds = built.holds;
    const delivery = built.runtime.prompt("agt_held", "fenced", undefined, {
      images: [
        { path: "/local/x.png", mimeType: "image/png", runnerName: "x.png" },
      ],
    });
    const outcome = vi.fn();
    delivery.accepted.then(
      () => outcome("accepted"),
      () => outcome("rejected")
    );
    await settle();
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(outcome).not.toHaveBeenCalled();
    expect(built.held.prompts).toEqual([]);
    expect(holds.counts("r1")).toMatchObject({ prompts: 1 });

    await holds.release("r1", ATTEMPT, "committed");
    await delivery.settled;
    await settle();
    expect(outcome).toHaveBeenCalledWith("accepted");
    expect(prepared).toHaveBeenCalledTimes(2);
    expect(built.held.prompts.map((p) => p.text)).toEqual(["fenced"]);
  });

  it("surfaces a fence refusal as an error when no hold is on", async () => {
    const prepared = vi.fn(async () => {
      throw new RunnerUpdateFenced("The runner is updating.");
    });
    const { runtime, held } = await fixture({ preparePromptFiles: prepared });
    const delivery = runtime.prompt("agt_held", "unheld", undefined, {
      images: [
        { path: "/local/x.png", mimeType: "image/png", runnerName: "x.png" },
      ],
    });
    await expect(delivery.accepted).rejects.toBeInstanceOf(RunnerUpdateFenced);
    expect(held.prompts).toEqual([]);
  });

  it("holds stop and discard until release and retries one the fence refused", async () => {
    const { runtime, holds, operations, refuse } = await fixture();
    await holds.begin("r1", ATTEMPT);
    let stopped = false;
    const stop = runtime.stop("agt_held", false).then(() => {
      stopped = true;
    });
    const otherStop = runtime.stop("agt_other", false);
    await otherStop;
    await settle();
    expect(operations).toContain("stop:agt_other");
    expect(operations).not.toContain("stop:agt_held");
    expect(stopped).toBe(false);
    expect(holds.counts("r1")).toMatchObject({ stops: 1 });

    await holds.release("r1", ATTEMPT, "committed");
    await stop;
    expect(operations.filter((op) => op === "stop:agt_held")).toHaveLength(1);

    // Without a hold, a fence refusal is the caller's error as before.
    refuse.set("discard", async () => {});
    await expect(runtime.discard("agt_other")).rejects.toBeInstanceOf(
      RunnerUpdateFenced
    );

    // A refusal that arrives once a hold is on waits for it, then goes once.
    refuse.set("discard", () => holds.begin("r2", ATTEMPT).then(() => {}));
    let discarded = false;
    const heldDiscard = runtime.discard("agt_other").then(() => {
      discarded = true;
    });
    await settle();
    expect(discarded).toBe(false);
    await holds.release("r2", ATTEMPT, "fence_released");
    await heldDiscard;
    expect(operations.filter((op) => op === "discard:agt_other")).toHaveLength(
      3
    );
  });
});
