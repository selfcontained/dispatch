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
    terminalObservers: 0,
    terminalViewers: 0,
    scheduledJobs: 0,
    jobMonitors: 0,
    gitRefreshesInFlight: 0,
    uiEventsPublished: 0,
    uiWriteFailures: 0,
    terminalPolls: 0,
    terminalPollFailures: 0,
  };
}

describe("ServiceResources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
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
      listAgentSessions: async () => [],
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
      listAgentSessions: async () => [],
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
      listAgentSessions: async () => [
        { tmuxSession: "agent-one" },
        { tmuxSession: "agent-two" },
      ],
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
      listAgentSessions: async () => [],
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
      throw new Error("tmux unavailable");
    });
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentSessions: async () => [
        { tmuxSession: "agent-one" },
        { tmuxSession: "agent-two" },
      ],
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

  it("bounds request timing storage and finalizes requests exactly once", () => {
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentSessions: async () => [],
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
      listAgentSessions: async () => [],
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

  it("degrades owner subsystems when recent writes or polls fail", async () => {
    const current = workloads();
    current.sseClients = 1;
    current.terminalObservers = 1;
    const resources = new ServiceResources({
      pool: createPool(),
      probePool: createProbePool(),
      listAgentSessions: async () => [],
      getWorkloads: () => ({ ...current }),
      subsystemTrackers: [],
      processTreeSupported: false,
    });

    resources.start();
    await vi.advanceTimersByTimeAsync(0);
    current.uiEventsPublished += 1;
    current.uiWriteFailures += 1;
    current.terminalPolls += 1;
    current.terminalPollFailures += 1;
    await vi.advanceTimersByTimeAsync(5_000);

    const byId = new Map(
      resources.getSnapshot().subsystems.map((item) => [item.id, item])
    );
    expect(byId.get("ui-event-stream")?.state).toBe("degraded");
    expect(byId.get("terminal-observers")?.state).toBe("degraded");
    resources.stop();
  });
});
