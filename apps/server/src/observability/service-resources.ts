import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";

import type { Pool, PoolClient } from "pg";

import { runCommand } from "../shared/lib/run-command.js";
import type {
  SubsystemHealthState,
  SubsystemSnapshot,
  SubsystemTracker,
} from "./subsystem-tracker.js";

const SAMPLE_INTERVAL_MS = 5_000;
const EXTERNAL_SAMPLE_INTERVAL_MS = 10_000;
const MAX_SAMPLES = 720;
const HTTP_WINDOW_MS = 60_000;
const HTTP_BUCKET_MS = 5_000;
const HTTP_BUCKET_COUNT = HTTP_WINDOW_MS / HTTP_BUCKET_MS;
const MAX_HTTP_DURATIONS_PER_BUCKET = 128;
const DATABASE_PROBE_TIMEOUT_MS = 3_000;
/**
 * `pg_database_size` stats every file in the database directory, so it is far
 * heavier than the liveness probe it rides along with. Sample it on a slow
 * cadence — disk usage moves in minutes, not seconds.
 */
const DATABASE_SIZE_INTERVAL_MS = 300_000;

export type ResourceSample = {
  at: number;
  serverCpuPercent: number;
  serverRssBytes: number;
  serverHeapBytes: number;
  agentCpuPercent: number | null;
  agentRssBytes: number | null;
  hostLoad1: number;
  subsystems: Record<string, SubsystemResourceSample>;
};

export type SubsystemResourceSample = {
  p95DurationMs: number | null;
  failures: number;
  metadata: Record<string, number>;
};

type HttpBucket = {
  startedAt: number;
  requests: number;
  errors: number;
  durationsMs: number[];
};

type HttpSnapshot = {
  requestCount: number;
  errors: number;
  p95DurationMs: number | null;
};

export type HttpRequestToken = {
  startedAt: number;
  finished: boolean;
  generation: number;
};

export type WorkloadSnapshot = {
  runningAgents: number;
  sseClients: number;
  streams: number;
  streamViewers: number;
  terminalObservers: number;
  terminalViewers: number;
  scheduledJobs: number;
  jobMonitors: number;
  gitRefreshesInFlight: number;
  uiEventsPublished: number;
  uiWriteFailures: number;
  terminalPolls: number;
  terminalPollFailures: number;
};

export type ServiceResourcesDeps = {
  pool: Pool;
  probePool: Pool;
  listAgentSessions: () => Promise<Array<{ tmuxSession: string | null }>>;
  getWorkloads: () => WorkloadSnapshot;
  subsystemTrackers: SubsystemTracker[];
  processTreeSupported?: boolean;
  /** Override the platform process probes in focused tests. */
  runProcessCommand?: typeof runCommand;
};

type AgentProcessSnapshot = {
  supported: boolean;
  cpuPercent: number | null;
  rssBytes: number | null;
  processCount: number | null;
  sampledAt: number | null;
  error: string | null;
};

export type ServiceResourcesResponse = {
  collectionEnabled: boolean;
  generatedAt: number;
  processStartedAt: number;
  availableHistoryMs: number;
  sampleIntervalMs: number;
  overall: {
    state: "healthy" | "degraded" | "unavailable" | "unknown";
    reasons: Array<{ code: string; message: string }>;
  };
  capabilities: {
    processTreeMetrics: "available" | "unsupported" | "error";
    eventLoopMetrics: "available";
  };
  current: {
    server: {
      cpuPercent: number;
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
      externalBytes: number;
      uptimeSeconds: number;
    };
    host: {
      load1: number;
      load5: number;
      load15: number;
      cpuCount: number;
      totalMemoryBytes: number;
      freeMemoryBytes: number;
    };
    agents: AgentProcessSnapshot;
    database: {
      state: "healthy" | "unavailable" | "unknown";
      latencyMs: number | null;
      sampledAt: number | null;
      /** On-disk size of the connected database, sampled on its own cadence. */
      sizeBytes: number | null;
      sizeSampledAt: number | null;
      pool: { total: number; idle: number; waiting: number; max: number };
    };
    eventLoop: { p95DelayMs: number };
    http: {
      requestsPerMinute: number;
      inFlight: number;
      errorRatePercent: number;
      p95DurationMs: number | null;
    };
    workloads: WorkloadSnapshot;
  };
  subsystems: SubsystemSnapshot[];
  series: ResourceSample[];
};

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

function ownerSubsystemState(input: {
  active: number;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
}): SubsystemHealthState {
  if (
    input.lastFailedAt !== null &&
    (input.lastSucceededAt === null ||
      input.lastFailedAt >= input.lastSucceededAt)
  ) {
    return "degraded";
  }
  if (input.lastSucceededAt !== null) return "healthy";
  return input.active > 0 ? "running" : "idle";
}

function operationalSubsystem(input: {
  id: string;
  label: string;
  description: string;
  state: SubsystemHealthState;
  runs?: number;
  failures?: number;
  lastDurationMs?: number | null;
  metadata?: Record<string, number>;
}): SubsystemSnapshot {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    state: input.state,
    statusReason: input.state === "degraded" ? "failure" : null,
    expectedCadenceMs: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSucceededAt: null,
    lastFailedAt: null,
    lastDurationMs: input.lastDurationMs ?? null,
    p95DurationMs: input.lastDurationMs ?? null,
    inFlight: 0,
    runs: input.runs ?? 0,
    failures: input.failures ?? 0,
    lastError: null,
    metadata: input.metadata ?? {},
  };
}

export class ServiceResources {
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private samples: ResourceSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private generation = 0;
  private previousCpu = process.cpuUsage();
  private previousCpuAt = performance.now();
  private currentCpuPercent = 0;
  private lastExternalSampleAt = 0;
  private agentProcesses: AgentProcessSnapshot;
  private database: ServiceResourcesResponse["current"]["database"];
  private databaseProbe: Promise<
    ServiceResourcesResponse["current"]["database"]
  > | null = null;
  private databaseSizeBytes: number | null = null;
  private databaseSizeSampledAt: number | null = null;
  private cancelDatabaseProbe: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private httpInFlight = 0;
  private httpBuckets: HttpBucket[] = [];
  private runningAgentCount = 0;
  private workloads: WorkloadSnapshot;
  private previousOwnerCounters: {
    uiEventsPublished: number;
    uiWriteFailures: number;
    terminalPolls: number;
    terminalPollFailures: number;
  } | null = null;
  private ownerHealth = {
    uiEvents: {
      lastSucceededAt: null as number | null,
      lastFailedAt: null as number | null,
    },
    terminalObservers: {
      lastSucceededAt: null as number | null,
      lastFailedAt: null as number | null,
    },
  };

  constructor(private readonly deps: ServiceResourcesDeps) {
    this.agentProcesses = {
      supported:
        deps.processTreeSupported ??
        (process.platform === "darwin" || process.platform === "linux"),
      cpuPercent: null,
      rssBytes: null,
      processCount: null,
      sampledAt: null,
      error: null,
    };
    this.workloads = { ...this.deps.getWorkloads(), runningAgents: 0 };
    this.database = {
      state: "unknown",
      latencyMs: null,
      sampledAt: null,
      sizeBytes: null,
      sizeSampledAt: null,
      pool: this.poolSnapshot(),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    this.previousCpu = process.cpuUsage();
    this.previousCpuAt = performance.now();
    this.eventLoopDelay.enable();
    void this.runSampleLoop(generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.eventLoopDelay.disable();
    this.cancelDatabaseProbe?.();
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.stop();
      this.shutdownPromise = this.deps.probePool.end().catch(() => undefined);
    }
    return this.shutdownPromise;
  }

  setCollectionEnabled(enabled: boolean): void {
    if (enabled) {
      this.start();
      return;
    }
    this.stop();
    this.samples = [];
    this.httpBuckets = [];
    this.httpInFlight = 0;
  }

  isCollectionEnabled(): boolean {
    return this.running;
  }

  requestStarted(): HttpRequestToken {
    if (!this.running) {
      return { startedAt: 0, finished: true, generation: this.generation };
    }
    this.httpInFlight += 1;
    return {
      startedAt: performance.now(),
      finished: false,
      generation: this.generation,
    };
  }

  requestFinished(token: HttpRequestToken, statusCode: number): void {
    if (token.finished) return;
    token.finished = true;
    if (!this.running || token.generation !== this.generation) return;
    this.httpInFlight = Math.max(0, this.httpInFlight - 1);
    const now = Date.now();
    const bucket = this.getHttpBucket(now);
    bucket.requests += 1;
    if (statusCode >= 500) bucket.errors += 1;
    bucket.durationsMs.push(Math.max(0, performance.now() - token.startedAt));
    if (bucket.durationsMs.length > MAX_HTTP_DURATIONS_PER_BUCKET) {
      bucket.durationsMs.splice(
        0,
        bucket.durationsMs.length - MAX_HTTP_DURATIONS_PER_BUCKET
      );
    }
  }

  getHttpObservationStorageSize(): number {
    return this.httpBuckets.reduce(
      (sum, bucket) => sum + bucket.durationsMs.length,
      0
    );
  }

  getSnapshot(windowMs = 60 * 60 * 1000): ServiceResourcesResponse {
    const now = Date.now();
    const memory = process.memoryUsage();
    const [load1, load5, load15] = os.loadavg();
    const http = this.getHttpSnapshot(now);
    const workloads = { ...this.workloads };
    const subsystems = this.getSubsystemSnapshots(now, http, workloads);
    const reasons: Array<{ code: string; message: string }> = [];

    if (this.database.state === "unavailable") {
      reasons.push({
        code: "DB_PROBE_FAILED",
        message: "The latest database probe failed.",
      });
    }
    if (this.database.pool.waiting > 0) {
      reasons.push({
        code: "DB_POOL_WAITING",
        message: `${this.database.pool.waiting} database request${this.database.pool.waiting === 1 ? " is" : "s are"} waiting for a connection.`,
      });
    }
    const delayed = subsystems.filter((item) => item.state === "degraded");
    if (delayed.length > 0) {
      reasons.push({
        code: "SUBSYSTEM_DEGRADED",
        message: `${delayed.map((item) => item.label).join(", ")} ${delayed.length === 1 ? "needs" : "need"} attention.`,
      });
    }
    const eventLoopP95 = round(this.eventLoopDelay.percentile(95) / 1e6, 1);
    if (eventLoopP95 > 100) {
      reasons.push({
        code: "EVENT_LOOP_DELAY_HIGH",
        message: `Event-loop p95 delay is ${eventLoopP95} ms.`,
      });
    }

    const overallState =
      this.database.state === "unavailable"
        ? "unavailable"
        : reasons.length > 0
          ? "degraded"
          : this.samples.length === 0
            ? "unknown"
            : "healthy";

    const series = this.samples.filter((sample) => now - sample.at <= windowMs);

    return {
      collectionEnabled: this.running,
      generatedAt: now,
      processStartedAt: now - process.uptime() * 1000,
      availableHistoryMs:
        series.length > 1 ? series[series.length - 1]!.at - series[0]!.at : 0,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      overall: { state: overallState, reasons },
      capabilities: {
        processTreeMetrics: !this.agentProcesses.supported
          ? "unsupported"
          : this.agentProcesses.error
            ? "error"
            : "available",
        eventLoopMetrics: "available",
      },
      current: {
        server: {
          cpuPercent: this.currentCpuPercent,
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          uptimeSeconds: process.uptime(),
        },
        host: {
          load1,
          load5,
          load15,
          cpuCount: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          freeMemoryBytes: os.freemem(),
        },
        agents: { ...this.agentProcesses },
        database: { ...this.database, pool: this.poolSnapshot() },
        eventLoop: { p95DelayMs: eventLoopP95 },
        http: {
          requestsPerMinute: http.requestCount,
          inFlight: this.httpInFlight,
          errorRatePercent:
            http.requestCount > 0
              ? round((http.errors / http.requestCount) * 100, 1)
              : 0,
          p95DurationMs: http.p95DurationMs,
        },
        workloads,
      },
      subsystems,
      series,
    };
  }

  private getHttpSnapshot(now: number): HttpSnapshot {
    const buckets = this.getActiveHttpBuckets(now);
    const requestCount = buckets.reduce(
      (sum, bucket) => sum + bucket.requests,
      0
    );
    const errors = buckets.reduce((sum, bucket) => sum + bucket.errors, 0);
    return {
      requestCount,
      errors,
      p95DurationMs: percentile95(
        buckets.flatMap((bucket) => bucket.durationsMs)
      ),
    };
  }

  private getSubsystemSnapshots(
    now: number,
    http: HttpSnapshot,
    workloads: WorkloadSnapshot
  ): SubsystemSnapshot[] {
    const operationalSubsystems = [
      operationalSubsystem({
        id: "api-server",
        label: "API server",
        description: "Handles authenticated HTTP, SSE, and WebSocket traffic.",
        state: http.errors > 0 ? "degraded" : "healthy",
        runs: http.requestCount,
        failures: http.errors,
        lastDurationMs: http.p95DurationMs,
        metadata: {
          requestsPerMinute: http.requestCount,
          inFlight: this.httpInFlight,
        },
      }),
      operationalSubsystem({
        id: "database",
        label: "Database",
        description: "PostgreSQL connectivity and connection-pool capacity.",
        state:
          this.database.state === "unavailable"
            ? "degraded"
            : this.database.state === "unknown"
              ? "unknown"
              : this.database.pool.waiting > 0
                ? "degraded"
                : "healthy",
        lastDurationMs: this.database.latencyMs,
        metadata: {
          poolTotal: this.database.pool.total,
          poolIdle: this.database.pool.idle,
          poolWaiting: this.database.pool.waiting,
        },
      }),
      operationalSubsystem({
        id: "job-schedulers",
        label: "Job schedulers",
        description: "Cron schedules and monitors for active automation runs.",
        state:
          workloads.scheduledJobs > 0 || workloads.jobMonitors > 0
            ? "healthy"
            : "idle",
        metadata: {
          scheduledJobs: workloads.scheduledJobs,
          activeMonitors: workloads.jobMonitors,
        },
      }),
      operationalSubsystem({
        id: "ui-event-stream",
        label: "UI event stream",
        description: "Connected browser clients receiving server-sent events.",
        state: ownerSubsystemState({
          active: workloads.sseClients,
          ...this.ownerHealth.uiEvents,
        }),
        runs: workloads.uiEventsPublished,
        failures: workloads.uiWriteFailures,
        metadata: {
          clients: workloads.sseClients,
          eventsPublished: workloads.uiEventsPublished,
          writeFailures: workloads.uiWriteFailures,
        },
      }),
      operationalSubsystem({
        id: "terminal-observers",
        label: "Terminal observers",
        description: "Viewer-driven terminal copy-mode observation.",
        state: ownerSubsystemState({
          active: workloads.terminalObservers,
          ...this.ownerHealth.terminalObservers,
        }),
        runs: workloads.terminalPolls,
        failures: workloads.terminalPollFailures,
        metadata: {
          observers: workloads.terminalObservers,
          viewers: workloads.terminalViewers,
          polls: workloads.terminalPolls,
          pollFailures: workloads.terminalPollFailures,
        },
      }),
    ];
    const trackedSubsystems = this.deps.subsystemTrackers.map((tracker) =>
      tracker.snapshot(now)
    );
    return [...operationalSubsystems, ...trackedSubsystems];
  }

  private async runSampleLoop(generation: number): Promise<void> {
    try {
      await this.sample(generation);
    } catch {
      // Sampling is best-effort; the last committed snapshot remains valid.
    } finally {
      if (!this.isActive(generation)) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.runSampleLoop(generation);
      }, SAMPLE_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  private isActive(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private async sample(generation: number): Promise<void> {
    const now = Date.now();
    const cpuNow = process.cpuUsage();
    const wallNow = performance.now();
    const cpuMicros =
      cpuNow.user -
      this.previousCpu.user +
      cpuNow.system -
      this.previousCpu.system;
    const wallMicros = Math.max(1, (wallNow - this.previousCpuAt) * 1000);
    const currentCpuPercent = round((cpuMicros / wallMicros) * 100, 1);
    let database = this.database;
    let agentProcesses = this.agentProcesses;
    let runningAgentCount = this.runningAgentCount;
    let lastExternalSampleAt = this.lastExternalSampleAt;

    if (now - this.lastExternalSampleAt >= EXTERNAL_SAMPLE_INTERVAL_MS) {
      const [databaseResult, agentResult] = await Promise.all([
        this.sampleDatabase(),
        this.sampleAgentProcesses(),
      ]);
      database = databaseResult;
      agentProcesses = agentResult.processes;
      runningAgentCount = agentResult.runningAgentCount;
      lastExternalSampleAt = now;
    }

    if (!this.isActive(generation)) return;

    const workloads = {
      ...this.deps.getWorkloads(),
      runningAgents: runningAgentCount,
    };
    this.updateOwnerHealth(workloads, now);
    this.workloads = workloads;
    this.currentCpuPercent = currentCpuPercent;
    this.previousCpu = cpuNow;
    this.previousCpuAt = wallNow;
    this.database = database;
    this.agentProcesses = agentProcesses;
    this.runningAgentCount = runningAgentCount;
    this.lastExternalSampleAt = lastExternalSampleAt;

    const memory = process.memoryUsage();
    const subsystemSnapshots = this.getSubsystemSnapshots(
      now,
      this.getHttpSnapshot(now),
      workloads
    );
    this.samples.push({
      at: now,
      serverCpuPercent: currentCpuPercent,
      serverRssBytes: memory.rss,
      serverHeapBytes: memory.heapUsed,
      agentCpuPercent: agentProcesses.cpuPercent,
      agentRssBytes: agentProcesses.rssBytes,
      hostLoad1: os.loadavg()[0],
      subsystems: Object.fromEntries(
        subsystemSnapshots.map((subsystem) => [
          subsystem.id,
          {
            p95DurationMs: subsystem.p95DurationMs,
            failures: subsystem.failures,
            metadata: { ...subsystem.metadata },
          },
        ])
      ),
    });
    if (this.samples.length > MAX_SAMPLES) {
      this.samples = this.samples.slice(-MAX_SAMPLES);
    }
  }

  private async sampleDatabase(): Promise<
    ServiceResourcesResponse["current"]["database"]
  > {
    if (!this.databaseProbe) {
      const { probe, cancel } = this.createDatabaseProbe();
      this.databaseProbe = probe;
      this.cancelDatabaseProbe = cancel;
      void probe.finally(() => {
        if (this.databaseProbe === probe) {
          this.databaseProbe = null;
          this.cancelDatabaseProbe = null;
        }
      });
    }

    return this.databaseProbe;
  }

  private createDatabaseProbe(): {
    probe: Promise<ServiceResourcesResponse["current"]["database"]>;
    cancel: () => void;
  } {
    const started = performance.now();
    let client: PoolClient | null = null;
    let released = false;
    let settled = false;
    let terminalError: Error | undefined;
    let timeout: NodeJS.Timeout | null = null;
    let resolveProbe!: (
      snapshot: ServiceResourcesResponse["current"]["database"]
    ) => void;

    const probe = new Promise<ServiceResourcesResponse["current"]["database"]>(
      (resolve) => {
        resolveProbe = resolve;
      }
    );
    const unavailable = () => ({
      state: "unavailable" as const,
      latencyMs: null,
      sampledAt: Date.now(),
      sizeBytes: this.databaseSizeBytes,
      sizeSampledAt: this.databaseSizeSampledAt,
      pool: this.poolSnapshot(),
    });
    const release = (error?: Error) => {
      if (!client || released) return;
      released = true;
      client.release(error);
    };
    const finish = (
      snapshot: ServiceResourcesResponse["current"]["database"],
      error?: Error
    ) => {
      if (settled) return;
      settled = true;
      terminalError = error;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      release(error);
      resolveProbe(snapshot);
    };
    const cancel = () =>
      finish(unavailable(), new Error("Database probe cancelled"));

    timeout = setTimeout(() => {
      finish(unavailable(), new Error("Database probe timed out"));
    }, DATABASE_PROBE_TIMEOUT_MS);
    timeout.unref?.();

    void this.deps.probePool.connect().then(
      (acquiredClient) => {
        if (settled) {
          acquiredClient.release(
            terminalError ?? new Error("Database probe no longer active")
          );
          return;
        }
        client = acquiredClient;
        void acquiredClient.query("SELECT 1").then(
          () => {
            // Latency belongs to the liveness query alone, so it is read before
            // the size sample — which is throttled and never rejects — piggybacks
            // on the same client.
            const latencyMs = round(performance.now() - started, 1);
            void this.sampleDatabaseSizeIfDue(acquiredClient).then(() => {
              finish({
                state: "healthy",
                latencyMs,
                sampledAt: Date.now(),
                sizeBytes: this.databaseSizeBytes,
                sizeSampledAt: this.databaseSizeSampledAt,
                pool: this.poolSnapshot(),
              });
            });
          },
          (error: unknown) => {
            finish(
              unavailable(),
              error instanceof Error
                ? error
                : new Error("Database probe failed")
            );
          }
        );
      },
      (error: unknown) => {
        finish(
          unavailable(),
          error instanceof Error
            ? error
            : new Error("Database probe connection failed")
        );
      }
    );

    return { probe, cancel };
  }

  /**
   * Refreshes the cached database size when its own interval has elapsed. Never
   * rejects: a failed size query says nothing about connectivity, so it must not
   * downgrade the liveness probe it rides along with. The attempt is stamped
   * either way, so a failing query backs off a full interval instead of retrying
   * on every probe, and the last known size just goes stale.
   */
  private async sampleDatabaseSizeIfDue(client: PoolClient): Promise<void> {
    if (
      this.databaseSizeSampledAt !== null &&
      Date.now() - this.databaseSizeSampledAt < DATABASE_SIZE_INTERVAL_MS
    ) {
      return;
    }
    try {
      const result = await client.query<{ size: string | null }>(
        "SELECT pg_database_size(current_database())::text AS size"
      );
      const parsed = Number(result.rows[0]?.size);
      if (Number.isFinite(parsed)) this.databaseSizeBytes = parsed;
    } catch {
      // Intentionally ignored — see the doc comment.
    }
    this.databaseSizeSampledAt = Date.now();
  }

  private poolSnapshot() {
    return {
      total: this.deps.pool.totalCount,
      idle: this.deps.pool.idleCount,
      waiting: this.deps.pool.waitingCount,
      max: Number(this.deps.pool.options.max ?? 10),
    };
  }

  private async sampleAgentProcesses(): Promise<{
    processes: AgentProcessSnapshot;
    runningAgentCount: number;
  }> {
    let agents: Array<{ tmuxSession: string | null }>;
    try {
      agents = await this.deps.listAgentSessions();
    } catch {
      return {
        processes: {
          ...this.agentProcesses,
          sampledAt: Date.now(),
          error: "Agent session sampling failed",
        },
        runningAgentCount: this.runningAgentCount,
      };
    }

    // Session ownership is platform-independent. Commit its fresh value even
    // when the optional tmux/ps process probe below is unavailable or fails.
    const runningAgentCount = agents.length;
    if (!this.agentProcesses.supported) {
      return {
        processes: { ...this.agentProcesses, error: null },
        runningAgentCount,
      };
    }

    try {
      const sessions = new Set(
        agents
          .map((agent) => agent.tmuxSession?.trim())
          .filter((value): value is string => Boolean(value))
      );
      if (sessions.size === 0) {
        return {
          processes: {
            supported: true,
            cpuPercent: 0,
            rssBytes: 0,
            processCount: 0,
            sampledAt: Date.now(),
            error: null,
          },
          runningAgentCount,
        };
      }

      const run = this.deps.runProcessCommand ?? runCommand;
      const [panes, processes] = await Promise.all([
        run(
          "tmux",
          ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"],
          { allowedExitCodes: [0, 1], timeoutMs: 3_000 }
        ),
        run("ps", ["-axo", "pid=,ppid=,%cpu=,rss="], {
          timeoutMs: 3_000,
        }),
      ]);

      const roots = new Set<number>();
      for (const line of panes.stdout.split("\n")) {
        const [session, pidText] = line.trim().split("\t");
        const pid = Number(pidText);
        if (session && sessions.has(session) && Number.isFinite(pid)) {
          roots.add(pid);
        }
      }

      const rows = processes.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 4)
        .map(([pid, ppid, cpu, rss]) => ({
          pid: Number(pid),
          ppid: Number(ppid),
          cpu: Number(cpu),
          rss: Number(rss),
        }))
        .filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid));
      const included = new Set(roots);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (!included.has(row.pid) && included.has(row.ppid)) {
            included.add(row.pid);
            changed = true;
          }
        }
      }
      const owned = rows.filter((row) => included.has(row.pid));
      return {
        processes: {
          supported: true,
          cpuPercent: round(
            owned.reduce((sum, row) => sum + (row.cpu || 0), 0),
            1
          ),
          rssBytes: owned.reduce((sum, row) => sum + (row.rss || 0) * 1024, 0),
          processCount: owned.length,
          sampledAt: Date.now(),
          error: null,
        },
        runningAgentCount,
      };
    } catch {
      return {
        processes: {
          ...this.agentProcesses,
          sampledAt: Date.now(),
          error: "Process sampling failed",
        },
        runningAgentCount,
      };
    }
  }

  private updateOwnerHealth(workloads: WorkloadSnapshot, now: number): void {
    const previous = this.previousOwnerCounters;
    if (previous) {
      const published = Math.max(
        0,
        workloads.uiEventsPublished - previous.uiEventsPublished
      );
      const writeFailures = Math.max(
        0,
        workloads.uiWriteFailures - previous.uiWriteFailures
      );
      if (writeFailures > 0) {
        this.ownerHealth.uiEvents.lastFailedAt = now;
      } else if (published > 0) {
        this.ownerHealth.uiEvents.lastSucceededAt = now;
      }

      const polls = Math.max(
        0,
        workloads.terminalPolls - previous.terminalPolls
      );
      const pollFailures = Math.max(
        0,
        workloads.terminalPollFailures - previous.terminalPollFailures
      );
      if (pollFailures > 0) {
        this.ownerHealth.terminalObservers.lastFailedAt = now;
      } else if (polls > 0) {
        this.ownerHealth.terminalObservers.lastSucceededAt = now;
      }
    }
    this.previousOwnerCounters = {
      uiEventsPublished: workloads.uiEventsPublished,
      uiWriteFailures: workloads.uiWriteFailures,
      terminalPolls: workloads.terminalPolls,
      terminalPollFailures: workloads.terminalPollFailures,
    };
  }

  private getHttpBucket(now: number): HttpBucket {
    const startedAt = Math.floor(now / HTTP_BUCKET_MS) * HTTP_BUCKET_MS;
    let bucket = this.httpBuckets.find((item) => item.startedAt === startedAt);
    if (!bucket) {
      bucket = { startedAt, requests: 0, errors: 0, durationsMs: [] };
      this.httpBuckets.push(bucket);
    }
    this.httpBuckets = this.getActiveHttpBuckets(now);
    return bucket;
  }

  private getActiveHttpBuckets(now: number): HttpBucket[] {
    const currentBucket = Math.floor(now / HTTP_BUCKET_MS) * HTTP_BUCKET_MS;
    const oldestBucket =
      currentBucket - (HTTP_BUCKET_COUNT - 1) * HTTP_BUCKET_MS;
    return this.httpBuckets.filter(
      (bucket) => bucket.startedAt >= oldestBucket
    );
  }
}
