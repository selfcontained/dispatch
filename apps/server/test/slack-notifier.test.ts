import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { SlackNotifier, isValidSlackWebhookUrl } from "../src/notifications/slack.js";
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

describe("isValidSlackWebhookUrl", () => {
  it("accepts valid Slack webhook URLs", () => {
    expect(isValidSlackWebhookUrl("https://hooks.slack.com/services/T00/B00/xxx")).toBe(true);
    expect(isValidSlackWebhookUrl("https://hooks.slack.com/workflows/T00/B00/xxx")).toBe(true);
  });

  it("rejects non-Slack URLs", () => {
    expect(isValidSlackWebhookUrl("https://evil.com/hooks.slack.com/")).toBe(false);
    expect(isValidSlackWebhookUrl("http://hooks.slack.com/services/T00/B00/xxx")).toBe(false);
    expect(isValidSlackWebhookUrl("https://hooks.slack.com.evil.com/foo")).toBe(false);
    expect(isValidSlackWebhookUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isValidSlackWebhookUrl("file:///etc/passwd")).toBe(false);
    expect(isValidSlackWebhookUrl("http://localhost:8080")).toBe(false);
    expect(isValidSlackWebhookUrl("not-a-url")).toBe(false);
    expect(isValidSlackWebhookUrl("")).toBe(false);
  });
});

describe("SlackNotifier webhook URL validation", () => {
  it("rejects invalid URLs in setWebhookUrl", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await expect(notifier.setWebhookUrl("http://169.254.169.254/")).rejects.toThrow(
      "Invalid webhook URL: must start with https://hooks.slack.com/"
    );
  });

  it("allows clearing the webhook URL with empty string", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await expect(notifier.setWebhookUrl("")).resolves.toBeUndefined();
  });

  it("rejects invalid URLs in sendTestMessage", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const result = await notifier.sendTestMessage("http://internal-service:8080/");
    expect(result).toEqual({
      ok: false,
      error: "Invalid webhook URL: must start with https://hooks.slack.com/",
    });
  });
});

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

describe("SlackNotifier.sendNotification (dispatch_notify)", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
  });

  it("sends a notification with default level", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const result = await notifier.sendNotification(makeAgent(), { message: "Hello from agent" });

    expect(result).toEqual({ sent: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.username).toBe("Dispatch");
    expect(body.attachments[0].color).toBe("#3b82f6"); // info blue
    expect(body.attachments[0].blocks[0].text.text).toContain("Hello from agent");
  });

  it("uses custom title and level", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const result = await notifier.sendNotification(makeAgent(), {
      message: "All tests passed",
      title: "CI Report",
      level: "success",
    });

    expect(result).toEqual({ sent: true });
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.attachments[0].color).toBe("#22c55e"); // success green
    expect(body.attachments[0].blocks[0].text.text).toContain("CI Report");
  });

  it("bypasses focus filtering by default", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => true); // agent is focused

    const result = await notifier.sendNotification(makeAgent(), { message: "Important update" });

    expect(result).toEqual({ sent: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("respects focus when respectFocus is true", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => true);

    const result = await notifier.sendNotification(makeAgent(), {
      message: "Skippable update",
      respectFocus: true,
    });

    expect(result).toEqual({ sent: false, reason: "Notification suppressed — user is focused on this agent." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns gracefully when no webhook is configured", async () => {
    const { getSetting } = await import("../src/db/settings.js");
    vi.mocked(getSetting).mockResolvedValueOnce(null); // webhook URL
    vi.mocked(getSetting).mockResolvedValueOnce(null); // notify events

    const notifier = new SlackNotifier(null as never, mockLog);
    const result = await notifier.sendNotification(makeAgent(), { message: "test" });

    expect(result).toEqual({ sent: false, reason: "No Slack webhook configured." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rate limits after 5 notifications in a minute", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const agent = makeAgent();

    // Send 5 — should all succeed
    for (let i = 0; i < 5; i++) {
      const result = await notifier.sendNotification(agent, { message: `msg ${i}` });
      expect(result.sent).toBe(true);
    }

    // 6th should be rate limited
    const result = await notifier.sendNotification(agent, { message: "one too many" });
    expect(result).toEqual({ sent: false, reason: "Rate limited — max 5 notifications per minute per agent." });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("includes branch in context when available", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const agent = makeAgent({
      gitContext: { branch: "feat/notify", defaultBranch: "main" },
    });

    await notifier.sendNotification(agent, { message: "branch test" });

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    const contextText = body.attachments[0].blocks[1].elements[0].text;
    expect(contextText).toContain("feat/notify");
  });
});
