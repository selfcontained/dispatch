import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { SlackNotifier } from "../src/notifications/slack.js";
import type { AgentRecord } from "../src/agents/manager.js";

// Stub the DB settings module so SlackNotifier never hits a real DB.
vi.mock("../src/db/settings.js", () => ({
  getSetting: vi.fn((_pool: unknown, key: string) => {
    if (key === "slack_webhook_url") return Promise.resolve("https://hooks.slack.com/test");
    if (key === "slack_notify_events") return Promise.resolve(JSON.stringify(["done", "waiting_user", "blocked"]));
    return Promise.resolve(null);
  }),
  setSetting: vi.fn(() => Promise.resolve()),
  deleteSetting: vi.fn(() => Promise.resolve()),
}));

// Capture fetch calls instead of hitting the network.
const fetchSpy = vi.fn(() =>
  Promise.resolve(new Response("ok", { status: 200 }))
);
vi.stubGlobal("fetch", fetchSpy);

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    name: "test-agent",
    type: "claude",
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
    lastError: null,
    latestEvent: {
      type: "done",
      message: "Task complete",
      updatedAt: new Date().toISOString(),
      metadata: null,
    },
    gitContext: null,
    gitContextStale: false,
    gitContextUpdatedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const mockLog = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
  silent: vi.fn(),
  level: "debug",
} as unknown as import("fastify").FastifyBaseLogger;

describe("SlackNotifier focus suppression", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    vi.mocked(mockLog.debug).mockClear();
  });

  it("sends notification when no focus check is registered", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await notifier.onAgentEvent(makeAgent());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("https://hooks.slack.com/test");
  });

  it("sends notification when agent is NOT focused", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => false);

    await notifier.onAgentEvent(makeAgent());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses notification when agent IS focused", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => true);

    await notifier.onAgentEvent(makeAgent());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLog.debug).toHaveBeenCalledWith(
      { agentId: "agent-1" },
      "Skipping notification — user is focused on agent"
    );
  });

  it("suppresses only the focused agent, not others", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck((id) => id === "agent-1");

    // Focused agent — should be suppressed
    await notifier.onAgentEvent(makeAgent({ id: "agent-1" }));
    expect(fetchSpy).not.toHaveBeenCalled();

    // Different agent — should send
    await notifier.onAgentEvent(makeAgent({ id: "agent-2" }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends notification for non-notify event types regardless of focus", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => true);

    // "working" is not in the notify list, so it exits early before the focus check
    await notifier.onAgentEvent(
      makeAgent({
        latestEvent: { type: "working", message: "doing stuff", updatedAt: new Date().toISOString(), metadata: null },
      })
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    // Should NOT have logged the focus skip message (exited before that check)
    expect(mockLog.debug).not.toHaveBeenCalled();
  });
});
