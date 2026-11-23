/*
 * The protected update's fence and probation with the local runner child in
 * them (L3): busy checks read through the child, the fence freezes it after
 * hosts stop, the boundary comes from the frozen child, an abort thaws, and
 * a probation start starts it frozen. The update runtime and maintenance are
 * real; the agent manager is a stub, and the child is either the real fence
 * over a real session or a recording stand-in.
 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runnerIdFromWire,
  RunnerCallError,
} from "@dispatch/runner-protocol/contract";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { createUpdateRecoveryRuntime } from "../src/server/update-recovery-runtime.js";
import {
  createLocalRunnerFence,
  type LocalRunnerFence,
} from "../src/runners/local.js";

const TX = "3f0e1c52-4d4b-4b7e-9b61-5a7f8a2f0c11";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function runtimeWith(
  localRunner: LocalRunnerFence | undefined,
  env: NodeJS.ProcessEnv = {},
  order: string[] = []
) {
  const root = await mkdtemp("/tmp/dispatch-l3-fence-");
  roots.push(root);
  vi.stubEnv("DISPATCH_STATE_DIR", root);
  const manager = {
    listAgents: vi.fn(async () => []),
    isPromptHeld: vi.fn(() => false),
    recoveryHostActivity: vi.fn(async () => ({ busy: [], unattached: [] })),
    stopIdleHostsForRecovery: vi.fn(async () => {
      order.push("stop-idle-hosts");
      return { stopped: ["agt_idle"], remaining: [] };
    }),
    updateResumeSnapshot: vi.fn(async () => {
      order.push("resume-receipt");
      return [{ id: "agt_idle", updatedAt: "2026-01-01 00:00:00+00" }];
    }),
    listHostedAgentIds: vi.fn(async () => [] as string[]),
  };
  const stopWriters = vi.fn(async () => {
    order.push("stop-writers");
  });
  const shutdown = vi.fn(async () => {});
  const runtime = createUpdateRecoveryRuntime({
    pool: { query: vi.fn(async () => ({ rows: [{ count: 0 }] })) } as never,
    agentManager: manager as never,
    streamService: { inFlightDeliveryCount: 0 },
    releaseRuntime: { hasActiveCreateJob: () => false },
    config: { port: 12345, filesRoot: root, agentStateRoot: root },
    serverDir: root,
    version: "1.0.1",
    log: log() as never,
    stopWriters,
    shutdown,
    localRunner: () => localRunner,
    env: {
      DISPATCH_RECOVERY_PROBATION_FILE: path.join(root, "probation.json"),
      ...env,
    },
  });
  return { runtime, manager, stopWriters, shutdown, order };
}

/** A stand-in child that records what the fence asked of it. */
function recordingRunner(order: string[] = []) {
  const runner = {
    activity: vi.fn(async () => "idle" as const),
    freeze: vi.fn(async () => {
      order.push("freeze");
    }),
    thaw: vi.fn(async () => {
      order.push("thaw");
    }),
    frozenSessions: vi.fn(async () => 0),
  } satisfies LocalRunnerFence;
  return runner;
}

const session = () =>
  new LocalRunnerSession({
    description: {
      runnerId: runnerIdFromWire("local"),
      displayName: "Local",
      build: { version: "1.0.1" },
      protocol: 1,
      engines: [],
      capabilities: {},
    },
  });

describe("update fence with the local runner child", () => {
  it("defers when the child is unavailable: nothing is stopped or frozen and the gate reopens", async () => {
    // The real fence over a real session with no endpoint: the child is down.
    const unavailable = session();
    const fence = createLocalRunnerFence({
      runner: unavailable,
      current: () => null,
      frozen: false,
      log: log(),
    });
    const freeze = vi.spyOn(fence, "freeze");
    const { runtime, manager, stopWriters } = await runtimeWith(fence);

    const result = await runtime.maintenance.fence({ transactionId: TX });

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: "BUSY",
      reasons: [{ kind: "local-runner", detail: "unavailable" }],
    });
    expect(stopWriters).not.toHaveBeenCalled();
    expect(manager.stopIdleHostsForRecovery).not.toHaveBeenCalled();
    expect(freeze).not.toHaveBeenCalled();
    expect(runtime.maintenance.mode).toBe("normal");
    expect(
      runtime.maintenance.admit({
        method: "POST",
        url: "/api/v1/x",
        headers: {},
      })
    ).toBeNull();
    unavailable.close();
  });

  it("freezes the child after idle hosts stop and the resume receipt is written, then reads the boundary from it", async () => {
    const order: string[] = [];
    const runner = recordingRunner(order);
    const { runtime } = await runtimeWith(runner, {}, order);

    expect(await runtime.maintenance.fence({ transactionId: TX })).toEqual({
      ok: true,
    });
    expect(order).toEqual([
      "stop-writers",
      "stop-idle-hosts",
      "resume-receipt",
      "freeze",
    ]);
    expect(runtime.maintenance.mode).toBe("fenced");

    expect(await runtime.maintenance.boundary()).toMatchObject({
      hostsStopped: true,
      liveHosts: [],
    });
    expect(runner.frozenSessions).toHaveBeenCalledTimes(1);

    runner.frozenSessions.mockResolvedValueOnce(2);
    expect(await runtime.maintenance.boundary()).toMatchObject({
      hostsStopped: false,
      liveHosts: ["local-runner:2"],
    });
    // An unknown answer is never an empty list.
    runner.frozenSessions.mockRejectedValueOnce(new Error("no answer"));
    expect(await runtime.maintenance.boundary()).toMatchObject({
      hostsStopped: false,
      liveHosts: ["local-runner"],
    });
  });

  it("fails the fence and restarts when the child does not confirm its freeze, thawing on the way out", async () => {
    const runner = recordingRunner();
    runner.freeze.mockRejectedValueOnce(new Error("no fence answer"));
    const { runtime, shutdown } = await runtimeWith(runner);

    const result = await runtime.maintenance.fence({ transactionId: TX });

    expect(result).toMatchObject({
      ok: false,
      code: "RUNNER_NOT_FROZEN",
    });
    expect(runtime.maintenance.mode).not.toBe("fenced");
    expect(runner.thaw).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalled());
  });

  it("an aborted fence thaws the child", async () => {
    const runner = recordingRunner();
    const { runtime, shutdown } = await runtimeWith(runner);
    await runtime.maintenance.fence({ transactionId: TX });
    expect(runner.thaw).not.toHaveBeenCalled();

    expect(runtime.maintenance.abort(TX)).toEqual({ ok: true });

    expect(runner.thaw).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalled());
  });

  it("a busy child defers like a busy agent", async () => {
    const runner = recordingRunner();
    runner.activity.mockResolvedValueOnce("busy" as never);
    const { runtime, stopWriters } = await runtimeWith(runner);
    expect(
      await runtime.maintenance.fence({ transactionId: TX })
    ).toMatchObject({
      ok: false,
      code: "BUSY",
      reasons: [{ kind: "local-runner", detail: "busy" }],
    });
    expect(stopWriters).not.toHaveBeenCalled();
    expect(runner.freeze).not.toHaveBeenCalled();
  });
});

describe("probation start", () => {
  it("starts the child frozen in probation, and thawed on a normal start", async () => {
    const probation = await runtimeWith(recordingRunner(), {
      DISPATCH_RECOVERY_PROBATION: "1",
      DISPATCH_RECOVERY_TRANSACTION_ID: TX,
      DISPATCH_RECOVERY_NONCE: "a".repeat(64),
      DISPATCH_RECOVERY_INSTANCE_ID: "instance-a",
      DISPATCH_RECOVERY_EXPECTED_VERSION: "1.0.1",
    });
    await probation.runtime.loadProbation();
    expect(probation.runtime.maintenance.mode).toBe("probation");
    expect(probation.runtime.localRunnerStartsFrozen()).toBe(true);

    const normal = await runtimeWith(recordingRunner());
    await normal.runtime.loadProbation();
    expect(normal.runtime.localRunnerStartsFrozen()).toBe(false);
  });
});

describe("local runner fence", () => {
  const child = (frozen: boolean, fence = vi.fn(async () => {})) => ({
    pid: 4242,
    ready: { frozen },
    fence,
  });
  const health = (sessions: number, working = 0) => ({
    call: vi.fn(async () => ({
      version: "1.0.1",
      sessions,
      working,
      cpuPercent: null,
      memoryUsed: 1,
      memoryTotal: 2,
    })),
  });

  it("answers sessions only from a child that confirmed it is frozen", async () => {
    const running = child(false);
    const fence = createLocalRunnerFence({
      runner: health(0) as never,
      current: () => running,
      frozen: false,
      log: log(),
    });
    fence.ready(running);
    await expect(fence.frozenSessions()).rejects.toThrow(/not confirmed/);
    await fence.freeze();
    expect(running.fence).toHaveBeenCalledWith(true, expect.any(Number));
    expect(fence.wanted).toBe(true);
    await expect(fence.frozenSessions()).resolves.toBe(0);

    // A replacement child that did not start frozen is unknown.
    const replacement = child(false);
    const swapped = createLocalRunnerFence({
      runner: health(0) as never,
      current: () => replacement,
      frozen: true,
      log: log(),
    });
    swapped.ready(replacement);
    await expect(swapped.frozenSessions()).rejects.toThrow(/not confirmed/);
    // One that started frozen (probation, or a restart while frozen) is known.
    const startedFrozen = child(true);
    const probation = createLocalRunnerFence({
      runner: health(1) as never,
      current: () => startedFrozen,
      frozen: true,
      log: log(),
    });
    probation.ready(startedFrozen);
    await expect(probation.frozenSessions()).resolves.toBe(1);
  });

  it("a freeze without the child's answer, or with no child, rejects and keeps restarts frozen", async () => {
    const silent = child(
      false,
      vi.fn(async () => {
        throw new Error("did not answer");
      })
    );
    const fence = createLocalRunnerFence({
      runner: health(0) as never,
      current: () => silent,
      frozen: false,
      log: log(),
    });
    fence.ready(silent);
    await expect(fence.freeze()).rejects.toThrow(/did not answer/);
    await expect(fence.frozenSessions()).rejects.toThrow(/not confirmed/);
    expect(fence.wanted).toBe(true);

    const down = createLocalRunnerFence({
      runner: health(0) as never,
      current: () => null,
      frozen: false,
      log: log(),
    });
    await expect(down.freeze()).rejects.toThrow(/unavailable/);
    expect(down.wanted).toBe(true);
    await down.thaw();
    expect(down.wanted).toBe(false);
  });

  it("counts a session that cannot answer as unavailable, never idle", async () => {
    const unavailable = session();
    const fence = createLocalRunnerFence({
      runner: unavailable,
      current: () => null,
      frozen: false,
      log: log(),
    });
    expect(await fence.activity()).toBe("unavailable");
    const failing = {
      call: vi.fn(async () => {
        throw new RunnerCallError({ code: "timeout", message: "slow" });
      }),
    };
    expect(
      await createLocalRunnerFence({
        runner: failing as never,
        current: () => null,
        frozen: false,
        log: log(),
      }).activity()
    ).toBe("unavailable");
    expect(
      await createLocalRunnerFence({
        runner: health(0, 1) as never,
        current: () => null,
        frozen: false,
        log: log(),
      }).activity()
    ).toBe("busy");
    unavailable.close();
  });
});
