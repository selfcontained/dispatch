import os from "node:os";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ServiceResources,
  type WorkloadSnapshot,
} from "../src/observability/service-resources.js";

function createPool(): Pool {
  return {
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    options: { max: 10 },
  } as unknown as Pool;
}

function createProbePool(
  query = vi.fn(async () => ({ rows: [{ ok: 1 }] })),
  end = vi.fn(async () => undefined)
): Pool {
  return {
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
    end,
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    options: { max: 1 },
  } as unknown as Pool;
}

function workloads(): WorkloadSnapshot {
  return {
    runningAgents: 0,
    sseClients: 0,
    streams: 0,
    streamViewers: 0,
    scheduledJobs: 0,
    jobMonitors: 0,
    gitRefreshesInFlight: 0,
    uiEventsPublished: 0,
    uiWriteFailures: 0,
  };
}

describe("ServiceResources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retains host-wide memory changes even when there are no agent processes", async () => {
    const free = vi.spyOn(os, "freemem").mockReturnValue(8 * 1024 ** 3);
    vi.spyOn(os, "totalmem").mockReturnValue(32 * 1024 ** 3);
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
    });
    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    free.mockReturnValue(2 * 1024 ** 3);
    await vi.advanceTimersByTimeAsync(5_000);
    const snapshot = resources.getSnapshot();
    expect(snapshot.series.map((sample) => sample.hostFreeMemoryBytes)).toEqual(
      [8 * 1024 ** 3, 2 * 1024 ** 3]
    );
    expect(
      snapshot.series.every(
        (sample) => sample.hostTotalMemoryBytes === 32 * 1024 ** 3
      )
    ).toBe(true);
    expect(snapshot.current.host.freeMemoryBytes).toBe(2 * 1024 ** 3);
    resources.stop();
  });

  it("serializes slow samples and prevents commits after stop", async () => {
    let resolveQuery: (() => void) | null = null;
    const query = vi.fn(
      () =>
        new Promise<{ rows: never[] }>((resolve) => {
          resolveQuery = () => resolve({ rows: [] });
        })
    );
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(query),
      listAgentProcesses: async () => [],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
    });

    resources.start();
    resources.start();
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(query).toHaveBeenCalledTimes(1);

    const samplesBeforeStop = resources.getSnapshot().series.length;
    resources.stop();
    resolveQuery?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(resources.getSnapshot().series).toHaveLength(samplesBeforeStop);
  });

  it("retires timed-out database probes, retries, and shuts down", async () => {
    let activeClients = 0;
    const releases: Array<Error | undefined> = [];
    const connect = vi.fn(async () => {
      const attempt = connect.mock.calls.length;
      activeClients += 1;
      let released = false;
      return {
        query: vi.fn(() =>
          attempt === 2
            ? Promise.resolve({ rows: [{ ok: 1 }] })
            : new Promise<{ rows: never[] }>(() => {})
        ),
        release: vi.fn((error?: Error) => {
          if (released) throw new Error("client released twice");
          released = true;
          activeClients -= 1;
          releases.push(error);
        }),
      };
    });
    const end = vi.fn(async () => {
      expect(activeClients).toBe(0);
    });
    const probePool = {
      connect,
      end,
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      options: { max: 1 },
    } as unknown as Pool;
    const resources = new ServiceResources({
      pool: createPool(),
      probePool,
      listAgentProcesses: async () => [],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(13_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(resources.getSnapshot().current.database.state).toBe("healthy");
    expect(releases[0]).toBeInstanceOf(Error);
    expect(releases[1]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(activeClients).toBe(1);

    await expect(resources.shutdown()).resolves.toBeUndefined();
    expect(releases[2]).toBeInstanceOf(Error);
    expect(end).toHaveBeenCalledOnce();
  });

  it("counts running agents when process-tree metrics are unsupported", async () => {
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [{ hostPid: 101 }, { hostPid: null }],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(resources.getSnapshot()).toMatchObject({
      capabilities: { processTreeMetrics: "unsupported" },
      current: { workloads: { runningAgents: 2 } },
    });
    resources.stop();
  });

  it("retains subsystem metrics with each resource sample", async () => {
    const current = workloads();
    current.scheduledJobs = 1;
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [],
      getWorkloads: () => ({ ...current }),
      subsystemTrackers: [],
      processTreeSupported: false,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    current.scheduledJobs = 3;
    await vi.advanceTimersByTimeAsync(5_000);

    const { series } = resources.getSnapshot();
    expect(series).toHaveLength(2);
    expect(series[0]?.subsystems["job-schedulers"]?.metadata).toMatchObject({
      scheduledJobs: 1,
    });
    expect(series[1]?.subsystems["job-schedulers"]?.metadata).toMatchObject({
      scheduledJobs: 3,
    });
    expect(series[1]?.subsystems.database?.metadata).toMatchObject({
      poolTotal: 1,
      poolIdle: 1,
      poolWaiting: 0,
    });
    resources.stop();
  });

  it("keeps a fresh running-agent count when process probing fails", async () => {
    const runProcessCommand = vi.fn(async () => {
      throw new Error("ps unavailable");
    });
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [{ hostPid: 101 }, { hostPid: null }],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: true,
      runProcessCommand,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(resources.getSnapshot()).toMatchObject({
      capabilities: { processTreeMetrics: "error" },
      current: { workloads: { runningAgents: 2 } },
    });
    expect(runProcessCommand).toHaveBeenCalled();
    resources.stop();
  });

  it("sums each live host's process tree from ps", async () => {
    const runProcessCommand = vi.fn(async () => ({
      stdout: [
        "  1     0  50.0  9000", // unrelated
        "101     1   1.5  1000", // host of agent one
        "102   101   2.0  2000", // its adapter
        "103   102   0.5   500", // the engine under the adapter
        "201     1   9.0  9000", // not a host
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [{ hostPid: 101 }, { hostPid: null }],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: true,
      runProcessCommand: runProcessCommand as never,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runProcessCommand).toHaveBeenCalledWith(
      "ps",
      ["-axo", "pid=,ppid=,%cpu=,rss="],
      expect.anything()
    );
    expect(resources.getSnapshot()).toMatchObject({
      capabilities: { processTreeMetrics: "available" },
      current: {
        workloads: { runningAgents: 2 },
        agents: { processCount: 3, cpuPercent: 4, rssBytes: 3_500 * 1024 },
      },
    });
    resources.stop();
  });

  it("includes detached child hosts and counts overlapping descendants once", async () => {
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: true,
      listAgentProcesses: async () => [
        { hostPid: 101 },
        { hostPid: 201 },
        { hostPid: 102 },
      ],
      runProcessCommand: vi.fn(async () => ({
        stdout:
          "103 102 1 10\n102 101 1 10\n101 1 1 10\n201 1 1 10\n202 201 1 10",
        stderr: "",
        exitCode: 0,
      })),
    });
    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(resources.getSnapshot().current.agents).toMatchObject({
      processCount: 5,
      rssBytes: 50 * 1024,
      cpuPercent: 5,
    });
    resources.stop();
  });

  it("clears process values after a successful probe followed by failure", async () => {
    const runProcessCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "101 1 1 10", stderr: "", exitCode: 0 })
      .mockRejectedValue(new Error("failed"));
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: true,
      listAgentProcesses: async () => [{ hostPid: 101 }],
      runProcessCommand,
    });
    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(resources.getSnapshot().current.agents.rssBytes).toBe(10 * 1024);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resources.getSnapshot().current.agents).toMatchObject({
      rssBytes: null,
      cpuPercent: null,
      processCount: null,
      error: "Process sampling failed",
    });
    resources.stop();
  });

  it("times out artifact root queries, retries on cadence, and cancels before measurement on opt-out", async () => {
    const query = vi.fn(() => new Promise(() => {}));
    const release = vi.fn();
    const end = vi.fn(async () => undefined);
    const artifactProbePool = {
      connect: vi.fn(async () => ({ query, release })),
      end,
    } as unknown as Pool;
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      artifactProbePool,
      artifactRoots: [],
      listAgentProcesses: async () => [],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
    });
    resources.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(resources.getSnapshot().current.artifacts?.error).toBe(
      "Artifact storage sampling failed"
    );
    await vi.advanceTimersByTimeAsync(297_000);
    expect(query).toHaveBeenCalledTimes(2);
    resources.setCollectionEnabled(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(2);
    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(3);
    await resources.shutdown();
    expect(release).toHaveBeenCalledTimes(3);
    expect(end).toHaveBeenCalledOnce();
    expect(resources.getSnapshot().current.artifacts?.sizeBytes).toBeNull();
  });

  it("samples artifact storage only with opt-in, throttles failures, and retains last success", async () => {
    const sampleArtifactStorage = vi
      .fn()
      .mockResolvedValueOnce(4096)
      .mockRejectedValue(new Error("denied"));
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
      listAgentProcesses: async () => [],
      sampleArtifactStorage,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sampleArtifactStorage).not.toHaveBeenCalled();
    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = resources.getSnapshot().current.artifacts;
    expect(first).toMatchObject({ sizeBytes: 4096, error: null });
    await vi.advanceTimersByTimeAsync(295_000);
    expect(sampleArtifactStorage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resources.getSnapshot().current.artifacts).toMatchObject({
      sizeBytes: 4096,
      sampledAt: first?.sampledAt,
      error: "Artifact storage sampling failed",
    });
    resources.setCollectionEnabled(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sampleArtifactStorage).toHaveBeenCalledTimes(2);
  });

  it("skips ps entirely when no agent has a live host", async () => {
    const runProcessCommand = vi.fn();
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [{ hostPid: null }],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: true,
      runProcessCommand: runProcessCommand as never,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runProcessCommand).not.toHaveBeenCalled();
    expect(resources.getSnapshot().current.agents).toMatchObject({
      processCount: 0,
      rssBytes: 0,
    });
    resources.stop();
  });

  it("bounds request timing storage and finalizes requests exactly once", () => {
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
    });
    resources.start();

    for (let index = 0; index < 5_000; index += 1) {
      const token = resources.requestStarted();
      resources.requestFinished(token, index % 10 === 0 ? 500 : 200);
      resources.requestFinished(token, 500);
    }

    expect(resources.getHttpObservationStorageSize()).toBeLessThanOrEqual(128);
    expect(resources.getSnapshot().current.http).toMatchObject({
      requestsPerMinute: 5_000,
      inFlight: 0,
      errorRatePercent: 10,
    });
    resources.stop();
  });

  it("disables sampling and clears retained observations at runtime", async () => {
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
    });

    const disabledToken = resources.requestStarted();
    resources.requestFinished(disabledToken, 200);
    expect(resources.getSnapshot()).toMatchObject({
      collectionEnabled: false,
      series: [],
    });
    expect(resources.getHttpObservationStorageSize()).toBe(0);

    resources.setCollectionEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    const enabledToken = resources.requestStarted();
    resources.requestFinished(enabledToken, 200);
    expect(resources.getSnapshot().collectionEnabled).toBe(true);
    expect(resources.getSnapshot().series).toHaveLength(1);
    expect(resources.getHttpObservationStorageSize()).toBe(1);

    resources.setCollectionEnabled(false);
    expect(resources.getSnapshot()).toMatchObject({
      collectionEnabled: false,
      series: [],
    });
    expect(resources.getHttpObservationStorageSize()).toBe(0);

    resources.setCollectionEnabled(true);
    const staleToken = resources.requestStarted();
    resources.setCollectionEnabled(false);
    resources.setCollectionEnabled(true);
    resources.requestFinished(staleToken, 200);
    expect(resources.getHttpObservationStorageSize()).toBe(0);
    resources.setCollectionEnabled(false);
  });

  it("samples database size on its own cadence and survives its failure", async () => {
    let sizeCalls = 0;
    let failSize = false;
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes("pg_database_size")) return { rows: [{ ok: 1 }] };
      sizeCalls += 1;
      if (failSize) throw new Error("permission denied");
      return { rows: [{ size: String(4_096 * sizeCalls) }] };
    });
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(query as never),
      listAgentProcesses: async () => [],
      getWorkloads: workloads,
      subsystemTrackers: [],
      processTreeSupported: false,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sizeCalls).toBe(1);
    expect(resources.getSnapshot().current.database).toMatchObject({
      state: "healthy",
      sizeBytes: 4_096,
    });

    // Liveness probes keep running every 10s, but size stays on its own clock.
    await vi.advanceTimersByTimeAsync(240_000);
    expect(sizeCalls).toBe(1);
    expect(resources.getSnapshot().current.database.sizeBytes).toBe(4_096);

    await vi.advanceTimersByTimeAsync(70_000);
    expect(sizeCalls).toBe(2);
    expect(resources.getSnapshot().current.database.sizeBytes).toBe(8_192);

    // A failed size query keeps the last known value and stays healthy.
    failSize = true;
    await vi.advanceTimersByTimeAsync(310_000);
    expect(sizeCalls).toBe(3);
    expect(resources.getSnapshot().current.database).toMatchObject({
      state: "healthy",
      sizeBytes: 8_192,
    });
    resources.stop();
  });

  it("degrades owner subsystems when recent writes or polls fail", async () => {
    const current = workloads();
    current.sseClients = 1;
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentProcesses: async () => [],
      getWorkloads: () => ({ ...current }),
      subsystemTrackers: [],
      processTreeSupported: false,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    current.uiEventsPublished += 1;
    current.uiWriteFailures += 1;
    await vi.advanceTimersByTimeAsync(5_000);

    const byId = new Map(
      resources.getSnapshot().subsystems.map((item) => [item.id, item])
    );
    expect(byId.get("ui-event-stream")?.state).toBe("degraded");
    expect(byId.has("terminal-observers")).toBe(false);
    resources.stop();
  });
});
