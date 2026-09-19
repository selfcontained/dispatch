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
  mediaDir: null,
  agentArgs: [],
  fullAccess: false,
  setupPhase: null,
  archivePhase: null,
  archiveCleanupMode: null,
  lastError: null,
  latestEvent: null,
  gitContext: null,
  gitContextStale: false,
  gitContextUpdatedAt: null,
  persona: null,
  parentAgentId: null,
  personaContext: null,
  reviewAgentType: null,
  baseBranch: null,
  autoReview: false,
  cliSessionId: null,
  createdAt: "2026-04-29T00:00:00Z",
  updatedAt: "2026-04-29T00:00:00Z",
  ...overrides,
});

const makeRuntime = (overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
  ...createInertRuntime(),
  tracksProcesses: () => true,
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
  cleanupAgentRows?: Array<{ id: string; status: string }>;
}) => {
  const setAgentStatus = vi.fn<
    (id: string, status: AgentStatus, lastError: string | null) => Promise<void>
  >(async () => {});
  const setSystemLatestEvent = vi.fn().mockResolvedValue(undefined);
  const settleStream = vi.fn().mockResolvedValue(0);
  const getAgent = vi.fn(async (id: string) => args.agentsById?.[id] ?? null);

  // Dispatch by SQL fragment so each pass gets its own response.
  const pool = {
    query: vi.fn(async (text: string) => {
      if (text.includes("status IN ('running'")) {
        return { rows: args.activeRows };
      }
      if (text.includes("id = ANY(")) {
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
    setSystemLatestEvent,
    settleStream,
  });

  return {
    reconciler,
    pool,
    runtime,
    diagnostics,
    setAgentStatus,
    setSystemLatestEvent,
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

    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
      activeRows: [
        { id: "agt_inert", status: "running", updatedAt: minutesAgo(5) },
      ],
      runtime,
    });

    const reconciled = await reconciler.reconcileAgentStatuses();

    expect(reconciled).toEqual([]);
    expect(runtime.isAlive).not.toHaveBeenCalled();
    expect(setAgentStatus).not.toHaveBeenCalled();
    expect(setSystemLatestEvent).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentStatuses — missing-host detection", () => {
  it("running agent whose host is gone → settles the stream and flips to stopped", async () => {
    const runtime = makeRuntime({ isAlive: vi.fn().mockResolvedValue(false) });
    const { reconciler, setAgentStatus, setSystemLatestEvent, settleStream } =
      setup({
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
    const eventArg = setSystemLatestEvent.mock.calls[0]?.[1];
    expect(eventArg?.type).toBe("idle");
    expect(eventArg?.message).toBe("The agent is no longer running.");
    expect(eventArg?.metadata).toMatchObject({ launchFailed: false });
    expect(reconciled.map((a) => a.id)).toEqual(["agt_died"]);
  });

  it("creating agent past the launch grace with no host → flips to error", async () => {
    const runtime = makeRuntime({ isAlive: vi.fn().mockResolvedValue(false) });
    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
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
    const eventArg = setSystemLatestEvent.mock.calls[0]?.[1];
    expect(eventArg?.type).toBe("blocked");
    expect(eventArg?.message).toContain(
      "Launch failed before the agent became ready"
    );
    expect(eventArg?.metadata?.launchFailed).toBe(true);
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

  it("includes the host log tail in lastError and the system event", async () => {
    const runtime = makeRuntime({
      isAlive: vi.fn().mockResolvedValue(false),
      readLogTail: vi.fn().mockResolvedValue("fatal: boom"),
    });
    const { reconciler, setSystemLatestEvent, setAgentStatus } = setup({
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
    expect(setSystemLatestEvent.mock.calls[0]?.[1]?.message).toBe(
      "The agent is no longer running.\nfatal: boom"
    );
  });
});

describe("reconcileAgentStatuses — stuck-stopping recovery", () => {
  it("reverts an agent stuck in stopping > 60s back to running", async () => {
    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
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
    const eventArg = setSystemLatestEvent.mock.calls[0]?.[1];
    expect(eventArg?.type).toBe("working");
    expect(eventArg?.message).toContain("Stop timed out");
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
    const { reconciler, setAgentStatus, setSystemLatestEvent, settleStream } =
      setup({
        activeRows: [
          { id: "agt_running", status: "running", updatedAt: minutesAgo(5) },
        ],
      });

    const reconciled = await reconciler.reconcileAgentStatuses();
    expect(reconciled).toEqual([]);
    expect(setAgentStatus).not.toHaveBeenCalled();
    expect(setSystemLatestEvent).not.toHaveBeenCalled();
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
  it("returns early when no host is running — no DB query", async () => {
    const { reconciler, runtime, pool } = setup({ activeRows: [] });

    await reconciler.cleanupOrphanedHosts();

    expect(pool.query).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("force-stops hosts whose agents are in a terminal DB status (stopped/error)", async () => {
    const runtime = makeRuntime({
      listHosted: vi
        .fn()
        .mockResolvedValue(["agt_aaa111aaaaaa", "agt_bbb111bbbbbb"]),
    });
    const { reconciler, pool } = setup({
      activeRows: [],
      runtime,
      cleanupAgentRows: [
        { id: "agt_aaa111aaaaaa", status: "stopped" },
        { id: "agt_bbb111bbbbbb", status: "error" },
      ],
    });

    await reconciler.cleanupOrphanedHosts();

    expect(vi.mocked(pool.query).mock.calls[0]?.[1]).toEqual([
      ["agt_aaa111aaaaaa", "agt_bbb111bbbbbb"],
    ]);
    expect(runtime.stop).toHaveBeenCalledWith("agt_aaa111aaaaaa", true);
    expect(runtime.stop).toHaveBeenCalledWith("agt_bbb111bbbbbb", true);
    expect(runtime.stop).toHaveBeenCalledTimes(2);
  });

  it("keeps going when one stop fails", async () => {
    const runtime = makeRuntime({
      listHosted: vi.fn().mockResolvedValue(["agt_a", "agt_b"]),
      stop: vi
        .fn()
        .mockRejectedValueOnce(new Error("socket gone"))
        .mockResolvedValue(undefined),
    });
    const { reconciler } = setup({
      activeRows: [],
      runtime,
      cleanupAgentRows: [
        { id: "agt_a", status: "stopped" },
        { id: "agt_b", status: "stopped" },
      ],
    });

    await expect(reconciler.cleanupOrphanedHosts()).resolves.toBeUndefined();
    expect(runtime.stop).toHaveBeenCalledTimes(2);
  });

  it("leaves hosts whose agents are still active alone", async () => {
    const runtime = makeRuntime({
      listHosted: vi.fn().mockResolvedValue(["agt_alive1aliv1a"]),
    });
    const { reconciler } = setup({
      activeRows: [],
      runtime,
      cleanupAgentRows: [{ id: "agt_alive1aliv1a", status: "running" }],
    });

    await reconciler.cleanupOrphanedHosts();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("leaves hosts with no DB record alone (shared state root safety)", async () => {
    // Could belong to another server instance sharing the state root; only
    // agents THIS DB knows about are eligible for cleanup.
    const runtime = makeRuntime({
      listHosted: vi.fn().mockResolvedValue(["agt_unknwnunknwn"]),
    });
    const { reconciler } = setup({
      activeRows: [],
      runtime,
      cleanupAgentRows: [],
    });

    await reconciler.cleanupOrphanedHosts();
    expect(runtime.stop).not.toHaveBeenCalled();
  });
});
