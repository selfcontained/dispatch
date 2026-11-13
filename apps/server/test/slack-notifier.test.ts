import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  SlackNotifier,
  isValidSlackWebhookUrl,
} from "../src/notifications/slack.js";
import type { AgentRecord } from "../src/agents/manager.js";

// Stub the DB settings module so SlackNotifier never hits a real DB.
vi.mock("../src/db/settings.js", () => ({
  getSetting: vi.fn((_pool: unknown, key: string) => {
    if (key === "slack_webhook_url")
      return Promise.resolve("https://hooks.slack.com/test");
    if (key === "slack_notify_events")
      return Promise.resolve(JSON.stringify(["waiting_user", "blocked"]));
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
    simulatorUdid: null,
    filesDir: null,
    agentArgs: [],
    fullAccess: false,
    setupPhase: null,
    lastError: null,
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
    expect(
      isValidSlackWebhookUrl("https://hooks.slack.com/services/T00/B00/xxx")
    ).toBe(true);
    expect(
      isValidSlackWebhookUrl("https://hooks.slack.com/workflows/T00/B00/xxx")
    ).toBe(true);
  });

  it("rejects non-Slack URLs", () => {
    expect(isValidSlackWebhookUrl("https://evil.com/hooks.slack.com/")).toBe(
      false
    );
    expect(
      isValidSlackWebhookUrl("http://hooks.slack.com/services/T00/B00/xxx")
    ).toBe(false);
    expect(isValidSlackWebhookUrl("https://hooks.slack.com.evil.com/foo")).toBe(
      false
    );
    expect(
      isValidSlackWebhookUrl("https://169.254.169.254/latest/meta-data")
    ).toBe(false);
    expect(isValidSlackWebhookUrl("file:///etc/passwd")).toBe(false);
    expect(isValidSlackWebhookUrl("http://localhost:8080")).toBe(false);
    expect(isValidSlackWebhookUrl("not-a-url")).toBe(false);
    expect(isValidSlackWebhookUrl("")).toBe(false);
  });
});

describe("SlackNotifier webhook URL validation", () => {
  it("rejects invalid URLs in setWebhookUrl", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await expect(
      notifier.setWebhookUrl("http://169.254.169.254/")
    ).rejects.toThrow(
      "Invalid webhook URL: must start with https://hooks.slack.com/"
    );
  });

  it("allows clearing the webhook URL with empty string", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await expect(notifier.setWebhookUrl("")).resolves.toBeUndefined();
  });

  it("rejects invalid URLs in sendTestMessage", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const result = await notifier.sendTestMessage(
      "http://internal-service:8080/"
    );
    expect(result).toEqual({
      ok: false,
      error: "Invalid webhook URL: must start with https://hooks.slack.com/",
    });
  });
});

async function notifyForAttention(notifier: SlackNotifier, agent: AgentRecord) {
  await notifier.onAttention(agent, {
    type: "waiting_user",
    message: "Needs input",
  });
}

describe("SlackNotifier focus suppression", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    vi.mocked(mockLog.debug).mockClear();
  });

  it("sends notification when no focus check is registered", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await notifyForAttention(notifier, makeAgent());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("https://hooks.slack.com/test");
  });

  it("sends notification when agent is NOT focused", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => false);

    await notifyForAttention(notifier, makeAgent());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses notification when agent IS focused", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => true);

    await notifyForAttention(notifier, makeAgent());

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
    await notifyForAttention(notifier, makeAgent({ id: "agent-1" }));
    expect(fetchSpy).not.toHaveBeenCalled();

    // Different agent — should send
    await notifyForAttention(notifier, makeAgent({ id: "agent-2" }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores non-notify signals before checking focus", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => true);

    // "working" is not in the notify list, so it exits early before the focus check
    await notifier.onAttention(makeAgent(), {
      type: "working",
      message: "doing stuff",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    // Should NOT have logged the focus skip message (exited before that check)
    expect(mockLog.debug).not.toHaveBeenCalled();
  });
});

describe("SlackNotifier.sendNotification (notify)", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
  });

  it("sends a notification with default level", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const result = await notifier.sendNotification(makeAgent(), {
      message: "Hello from agent",
    });

    expect(result).toEqual({ sent: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.username).toBe("Dispatch");
    expect(body.attachments[0].color).toBe("#3b82f6"); // info blue
    expect(body.attachments[0].blocks[0].text.text).toContain(
      "Hello from agent"
    );
  });

  it("uses custom title and level", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const result = await notifier.sendNotification(makeAgent(), {
      message: "All tests passed",
      title: "CI Report",
      level: "success",
    });

    expect(result).toEqual({ sent: true });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(body.attachments[0].color).toBe("#22c55e"); // success green
    expect(body.attachments[0].blocks[0].text.text).toContain("CI Report");
  });

  it("bypasses focus filtering by default", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    notifier.setFocusCheck(() => true); // agent is focused

    const result = await notifier.sendNotification(makeAgent(), {
      message: "Important update",
    });

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

    expect(result).toEqual({
      sent: false,
      reason: "Notification suppressed — user is focused on this agent.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns gracefully when no webhook is configured", async () => {
    const { getSetting } = await import("../src/db/settings.js");
    vi.mocked(getSetting).mockResolvedValueOnce(null); // webhook URL
    vi.mocked(getSetting).mockResolvedValueOnce(null); // notify events

    const notifier = new SlackNotifier(null as never, mockLog);
    const result = await notifier.sendNotification(makeAgent(), {
      message: "test",
    });

    expect(result).toEqual({
      sent: false,
      reason: "No Slack webhook configured.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rate limits after 5 notifications in a minute", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const agent = makeAgent();

    // Send 5 — should all succeed
    for (let i = 0; i < 5; i++) {
      const result = await notifier.sendNotification(agent, {
        message: `msg ${i}`,
      });
      expect(result.sent).toBe(true);
    }

    // 6th should be rate limited
    const result = await notifier.sendNotification(agent, {
      message: "one too many",
    });
    expect(result).toEqual({
      sent: false,
      reason: "Rate limited — max 5 notifications per minute per agent.",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("includes branch in context when available", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const agent = makeAgent({
      gitContext: { branch: "feat/notify", defaultBranch: "main" },
    });

    await notifier.sendNotification(agent, { message: "branch test" });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    const contextText = body.attachments[0].blocks[1].elements[0].text;
    expect(contextText).toContain("feat/notify");
  });

  it("sanitizes Slack mrkdwn injection in message and title", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await notifier.sendNotification(makeAgent(), {
      message: "Check this <!channel> and <!here> ping",
      title: "Alert <!everyone>",
    });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    const messageText = body.attachments[0].blocks[0].text.text;
    expect(messageText).not.toContain("<!channel>");
    expect(messageText).not.toContain("<!here>");
    expect(messageText).not.toContain("<!everyone>");
    expect(messageText).toContain("&lt;!channel&gt;");
    expect(messageText).toContain("&lt;!everyone&gt;");
  });

  it("sanitizes renamed agent names in notify payloads", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await notifier.sendNotification(makeAgent({ name: "<!channel>" }), {
      message: "safe body",
    });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    const sectionText = body.attachments[0].blocks[0].text.text;
    const contextText = body.attachments[0].blocks[1].elements[0].text;
    const fallback = body.attachments[0].fallback;

    expect(sectionText).not.toContain("<!channel>");
    expect(contextText).not.toContain("<!channel>");
    expect(fallback).not.toContain("<!channel>");
    expect(sectionText).toContain("&lt;!channel&gt;");
    expect(contextText).toContain("&lt;!channel&gt;");
    expect(fallback).toContain("&lt;!channel&gt;");
  });

  it("sanitizes renamed agent names in event notifications", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    await notifyForAttention(notifier, makeAgent({ name: "<!here>" }));

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    const sectionText = body.attachments[0].blocks[0].text.text;
    const fallback = body.attachments[0].fallback;

    expect(sectionText).not.toContain("<!here>");
    expect(fallback).not.toContain("<!here>");
    expect(sectionText).toContain("&lt;!here&gt;");
    expect(fallback).toContain("&lt;!here&gt;");
  });

  it("cleans up expired rate limit entries from the map", async () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const agent = makeAgent();
    const map = (
      notifier as unknown as { notifyTimestamps: Map<string, number[]> }
    ).notifyTimestamps;

    // Seed with expired timestamps (>60s ago)
    map.set(agent.id, [Date.now() - 120_000]);
    expect(map.has(agent.id)).toBe(true);

    // Trigger isRateLimited via sendNotification — expired entries get pruned,
    // and if empty the map entry is deleted entirely
    notifier.setFocusCheck(() => true);
    await notifier.sendNotification(agent, {
      message: "trigger cleanup",
      respectFocus: true,
    });

    expect(map.has(agent.id)).toBe(false);
  });
});

describe("notify({ replyTo })", () => {
  beforeEach(() => fetchSpy.mockClear());
  const withApp = (bound: boolean) => {
    const notifier = new SlackNotifier(null as never, mockLog);
    (notifier as any).app = {
      settings: async () => ({ binding: bound ? { generation: "g" } : null }),
    };
    return notifier;
  };
  const input = {
    message: "Done.",
    replyTo: "11111111-1111-4111-8111-111111111111",
  };

  it("routes to the Slack thread reply, never to the channel or webhook", async () => {
    const notifier = withApp(true);
    const threadReply = vi.fn(async () => ({ sent: true }));
    notifier.setThreadReply(threadReply);
    expect(await notifier.sendNotification(makeAgent(), input)).toEqual({
      sent: true,
    });
    expect(threadReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      { replyTo: input.replyTo, message: "Done.", title: undefined }
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without replyTo, answers in the Slack thread the open turn is answering", async () => {
    const notifier = withApp(true);
    const threadReply = vi.fn(async () => ({ sent: true }));
    notifier.setThreadReply(threadReply);
    const turnPost = vi.fn(async () => input.replyTo);
    notifier.setTurnPost(turnPost);
    expect(
      await notifier.sendNotification(makeAgent(), {
        message: "Screens attached.",
        images: ["/tmp/a.png"],
      })
    ).toEqual({ sent: true });
    expect(turnPost).toHaveBeenCalledWith("agent-1");
    expect(threadReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      {
        replyTo: input.replyTo,
        message: "Screens attached.",
        title: undefined,
        images: ["/tmp/a.png"],
      }
    );
    // Outside a Slack turn, or if the lookup fails, it stays a channel alert.
    threadReply.mockClear();
    turnPost.mockResolvedValueOnce(null as never);
    await notifier.sendNotification(makeAgent(), { message: "Heads up." });
    turnPost.mockRejectedValueOnce(new Error("db down"));
    await notifier.sendNotification(makeAgent(), { message: "Heads up 2." });
    expect(threadReply).not.toHaveBeenCalled();
    // respectFocus still suppresses it while the user is watching.
    notifier.setFocusCheck(() => true);
    const focused = await notifier.sendNotification(makeAgent(), {
      message: "Quiet.",
      respectFocus: true,
    });
    expect(focused.reason).toMatch(/focused/);
    expect(threadReply).not.toHaveBeenCalled();
  });

  it("needs the Slack app connected: no webhook fallback", async () => {
    const notifier = withApp(false);
    const threadReply = vi.fn(async () => ({ sent: true }));
    notifier.setThreadReply(threadReply);
    const result = await notifier.sendNotification(makeAgent(), input);
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/Slack app connected/);
    expect(threadReply).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shares notify's per-agent rate limit", async () => {
    const notifier = withApp(true);
    const threadReply = vi.fn(async () => ({ sent: true }));
    notifier.setThreadReply(threadReply);
    for (let i = 0; i < 5; i += 1)
      await notifier.sendNotification(makeAgent(), input);
    const limited = await notifier.sendNotification(makeAgent(), input);
    expect(limited.sent).toBe(false);
    expect(limited.reason).toMatch(/Rate limited/);
    expect(threadReply).toHaveBeenCalledTimes(5);
  });
});

describe("notify({ form })", () => {
  beforeEach(() => fetchSpy.mockClear());
  const withApp = (bound: boolean) => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const postBlocks = vi.fn();
    (notifier as any).app = {
      settings: async () => ({ binding: bound ? { generation: "g" } : null }),
      postBlocks,
    };
    const formNotify = vi.fn(async () => ({
      sent: true,
      delivery: "sent" as const,
      form: { id: "f", streamId: "agent-1", threadId: null },
    }));
    const threadReply = vi.fn(async () => ({ sent: true }));
    notifier.setFormNotify(formNotify);
    notifier.setThreadReply(threadReply);
    return { notifier, formNotify, threadReply, postBlocks };
  };
  const form = {
    fields: [{ id: "v", label: "Version", type: "text" as const }],
  };

  it("hands the form to the immediate form path, not the plain notify message", async () => {
    const { notifier, formNotify, postBlocks } = withApp(true);
    const result = await notifier.sendNotification(makeAgent(), {
      message: "Fill this in",
      title: "Release",
      form,
    });
    expect(result).toMatchObject({ sent: true, delivery: "sent" });
    expect(formNotify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      expect.objectContaining({
        message: "Fill this in",
        title: "Release",
        form,
      })
    );
    expect(postBlocks).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with replyTo, takes the form path (asked in that Slack thread), not a text reply", async () => {
    const { notifier, formNotify, threadReply } = withApp(true);
    const replyTo = "11111111-1111-4111-8111-111111111111";
    await notifier.sendNotification(makeAgent(), {
      message: "x",
      form,
      replyTo,
    });
    expect(formNotify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ replyTo, form })
    );
    expect(threadReply).not.toHaveBeenCalled();
  });

  it("rejects ambiguous combinations before anything is created", async () => {
    const { notifier, formNotify, threadReply } = withApp(true);
    await expect(
      notifier.sendNotification(makeAgent(), {
        message: "x",
        form,
        images: ["/tmp/a.png"],
      })
    ).rejects.toThrow(/images/);
    await expect(
      notifier.sendNotification(makeAgent(), {
        message: "x",
        title: "A",
        form: { ...form, title: "B" },
      })
    ).rejects.toThrow(/title/);
    expect(formNotify).not.toHaveBeenCalled();
    expect(threadReply).not.toHaveBeenCalled();
  });

  it("needs the Slack app connected: creates nothing and never falls back to the webhook", async () => {
    const { notifier, formNotify } = withApp(false);
    const result = await notifier.sendNotification(makeAgent(), {
      message: "x",
      form,
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/Nothing was created/);
    expect(formNotify).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shares notify's per-agent rate limit and refuses before creating", async () => {
    const { notifier, formNotify } = withApp(true);
    for (let i = 0; i < 5; i += 1)
      await notifier.sendNotification(makeAgent(), { message: "x", form });
    const limited = await notifier.sendNotification(makeAgent(), {
      message: "x",
      form,
    });
    expect(limited.reason).toMatch(/Rate limited/);
    expect(formNotify).toHaveBeenCalledTimes(5);
  });
});

describe("notify in the shared Block Kit layout", () => {
  beforeEach(() => fetchSpy.mockClear());
  const bound = () => {
    const notifier = new SlackNotifier(null as never, mockLog);
    const posted: any[] = [];
    (notifier as any).app = {
      settings: async () => ({
        binding: { generation: "g", baseUrl: "http://lan:6767" },
      }),
      postBlocks: async (input: any) => {
        posted.push(input);
        return { channelId: "C1", timestamp: "1.1", generation: "g" };
      },
      hasScope: () => true,
      uploadImage: async () => "F1",
    };
    return { notifier, posted };
  };

  it("posts markdown with the View in Dispatch footer, never a button or the old plain-text blob", async () => {
    const { notifier, posted } = bound();
    const result = await notifier.sendNotification(makeAgent(), {
      title: "Build is green",
      message: "All **42** tests pass. See [CI](https://ci.example/run/1).",
    });
    expect(result).toEqual({ sent: true });
    const blocks = posted[0].blocks;
    expect(blocks.map((b: any) => b.type)).toEqual([
      "context",
      "markdown",
      "context",
    ]);
    expect(blocks[1].text).toContain("[CI](https://ci.example/run/1)");
    expect(blocks[2].elements[0].text).toMatch(
      /^<http:\/\/lan:6767\/agents\/agent-1\|View in Dispatch> · /
    );
    expect(posted[0].text).toContain(
      "<http://lan:6767/agents/agent-1|View in Dispatch>"
    );
    expect(JSON.stringify(posted[0])).not.toMatch(/Delivery does not mean/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses unreadable images before sending anything", async () => {
    const { notifier, posted } = bound();
    const result = await notifier.sendNotification(makeAgent(), {
      message: "pics",
      images: ["/definitely/missing.png"],
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/Can't read image/);
    expect(posted).toHaveLength(0);
  });
});
