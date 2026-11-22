/**
 * A launch whose reply was lost while its runner was held for an update is
 * sent again with the same launch ID once the runner is back, against the
 * real ACP runtime and a scripted host on a real socket. Without a hold, or
 * to a runner that does not reconcile launch IDs, the loss stays uncertain.
 */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAcpRuntime } from "../src/agents/acp/runtime.js";
import {
  RunnerAcknowledgementLost,
  RunnerUnavailable,
  RunnerUpdateFenced,
} from "../src/agents/remote/service.js";
import {
  RunnerUpdateHolds,
  type RunnerHoldState,
} from "../src/agents/remote/update-hold.js";
import type { RuntimeLaunch } from "../src/agents/runtime.js";
import { scriptedHost } from "./runner-update-hold-fixtures.js";

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
const LAUNCH = "6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

type Outcome = "lost" | "fenced" | "error" | "unavailable" | "ok";

async function fixture(options: {
  outcomes: Outcome[];
  reconciles?: boolean;
  /** Polls the runner stays away after each lost reply. */
  offlinePolls?: number;
  beforeLaunchReconcile?: RuntimeLaunch["beforeLaunchReconcile"];
}) {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-launch-"));
  cleanup.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  const host = await scriptedHost(cleanup, stateRoot, "agt_held");
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
  let offline = 0;
  const launches: { launchId?: string }[] = [];
  const outcomes = [...options.outcomes];
  const requestSession = vi.fn(
    async (
      _placement: unknown,
      operation: {
        kind: string;
        agentId: string;
        launch?: { launchId?: string };
      }
    ) => {
      if (operation.kind === "attach")
        return {
          value: true,
          channel: net.createConnection(host.socket),
        };
      if (operation.kind !== "launch") return { value: true };
      const launchId = operation.launch?.launchId;
      launches.push(launchId === undefined ? {} : { launchId });
      const outcome = outcomes.shift() ?? "ok";
      if (outcome === "lost") {
        offline = options.offlinePolls ?? 2;
        throw new RunnerAcknowledgementLost(
          "Runner acknowledgement was lost; execution is unknown."
        );
      }
      if (outcome === "fenced")
        throw new RunnerUpdateFenced("The runner is updating.");
      if (outcome === "error")
        throw new Error("Runner already has a host for this agent");
      if (outcome === "unavailable")
        throw new RunnerUnavailable("The enrolled runner is disconnected.");
      return { value: true };
    }
  );
  const available = vi.fn(() => {
    if (offline > 0) {
      offline--;
      return false;
    }
    return true;
  });
  const runtime = createAcpRuntime({
    config: {
      agentStateRoot: stateRoot,
      agentRuntime: "acp",
      dispatchBinDir: "/nonexistent",
    },
    logger,
    hostSeq: async () => ({ seq: 0, journalId: null }),
    syncJournal: async () => {},
    placement: async (id) =>
      id === "agt_held" ? { runner: "r1", workspace: "proof" } : null,
    remote: {
      requestSession,
      available,
      reconcilesLaunches: () => options.reconciles !== false,
    } as never,
    holds,
    launchRetryPollMs: 5,
  });
  const launch = (launchId: string | null = LAUNCH) =>
    runtime.launch({
      agentId: "agt_held",
      placement: { runner: "r1", workspace: "proof" },
      engine: "claude",
      model: null,
      systemPrompt: null,
      resumeSessionId: null,
      cwd: "runner://r1/proof",
      bins: { claudeBin: "", codexBin: null, opencodeBin: "" },
      env: {},
      pathPrefix: [],
      ...(launchId !== null && { launchId }),
      beforeLaunchReconcile: options.beforeLaunchReconcile,
    } as RuntimeLaunch);
  return { runtime, holds, launches, available, launch };
}

describe("a launch reply lost across a runner update", () => {
  it("sends the same launch again once the runner is back, and adopts one host", async () => {
    const { holds, launches, available, launch } = await fixture({
      outcomes: ["lost", "ok"],
    });
    await holds.begin("r1", ATTEMPT);
    await expect(launch()).resolves.toEqual({
      sessionId: "sess",
      resumed: false,
    });
    expect(launches).toEqual([{ launchId: LAUNCH }, { launchId: LAUNCH }]);
    // It waited for the runner to reconnect before sending again.
    expect(available.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it.each([false, true])(
    "exits a superseded launch, even when the runner stays offline (%s)",
    async (staysOffline) => {
      const superseded = new Error(
        "The agent changed while its runner was held."
      );
      const { holds, launches, launch } = await fixture({
        outcomes: ["lost", "ok"],
        ...(staysOffline && { offlinePolls: Number.MAX_SAFE_INTEGER }),
        beforeLaunchReconcile: async () => {
          throw superseded;
        },
      });
      await holds.begin("r1", ATTEMPT, staysOffline ? { boundMs: 50 } : {});
      await expect(launch()).rejects.toBe(superseded);
      expect(launches).toEqual([{ launchId: LAUNCH }]);
    }
  );

  it("hands a fenced repeat to the caller, which holds it", async () => {
    const { holds, launches, launch } = await fixture({
      outcomes: ["lost", "fenced"],
    });
    await holds.begin("r1", ATTEMPT);
    await expect(launch()).rejects.toBeInstanceOf(RunnerUpdateFenced);
    expect(launches).toEqual([{ launchId: LAUNCH }, { launchId: LAUNCH }]);
  });

  it("keeps the uncertain outcome without a hold", async () => {
    const { launches, launch } = await fixture({ outcomes: ["lost", "ok"] });
    await expect(launch()).rejects.toBeInstanceOf(RunnerAcknowledgementLost);
    expect(launches).toHaveLength(1);
  });

  it("keeps the uncertain outcome for a runner that does not reconcile launch IDs", async () => {
    const { holds, launches, launch } = await fixture({
      outcomes: ["lost", "ok"],
      reconciles: false,
    });
    await holds.begin("r1", ATTEMPT);
    await expect(launch()).rejects.toBeInstanceOf(RunnerAcknowledgementLost);
    expect(launches).toHaveLength(1);
  });

  it("keeps the uncertain outcome for a launch without an ID", async () => {
    const { holds, launches, launch } = await fixture({
      outcomes: ["lost", "ok"],
    });
    await holds.begin("r1", ATTEMPT);
    await expect(launch(null)).rejects.toBeInstanceOf(
      RunnerAcknowledgementLost
    );
    expect(launches).toEqual([{}]);
  });

  it.each(["error", "unavailable"] as const)(
    "does not repeat a launch that ended with a definite %s",
    async (outcome) => {
      const { holds, launches, launch } = await fixture({
        outcomes: [outcome, "ok"],
      });
      await holds.begin("r1", ATTEMPT);
      await expect(launch()).rejects.toThrow();
      expect(launches).toHaveLength(1);
    }
  );

  it("gives up when the runner stays away past the hold's bound", async () => {
    const { holds, launches, launch } = await fixture({
      outcomes: ["lost", "ok"],
      offlinePolls: Number.MAX_SAFE_INTEGER,
    });
    await holds.begin("r1", ATTEMPT, { boundMs: 50 });
    await expect(launch()).rejects.toBeInstanceOf(RunnerAcknowledgementLost);
    expect(launches).toHaveLength(1);
  });

  it("stops after a bounded number of lost replies", async () => {
    const { holds, launches, launch } = await fixture({
      outcomes: Array(10).fill("lost"),
      offlinePolls: 0,
    });
    await holds.begin("r1", ATTEMPT);
    await expect(launch()).rejects.toBeInstanceOf(RunnerAcknowledgementLost);
    expect(launches).toHaveLength(5);
    expect(new Set(launches.map((l) => l.launchId))).toEqual(new Set([LAUNCH]));
  });
});
