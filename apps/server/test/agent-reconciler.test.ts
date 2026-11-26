import { RunnerRevoked } from "../src/agents/remote/service.js";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createReconciler } from "../src/agents/reconciler.js";
import {
  createInertRuntime,
  type AgentRuntime,
} from "../src/agents/runtime.js";
import type { AgentRecord, AgentStatus } from "../src/agents/types.js";
import type { DiagnosticsRecorder } from "../src/diagnostics.js";

// ── Test scaffolding ────────────────────────────────────────────────────
//
// The reconciler is a factory taking explicit deps. We mock all of them
// rather than standing up a real pg Pool — these tests are about the
// branching logic (which agents get flipped to which status under what
// conditions), not about the DB or runtime in isolation.

const noopLogger = (() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child: () => logger,
  };
  return logger as unknown as import("fastify").FastifyBaseLogger;
})();

type ActiveRow = {
  id: string;
  status: string;
  updatedAt: string;
  lastError?: string | null;
};

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const secondsAgo = (seconds: number): string =>
  new Date(Date.now() - seconds * 1000).toISOString();

const makeAgent = (
  id: string,
  overrides: Partial<AgentRecord> = {}
): AgentRecord => ({
  id,
  name: id,
  type: "claude",
  role: "standard",
  status: "running",
  cwd: "/tmp",
  worktreePath: null,
  worktreeBranch: null,
  simulatorUdid: null,
  filesDir: null,
  agentArgs: [],
  fullAccess: false,
  setupPhase: null,
  archivePhase: null,
  archiveCleanupMode: null,
  lastError: null,

  gitContext: null,
  gitContextStale: false,
  gitContextUpdatedAt: null,
  persona: null,
  parentAgentId: null,
  personaContext: null,
  reviewAgentType: null,
  baseBranch: null,
  cliSessionId: null,
  createdAt: "2026-04-29T00:00:00Z",
  updatedAt: "2026-04-29T00:00:00Z",
  ...overrides,
});

const makeRuntime = (overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
  ...createInertRuntime(),
  tracksProcesses: () => true,
  // Unlike InertRuntime's always-true stub, the default here has no live
  // connection to reconnect to — tests that want a successful reconnect
  // override this explicitly, so the isAlive fallback stays what most
  // reconciler tests actually exercise.
  attach: vi.fn().mockResolvedValue(false),
  isAlive: vi.fn().mockResolvedValue(true),
  listHosted: vi.fn().mockResolvedValue([]),
  stop: vi.fn().mockResolvedValue(undefined),
  readLogTail: vi.fn().mockResolvedValue(""),
  ...overrides,
});

const makeDiagnostics = (
  overrides: Partial<DiagnosticsRecorder> = {}
): DiagnosticsRecorder => ({
  maybeMaintenanceLogs: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

/**
 * Build a reconciler with deps wired to controllable mocks. Returns the
 * reconciler plus handles to the spies the tests want to assert on.
 */
const setup = (args: {
  activeRows: ActiveRow[];
  runtime?: AgentRuntime;
  diagnostics?: Partial<DiagnosticsRecorder>;
  /** Used to seed mocked agent rows that getAgent returns post-mutation. */
  agentsById?: Record<string, AgentRecord>;
  /** Rows returned by the cleanupOrphanedHosts DB query. */
  cleanupAgentRows?: Array<{
    id: string;
    cwd: string;
    runner_id: string;
    host_launch_id: string;
  }>;
}) => {
  const setAgentStatus = vi.fn<
    (id: string, status: AgentStatus, lastError: string | null) => Promise<void>
  >(async () => {});
  const notifyBlocked = vi.fn().mockResolvedValue(undefined);
  const setReconnectProgress = vi.fn().mockResolvedValue(undefined);
  const settleStream = vi.fn().mockResolvedValue(0);
  const getAgent = vi.fn(async (id: string) => args.agentsById?.[id] ?? null);

  // Dispatch by SQL fragment so each pass gets its own response.
  const pool = {
    query: vi.fn(async (text: string) => {
      if (text.includes("status IN ('running'")) {
        return { rows: args.activeRows };
      }
      if (text.includes("host_launch_id IS NOT NULL")) {
        return { rows: args.cleanupAgentRows ?? [] };
      }
      throw new Error(`Unexpected pool.query SQL: ${text.slice(0, 80)}`);
    }),
  } as unknown as import("pg").Pool;

  const runtime = args.runtime ?? makeRuntime();
  const diagnostics = makeDiagnostics(args.diagnostics);

  const reconciler = createReconciler({
    pool,
    logger: noopLogger,
    runtime,
    diagnostics,
    getAgent,
    setAgentStatus,
    notifyBlocked,
    setReconnectProgress,
    settleStream,
  });

  return {
    reconciler,
    pool,
    runtime,
    diagnostics,
    setAgentStatus,
    notifyBlocked,
    setReconnectProgress,
    settleStream,
    getAgent,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileAgentStatuses — archiving rescue", () => {
  it("flags an archiving row that's been stuck > 30s", async () => {
    const { reconciler, getAgent } = setup({
      activeRows: [
        { id: "agt_stuck", status: "archiving", updatedAt: secondsAgo(45) },
      ],
      agentsById: {
        agt_stuck: makeAgent("agt_stuck", { status: "archiving" }),
      },
    });

    const reconciled = await reconciler.reconcileAgentStatuses();

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.id).toBe("agt_stuck");
    expect(getAgent).toHaveBeenCalledWith("agt_stuck");
  });

  it("ignores an archiving row that's still within the 30s grace", async () => {
    const { reconciler, setAgentStatus } = setup({
      activeRows: [
        { id: "agt_archiving", status: "archiving", updatedAt: secondsAgo(15) },
      ],
    });

    const reconciled = await reconciler.reconcileAgentStatuses();
    expect(reconciled).toEqual([]);
    expect(setAgentStatus).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentStatuses — non-tracking runtime (inert mode)", () => {
  it("skips the missing-host branch entirely when tracksProcesses=false", async () => {
    // Even if isAlive would say "gone", the reconciler must not act on it
    // when the runtime has no real processes.
    const runtime = makeRuntime({
      tracksProcesses: () => false,
      isAlive: vi.fn().mockResolvedValue(false),
    });

    const { reconciler, setAgentStatus, notifyBlocked } = setup({
      activeRows: [
        { id: "agt_inert", status: "running", updatedAt: minutesAgo(5) },
      ],
      runtime,
    });

    const reconciled = await reconciler.reconcileAgentStatuses();

    expect(reconciled).toEqual([]);
    expect(runtime.isAlive).not.toHaveBeenCalled();
    expect(setAgentStatus).not.toHaveBeenCalled();
    expect(notifyBlocked).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentStatuses — reconnect latency", () => {
  it("starts reattach attempts for multiple hosts concurrently", async () => {
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const attach = vi.fn().mockImplementation(() => gate);
    const { reconciler } = setup({
      activeRows: [
        { id: "agt_first", status: "running", updatedAt: minutesAgo(2) },
        { id: "agt_second", status: "running", updatedAt: minutesAgo(2) },
      ],
      runtime: makeRuntime({ attach }),
    });

    const pass = reconciler.reconcileAgentStatuses();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attach).toHaveBeenCalledTimes(2);
    release(true);
    await pass;
  });
});

describe("reconcileAgentStatuses — missing-host detection", () => {
  it("records a revoked registration even when reconciliation precedes the host disconnect callback", async () => {
    const runtime = makeRuntime({
      inventoryLiveness: () => async () => {
        throw new RunnerRevoked();
      },
    });
    const { reconciler, setAgentStatus, notifyBlocked } = setup({
      activeRows: [
        { id: "agt_revoked", status: "running", updatedAt: minutesAgo(2) },
      ],
      runtime,
    });
    await reconciler.reconcileAgentStatuses();
    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_revoked",
      "error",
      RunnerRevoked.reason
    );
    expect(notifyBlocked).toHaveBeenCalledWith(
      "agt_revoked",
      RunnerRevoked.reason
    );
    expect(runtime.readLogTail).not.toHaveBeenCalled();
  });

  it("running agent whose host is gone → settles the stream and flips to stopped", async () => {
    const runtime = makeRuntime({ isAlive: vi.fn().mockResolvedValue(false) });
    const { reconciler, setAgentStatus, notifyBlocked, settleStream } = setup({
      activeRows: [
        { id: "agt_died", status: "running", updatedAt: minutesAgo(2) },
      ],
      runtime,
      agentsById: { agt_died: makeAgent("agt_died", { status: "stopped" }) },
    });

    const reconciled = await reconciler.reconcileAgentStatuses();

    expect(runtime.isAlive).toHaveBeenCalledWith("agt_died");
    expect(settleStream).toHaveBeenCalledWith("agt_died", "the agent stopped");
    expect(setAgentStatus).toHaveBeenCalledWith("agt_died", "stopped", null);
    expect(notifyBlocked).not.toHaveBeenCalled();
    expect(reconciled.map((a) => a.id)).toEqual(["agt_died"]);
  });

  it("running agent whose host is alive but missed this attach → stays running, not settled", async () => {
    // The host didn't answer `hello` inside the attach window (busy
    // journal replay, boot contention), but its pid is still there. This
    // must not read the same as "gone" — that flip is what let boot
    // cleanup kill a still-live, possibly mid-turn host.
    const runtime = makeRuntime({
      attach: vi.fn().mockResolvedValue(false),
      isAlive: vi.fn().mockResolvedValue(true),
    });
    const row: ActiveRow = {
      id: "agt_slow",
      status: "running",
      updatedAt: minutesAgo(2),
      lastError: null,
    };
    const { reconciler, setAgentStatus, setReconnectProgress, settleStream } =
      setup({
        activeRows: [row],
        runtime,
      });

    const reconciled = await reconciler.reconcileAgentStatuses();

    expect(runtime.attach).toHaveBeenCalledWith("agt_slow");
    expect(runtime.isAlive).toHaveBeenCalledWith("agt_slow");
    expect(settleStream).not.toHaveBeenCalled();
    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_slow",
      "running",
      "Agent host is alive, but Dispatch cannot reconnect yet. Retrying automatically."
    );
    expect(reconciled).toEqual([]);
    expect(setReconnectProgress).toHaveBeenLastCalledWith(
      "agt_slow",
      "waiting"
    );

    row.lastError =
      "Agent host is alive, but Dispatch cannot reconnect yet. Retrying automatically.";
    await reconciler.reconcileAgentStatuses();
    expect(setAgentStatus).toHaveBeenCalledTimes(1);
    expect(setReconnectProgress).toHaveBeenNthCalledWith(
      2,
      "agt_slow",
      "trying"
    );

    // A later pass (the periodic tick) is where the retry actually lands.
    runtime.attach = vi.fn().mockResolvedValue(true);
    const second = await reconciler.reconcileAgentStatuses();
    expect(second).toEqual([]);
    expect(setAgentStatus).toHaveBeenLastCalledWith(
      "agt_slow",
      "running",
      null
    );
    expect(setReconnectProgress).toHaveBeenLastCalledWith("agt_slow", null);
  });

  it("creating agent past the launch grace with no host → flips to error", async () => {
    const runtime = makeRuntime({ isAlive: vi.fn().mockResolvedValue(false) });
    const { reconciler, setAgentStatus, notifyBlocked } = setup({
      activeRows: [
        {
          id: "agt_neverstarted",
          status: "creating",
          updatedAt: minutesAgo(16),
        },
      ],
      runtime,
    });

    await reconciler.reconcileAgentStatuses();

    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_neverstarted",
      "error",
      null
    );
    expect(notifyBlocked).toHaveBeenCalledWith(
      "agt_neverstarted",
      "Launch failed before the agent became ready."
    );
  });

  it("leaves a creating agent alone inside the launch grace", async () => {
    // Worktree + dependency install run before the host exists.
    const runtime = makeRuntime({ isAlive: vi.fn().mockResolvedValue(false) });
    const { reconciler, setAgentStatus } = setup({
      activeRows: [
        { id: "agt_installing", status: "creating", updatedAt: minutesAgo(5) },
      ],
      runtime,
    });

    expect(await reconciler.reconcileAgentStatuses()).toEqual([]);
    expect(runtime.isAlive).not.toHaveBeenCalled();
    expect(setAgentStatus).not.toHaveBeenCalled();
  });

  it("includes the host log tail in lastError", async () => {
    const runtime = makeRuntime({
      isAlive: vi.fn().mockResolvedValue(false),
      readLogTail: vi.fn().mockResolvedValue("fatal: boom"),
    });
    const { reconciler, notifyBlocked, setAgentStatus } = setup({
      activeRows: [
        { id: "agt_died", status: "running", updatedAt: minutesAgo(2) },
      ],
      runtime,
    });

    await reconciler.reconcileAgentStatuses();

    expect(runtime.readLogTail).toHaveBeenCalledWith("agt_died");
    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_died",
      "stopped",
      "fatal: boom"
    );
    expect(notifyBlocked).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentStatuses — stuck-stopping recovery", () => {
  it("reverts an agent stuck in stopping > 60s back to running", async () => {
    const { reconciler, setAgentStatus, notifyBlocked } = setup({
      activeRows: [
        { id: "agt_stuck_stop", status: "stopping", updatedAt: minutesAgo(2) },
      ],
      // isAlive defaults to true, so we fall through to the stuck check.
    });

    await reconciler.reconcileAgentStatuses();

    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_stuck_stop",
      "running",
      null
    );
    expect(notifyBlocked).not.toHaveBeenCalled();
  });

  it("leaves an agent stopping for < 60s alone (still within grace)", async () => {
    const { reconciler, setAgentStatus } = setup({
      activeRows: [
        { id: "agt_stopping", status: "stopping", updatedAt: secondsAgo(30) },
      ],
    });

    const reconciled = await reconciler.reconcileAgentStatuses();
    expect(reconciled).toEqual([]);
    expect(setAgentStatus).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentStatuses — happy path", () => {
  it("doesn't touch a running agent whose host is still alive", async () => {
    const { reconciler, setAgentStatus, notifyBlocked, settleStream } = setup({
      activeRows: [
        { id: "agt_running", status: "running", updatedAt: minutesAgo(5) },
      ],
      runtime: makeRuntime({ attach: vi.fn().mockResolvedValue(true) }),
    });

    const reconciled = await reconciler.reconcileAgentStatuses();
    expect(reconciled).toEqual([]);
    expect(setAgentStatus).not.toHaveBeenCalled();
    expect(notifyBlocked).not.toHaveBeenCalled();
    expect(settleStream).not.toHaveBeenCalled();
  });

  it("runs the maintenance-log ticker regardless of whether anything needs reconciling", async () => {
    // The ticker is throttled internally; it should still be *called*
    // every reconcile pass so it can decide whether to fire.
    const maybeMaintenanceLogs = vi.fn().mockResolvedValue(undefined);

    const { reconciler } = setup({
      activeRows: [],
      diagnostics: { maybeMaintenanceLogs },
    });

    await reconciler.reconcileAgentStatuses();

    expect(maybeMaintenanceLogs).toHaveBeenCalledTimes(1);
  });
});

describe("cleanupOrphanedHosts", () => {
  const enrolled = "enrolled";
  const ended = (id: string, launchId: string, placement = "local") => ({
    id,
    cwd: placement === "local" ? "/tmp" : "/srv/checkout",
    runner_id: placement,
    host_launch_id: launchId,
  });
  const host = (id: string, launchId?: string) => ({
    session: sessionFromWire(id),
    state: "live" as const,
    ...(launchId && { launchId }),
  });

  it("force-stops a matching ended launch on the local child and an enrolled runner", async () => {
    const retryStop = vi.fn().mockResolvedValue(undefined);
    const runtime = makeRuntime({
      retryStop,
      listSessions: async (placement) => ({
        sessions: placement
          ? [host("agt_remote", "remote-launch")]
          : [host("agt_local", "local-launch")],
      }),
    });
    const { reconciler, pool } = setup({
      activeRows: [],
      runtime,
      cleanupAgentRows: [
        ended("agt_local", "local-launch"),
        ended("agt_remote", "remote-launch", enrolled),
      ],
    });
    await reconciler.cleanupOrphanedHosts();
    expect(vi.mocked(pool.query).mock.calls[0]?.[0]).toMatch(
      /status IN \('stopped', 'error'\)/
    );
    expect(retryStop).toHaveBeenCalledWith(
      "agt_local",
      true,
      null,
      "local-launch",
      true
    );
    expect(retryStop).toHaveBeenCalledWith(
      "agt_remote",
      true,
      enrolled,
      "remote-launch",
      true
    );
    expect(retryStop).toHaveBeenCalledTimes(2);
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("runs the enrolled sweep on subsequent ticks without changing local sweep timing", async () => {
    const retryStop = vi.fn().mockResolvedValue(undefined);
    const listSessions = vi.fn(async () => ({
      sessions: [host("agt_remote", "remote-launch")],
    }));
    const { reconciler } = setup({
      activeRows: [],
      runtime: makeRuntime({ retryStop, listSessions }),
      cleanupAgentRows: [
        ended("agt_local", "local-launch"),
        ended("agt_remote", "remote-launch", enrolled),
      ],
    });
    await reconciler.cleanupOrphanedHosts("enrolled");
    expect(listSessions).toHaveBeenCalledExactlyOnceWith(enrolled, true);
    expect(retryStop).toHaveBeenCalledExactlyOnceWith(
      "agt_remote",
      true,
      enrolled,
      "remote-launch",
      true
    );
  });

  it.each([
    ["unknown to the database", host("agt_unknown", "old-launch")],
    ["on another runner", host("agt_remote", "remote-launch")],
    ["from another instance", host("agt_local", "different-instance")],
    ["from a newer launch", host("agt_local", "new-launch")],
    ["without a verified launch", host("agt_local")],
  ])("refuses a host %s", async (_reason, suspect) => {
    const retryStop = vi.fn().mockResolvedValue(undefined);
    const { reconciler } = setup({
      activeRows: [],
      runtime: makeRuntime({
        retryStop,
        listSessions: async (placement) => ({
          sessions: placement ? [] : [suspect],
        }),
      }),
      cleanupAgentRows: [
        ended("agt_local", "old-launch"),
        ended("agt_remote", "remote-launch", enrolled),
      ],
    });
    await reconciler.cleanupOrphanedHosts();
    expect(retryStop).not.toHaveBeenCalled();
  });

  it("keeps going when one stop fails", async () => {
    const retryStop = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket gone"))
      .mockResolvedValue(undefined);
    const { reconciler } = setup({
      activeRows: [],
      runtime: makeRuntime({
        retryStop,
        listSessions: async () => ({
          sessions: [host("agt_a", "a"), host("agt_b", "b")],
        }),
      }),
      cleanupAgentRows: [ended("agt_a", "a"), ended("agt_b", "b")],
    });
    await reconciler.cleanupOrphanedHosts();
    expect(retryStop).toHaveBeenCalledTimes(2);
  });
});
