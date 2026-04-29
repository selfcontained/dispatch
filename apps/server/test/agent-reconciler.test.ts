import { beforeEach, describe, expect, it, vi } from "vitest";

import { createReconciler } from "../src/agents/reconciler.js";
import type { AgentRuntime } from "../src/agents/runtime.js";
import type { AgentRecord, AgentStatus } from "../src/agents/types.js";
import type { DiagnosticsRecorder } from "../src/diagnostics.js";

// ── Test scaffolding ────────────────────────────────────────────────────
//
// The reconciler is a factory taking 8 explicit deps. We mock all of them
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
  tmuxSession: string | null;
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
  tmuxSession: null,
  simulatorUdid: null,
  mediaDir: null,
  agentArgs: [],
  fullAccess: false,
  setupPhase: null,
  archivePhase: null,
  archiveCleanupMode: null,
  lastError: null,
  latestEvent: null,
  pins: [],
  gitContext: null,
  gitContextStale: false,
  gitContextUpdatedAt: null,
  persona: null,
  parentAgentId: null,
  personaContext: null,
  reviewAgentType: null,
  review: null,
  baseBranch: null,
  autoReview: false,
  cliSessionId: null,
  createdAt: "2026-04-29T00:00:00Z",
  updatedAt: "2026-04-29T00:00:00Z",
  ...overrides,
});

const makeRuntime = (overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
  tracksSessions: () => true,
  launch: vi.fn(),
  ensureNoExistingSession: vi.fn(),
  stopSession: vi.fn(),
  hasSession: vi.fn().mockResolvedValue(true),
  getCurrentCwd: vi.fn().mockResolvedValue(null),
  listSessions: vi.fn().mockResolvedValue([]),
  killSession: vi.fn().mockResolvedValue(undefined),
  readExitInfo: vi.fn().mockResolvedValue(null),
  readSetupLogTail: vi.fn().mockResolvedValue(""),
  ...overrides,
});

const makeDiagnostics = (
  overrides: Partial<DiagnosticsRecorder> = {}
): DiagnosticsRecorder => ({
  maybeCaptureTmuxInventory: vi.fn().mockResolvedValue(undefined),
  maybeMaintenanceLogs: vi.fn().mockResolvedValue(undefined),
  captureMissingSessionIncident: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

/**
 * Build a reconciler with deps wired to controllable mocks. Returns the
 * reconciler plus handles to the spies the tests want to assert on.
 */
const setup = (args: {
  activeRows: ActiveRow[];
  runtime?: Partial<AgentRuntime>;
  diagnostics?: Partial<DiagnosticsRecorder>;
  /** Used to seed mocked agent rows that getAgent returns post-mutation. */
  agentsById?: Record<string, AgentRecord>;
  /** Rows returned by the cleanupOrphanedSessions DB query. */
  cleanupAgentRows?: Array<{ id: string; status: string }>;
}) => {
  const setAgentStatus = vi.fn().mockResolvedValue(undefined);
  const setSystemLatestEvent = vi.fn().mockResolvedValue(undefined);
  const getAgent = vi.fn(async (id: string) => args.agentsById?.[id] ?? null);

  // Dispatch by SQL fragment so each pass gets its own response —
  // calling the two reconciler methods independently (or in either
  // order) returns the right data without re-wiring the mock.
  const pool = {
    query: vi.fn(async (text: string) => {
      if (text.includes("status IN ('running'")) {
        return { rows: args.activeRows };
      }
      if (text.includes("id IN (")) {
        return { rows: args.cleanupAgentRows ?? [] };
      }
      throw new Error(`Unexpected pool.query SQL: ${text.slice(0, 80)}`);
    }),
  } as unknown as import("pg").Pool;

  const runtime = makeRuntime(args.runtime);
  const diagnostics = makeDiagnostics(args.diagnostics);

  const reconciler = createReconciler({
    pool,
    logger: noopLogger,
    runtime,
    diagnostics,
    sessionPrefix: "dispatch",
    getAgent,
    setAgentStatus,
    setSystemLatestEvent,
  });

  return {
    reconciler,
    pool,
    runtime,
    diagnostics,
    setAgentStatus,
    setSystemLatestEvent,
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
        {
          id: "agt_stuck",
          tmuxSession: "dispatch_agt_stuck",
          status: "archiving",
          updatedAt: secondsAgo(45),
        },
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
        {
          id: "agt_archiving",
          tmuxSession: "dispatch_agt_archiving",
          status: "archiving",
          updatedAt: secondsAgo(15),
        },
      ],
    });

    const reconciled = await reconciler.reconcileAgentStatuses();
    expect(reconciled).toEqual([]);
    expect(setAgentStatus).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentStatuses — non-tracking runtime (inert mode)", () => {
  it("skips the missing-session branch entirely when tracksSessions=false", async () => {
    const runtime = makeRuntime({ tracksSessions: () => false });
    // Even if hasSession would say "missing", the reconciler must not
    // act on that information when the runtime can't reliably track
    // session state.
    runtime.hasSession = vi.fn().mockResolvedValue(false);

    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
      activeRows: [
        {
          id: "agt_inert",
          tmuxSession: "dispatch_agt_inert",
          status: "running",
          updatedAt: minutesAgo(5),
        },
      ],
      runtime,
    });

    const reconciled = await reconciler.reconcileAgentStatuses();

    expect(reconciled).toEqual([]);
    expect(runtime.hasSession).not.toHaveBeenCalled();
    expect(setAgentStatus).not.toHaveBeenCalled();
    expect(setSystemLatestEvent).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentStatuses — missing-session detection", () => {
  it("running agent with vanished session + clean exit → flips to stopped", async () => {
    const runtime = makeRuntime({
      hasSession: vi.fn().mockResolvedValue(false),
      readExitInfo: vi.fn().mockResolvedValue(0),
    });
    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
      activeRows: [
        {
          id: "agt_died",
          tmuxSession: "dispatch_agt_died",
          status: "running",
          updatedAt: minutesAgo(2),
        },
      ],
      runtime,
      agentsById: { agt_died: makeAgent("agt_died", { status: "stopped" }) },
    });

    await reconciler.reconcileAgentStatuses();

    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_died",
      "stopped",
      null,
      "dispatch_agt_died"
    );
    const eventArg = setSystemLatestEvent.mock.calls[0]?.[1];
    expect(eventArg?.type).toBe("idle");
    expect(eventArg?.message).toContain("Session ended normally");
  });

  it("running agent with vanished session + non-zero exit → flips to error", async () => {
    const runtime = makeRuntime({
      hasSession: vi.fn().mockResolvedValue(false),
      readExitInfo: vi.fn().mockResolvedValue(127),
    });
    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
      activeRows: [
        {
          id: "agt_crashed",
          tmuxSession: "dispatch_agt_crashed",
          status: "running",
          updatedAt: minutesAgo(2),
        },
      ],
      runtime,
    });

    await reconciler.reconcileAgentStatuses();

    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_crashed",
      "error",
      null,
      "dispatch_agt_crashed"
    );
    const eventArg = setSystemLatestEvent.mock.calls[0]?.[1];
    expect(eventArg?.type).toBe("blocked");
    expect(eventArg?.message).toContain("exited with code 127");
    expect(eventArg?.metadata?.exitCode).toBe(127);
    expect(eventArg?.metadata?.launchFailed).toBe(true);
  });

  it("creating agent with vanished session → flips to error (launchFailed branch)", async () => {
    // status='creating' is a launch in progress. If the session vanishes
    // before reaching 'running', that's a launch failure regardless of
    // exit code (covers the "exited before becoming ready" path too).
    const runtime = makeRuntime({
      hasSession: vi.fn().mockResolvedValue(false),
      readExitInfo: vi.fn().mockResolvedValue(null),
    });
    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
      activeRows: [
        {
          id: "agt_neverstarted",
          tmuxSession: "dispatch_agt_neverstarted",
          status: "creating",
          updatedAt: secondsAgo(15),
        },
      ],
      runtime,
    });

    await reconciler.reconcileAgentStatuses();

    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_neverstarted",
      "error",
      null,
      "dispatch_agt_neverstarted"
    );
    const eventArg = setSystemLatestEvent.mock.calls[0]?.[1];
    expect(eventArg?.type).toBe("blocked");
    expect(eventArg?.message).toContain(
      "Launch failed before the session became ready"
    );
  });

  it("captures a missing-session diagnostic incident", async () => {
    const runtime = makeRuntime({
      hasSession: vi.fn().mockResolvedValue(false),
      readExitInfo: vi.fn().mockResolvedValue(7),
    });
    const captureMissingSessionIncident = vi.fn().mockResolvedValue(undefined);
    const { reconciler } = setup({
      activeRows: [
        {
          id: "agt_died",
          tmuxSession: "dispatch_agt_died",
          status: "running",
          updatedAt: minutesAgo(2),
        },
      ],
      runtime,
      diagnostics: { captureMissingSessionIncident },
    });

    await reconciler.reconcileAgentStatuses();

    expect(captureMissingSessionIncident).toHaveBeenCalledTimes(1);
    expect(captureMissingSessionIncident.mock.calls[0]?.[0]).toMatchObject({
      agentId: "agt_died",
      tmuxSession: "dispatch_agt_died",
      status: "running",
      exitInfo: 7,
    });
  });

  it("includes the setup-log tail in the system event message when one exists", async () => {
    const runtime = makeRuntime({
      hasSession: vi.fn().mockResolvedValue(false),
      readExitInfo: vi.fn().mockResolvedValue(1),
      readSetupLogTail: vi
        .fn()
        .mockResolvedValue("\n\nSetup log (last 20 lines):\nfatal: boom"),
    });
    const { reconciler, setSystemLatestEvent, setAgentStatus } = setup({
      activeRows: [
        {
          id: "agt_died",
          tmuxSession: "dispatch_agt_died",
          status: "running",
          updatedAt: minutesAgo(2),
        },
      ],
      runtime,
    });

    await reconciler.reconcileAgentStatuses();

    // The tail is passed as `lastError` to setAgentStatus AND woven into
    // the user-facing event message.
    expect(setAgentStatus.mock.calls[0]?.[1]).toBe("error");
    expect(setAgentStatus.mock.calls[0]?.[2]).toContain("fatal: boom");
    expect(setSystemLatestEvent.mock.calls[0]?.[1]?.message).toContain(
      "fatal: boom"
    );
  });
});

describe("reconcileAgentStatuses — stuck-stopping recovery", () => {
  it("reverts an agent stuck in stopping > 60s back to running", async () => {
    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
      activeRows: [
        {
          id: "agt_stuck_stop",
          tmuxSession: "dispatch_agt_stuck_stop",
          status: "stopping",
          updatedAt: minutesAgo(2),
        },
      ],
      // hasSession returns true (default) — so the missing-session branch
      // doesn't fire and we fall through to the stuck-stopping check.
    });

    await reconciler.reconcileAgentStatuses();

    expect(setAgentStatus).toHaveBeenCalledWith(
      "agt_stuck_stop",
      "running",
      null,
      "dispatch_agt_stuck_stop"
    );
    const eventArg = setSystemLatestEvent.mock.calls[0]?.[1];
    expect(eventArg?.type).toBe("working");
    expect(eventArg?.message).toContain("Stop timed out");
  });

  it("leaves an agent stopping for < 60s alone (still within grace)", async () => {
    const { reconciler, setAgentStatus } = setup({
      activeRows: [
        {
          id: "agt_stopping",
          tmuxSession: "dispatch_agt_stopping",
          status: "stopping",
          updatedAt: secondsAgo(30),
        },
      ],
    });

    const reconciled = await reconciler.reconcileAgentStatuses();
    expect(reconciled).toEqual([]);
    expect(setAgentStatus).not.toHaveBeenCalled();
  });
});

describe("reconcileAgentStatuses — happy path", () => {
  it("doesn't touch a running agent whose session is still alive", async () => {
    const { reconciler, setAgentStatus, setSystemLatestEvent } = setup({
      activeRows: [
        {
          id: "agt_running",
          tmuxSession: "dispatch_agt_running",
          status: "running",
          updatedAt: minutesAgo(5),
        },
      ],
      // hasSession default is true
    });

    const reconciled = await reconciler.reconcileAgentStatuses();
    expect(reconciled).toEqual([]);
    expect(setAgentStatus).not.toHaveBeenCalled();
    expect(setSystemLatestEvent).not.toHaveBeenCalled();
  });

  it("runs diagnostics tickers regardless of whether anything needs reconciling", async () => {
    // The maybe* tickers are throttled internally; they should still be
    // *called* every reconcile pass so they can decide whether to fire.
    const maybeCaptureTmuxInventory = vi.fn().mockResolvedValue(undefined);
    const maybeMaintenanceLogs = vi.fn().mockResolvedValue(undefined);

    const { reconciler } = setup({
      activeRows: [],
      diagnostics: { maybeCaptureTmuxInventory, maybeMaintenanceLogs },
    });

    await reconciler.reconcileAgentStatuses();

    expect(maybeCaptureTmuxInventory).toHaveBeenCalledTimes(1);
    expect(maybeMaintenanceLogs).toHaveBeenCalledTimes(1);
  });
});

describe("cleanupOrphanedSessions", () => {
  it("returns early when listSessions yields nothing — no DB query", async () => {
    const runtime = makeRuntime({
      listSessions: vi.fn().mockResolvedValue([]),
    });
    const {
      reconciler,
      runtime: _r,
      pool,
    } = setup({
      activeRows: [],
      runtime,
    });
    void _r;

    await reconciler.cleanupOrphanedSessions();

    // The status-pass SELECT happens once on construction-of-the-mock-
    // sequence, but no second cleanup-pass SELECT should run.
    const queryCalls = vi.mocked(pool.query).mock.calls;
    expect(queryCalls.length).toBeLessThanOrEqual(1);
    expect(runtime.killSession).not.toHaveBeenCalled();
  });

  it("kills sessions whose agents are in a terminal DB status (stopped/error)", async () => {
    const runtime = makeRuntime({
      listSessions: vi.fn().mockResolvedValue([
        { name: "dispatch_agt_aaa111aaaaaa", createdAt: 1700000000 },
        { name: "dispatch_agt_bbb111bbbbbb", createdAt: 1700000100 },
      ]),
    });
    const { reconciler } = setup({
      activeRows: [],
      runtime,
      cleanupAgentRows: [
        { id: "agt_aaa111aaaaaa", status: "stopped" },
        { id: "agt_bbb111bbbbbb", status: "error" },
      ],
    });

    await reconciler.cleanupOrphanedSessions();

    expect(runtime.killSession).toHaveBeenCalledWith(
      "dispatch_agt_aaa111aaaaaa"
    );
    expect(runtime.killSession).toHaveBeenCalledWith(
      "dispatch_agt_bbb111bbbbbb"
    );
    expect(runtime.killSession).toHaveBeenCalledTimes(2);
  });

  it("leaves sessions whose agents are still active alone", async () => {
    const runtime = makeRuntime({
      listSessions: vi
        .fn()
        .mockResolvedValue([
          { name: "dispatch_agt_alive1aliv1a", createdAt: 1700000000 },
        ]),
    });
    const { reconciler } = setup({
      activeRows: [],
      runtime,
      cleanupAgentRows: [{ id: "agt_alive1aliv1a", status: "running" }],
    });

    await reconciler.cleanupOrphanedSessions();
    expect(runtime.killSession).not.toHaveBeenCalled();
  });

  it("leaves sessions with no DB record alone (foreign tmux server safety)", async () => {
    // Could be another dev's tmux session in the same namespace; only
    // sessions THIS DB knows about are eligible for cleanup.
    const runtime = makeRuntime({
      listSessions: vi
        .fn()
        .mockResolvedValue([
          { name: "dispatch_agt_unknwnunknwn", createdAt: 1700000000 },
        ]),
    });
    const { reconciler } = setup({
      activeRows: [],
      runtime,
      cleanupAgentRows: [], // DB has no row for this id
    });

    await reconciler.cleanupOrphanedSessions();
    expect(runtime.killSession).not.toHaveBeenCalled();
  });
});
