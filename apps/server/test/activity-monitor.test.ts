import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  createActivityMonitor,
  type ActivityMonitorDeps,
} from "../src/agents/activity-monitor.js";

const fakeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => fakeLogger,
  level: "info",
  silent: vi.fn(),
} as unknown as import("fastify").FastifyBaseLogger;

let paneContent = "initial";
let sessionExists = true;

vi.mock("../src/terminal/tmux-terminal.js", () => {
  return {
    TmuxTerminal: class MockTmuxTerminal {
      async hasSession() {
        return sessionExists;
      }
      async captureRecentLines() {
        return paneContent;
      }
      digest(content: string) {
        return content;
      }
    },
  };
});

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

function makePool(rows: Array<Record<string, unknown>>) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as import("pg").Pool;
}

function makeDeps(
  rows: Array<Record<string, unknown>>,
  overrides: Partial<ActivityMonitorDeps> = {}
): ActivityMonitorDeps {
  return {
    pool: makePool(rows),
    logger: fakeLogger,
    correctLatestEvent: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function agentRow(
  overrides: Partial<{
    id: string;
    tmuxSession: string;
    latestEventType: string;
    latestEventUpdatedAt: string;
  }> = {}
) {
  return {
    id: "agt_001",
    tmuxSession: "sess_001",
    latestEventType: "idle",
    latestEventUpdatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("createActivityMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paneContent = "initial";
    sessionExists = true;
  });

  it("records baseline on first tick without correcting", async () => {
    const deps = makeDeps([agentRow()]);
    const monitor = createActivityMonitor(deps);

    await monitor.check();

    expect(deps.correctLatestEvent).not.toHaveBeenCalled();
  });

  it("corrects blocked → working when pane changes", async () => {
    const deps = makeDeps([agentRow({ latestEventType: "blocked" })]);
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    paneContent = "content-B";
    await monitor.check();

    expect(deps.correctLatestEvent).toHaveBeenCalledWith(
      "agt_001",
      UPDATED_AT,
      { type: "working", message: "Activity detected" }
    );
  });

  it("corrects idle → working when pane changes", async () => {
    const deps = makeDeps([agentRow({ latestEventType: "idle" })]);
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    paneContent = "content-B";
    await monitor.check();

    expect(deps.correctLatestEvent).toHaveBeenCalledWith(
      "agt_001",
      UPDATED_AT,
      { type: "working", message: "Activity detected" }
    );
  });

  it("corrects done → working when pane changes", async () => {
    const deps = makeDeps([agentRow({ latestEventType: "done" })]);
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    paneContent = "content-B";
    await monitor.check();

    expect(deps.correctLatestEvent).toHaveBeenCalledWith(
      "agt_001",
      UPDATED_AT,
      { type: "working", message: "Activity detected" }
    );
  });

  it("corrects waiting_user → working when pane changes", async () => {
    const deps = makeDeps([agentRow({ latestEventType: "waiting_user" })]);
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    paneContent = "content-B";
    await monitor.check();

    expect(deps.correctLatestEvent).toHaveBeenCalledWith(
      "agt_001",
      UPDATED_AT,
      { type: "working", message: "Activity detected" }
    );
  });

  it("does not correct when already working and pane active", async () => {
    const deps = makeDeps([agentRow({ latestEventType: "working" })]);
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    paneContent = "content-B";
    await monitor.check();

    expect(deps.correctLatestEvent).not.toHaveBeenCalled();
  });

  it("corrects working → idle after stale threshold", async () => {
    const deps = makeDeps([agentRow({ latestEventType: "working" })]);
    const monitor = createActivityMonitor(deps);

    paneContent = "static-content";
    await monitor.check();

    // Advance time past the 3-minute threshold
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200_000);
    await monitor.check();

    expect(deps.correctLatestEvent).toHaveBeenCalledWith(
      "agt_001",
      UPDATED_AT,
      { type: "idle", message: "No recent activity detected" }
    );

    vi.restoreAllMocks();
  });

  it("does not correct working → idle before threshold", async () => {
    const deps = makeDeps([agentRow({ latestEventType: "working" })]);
    const monitor = createActivityMonitor(deps);

    paneContent = "static-content";
    await monitor.check();

    // Advance time but not past threshold
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await monitor.check();

    expect(deps.correctLatestEvent).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("skips agents whose tmux session is gone", async () => {
    const deps = makeDeps([agentRow()]);
    sessionExists = false;
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    paneContent = "content-B";
    await monitor.check();

    expect(deps.correctLatestEvent).not.toHaveBeenCalled();
  });

  it("does not overwrite when correction loses the race", async () => {
    const correctLatestEvent = vi.fn().mockResolvedValue(false);
    const deps = makeDeps([agentRow({ latestEventType: "blocked" })], {
      correctLatestEvent,
    });
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    paneContent = "content-B";
    await monitor.check();

    expect(correctLatestEvent).toHaveBeenCalledOnce();
    // The correction was attempted but returned false (race lost) — no crash
  });

  it("prunes state for agents no longer running", async () => {
    const pool = makePool([agentRow()]);
    const deps = makeDeps([], { pool });
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    // Agent disappears
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    await monitor.check();

    // Agent reappears with new content — should be baseline (no correction)
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [agentRow()],
    });
    paneContent = "content-B";
    await monitor.check();

    expect(deps.correctLatestEvent).not.toHaveBeenCalled();
  });

  it("forget() drops state for a specific agent", async () => {
    const deps = makeDeps([agentRow()]);
    const monitor = createActivityMonitor(deps);

    paneContent = "content-A";
    await monitor.check();

    monitor.forget("agt_001");

    // Next tick is baseline again — no correction
    paneContent = "content-B";
    await monitor.check();

    expect(deps.correctLatestEvent).not.toHaveBeenCalled();
  });
});
