import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { SlackNotifier } from "../src/notifications/slack.js";
import type { AgentRecord } from "../src/agents/manager.js";

// Stub the DB settings module so SlackNotifier never hits a real DB.
vi.mock("../src/db/settings.js", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
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

/** A notifier whose Slack app is connected (or not), recording what it posts. */
function withSlackApp(connected: boolean) {
  const notifier = new SlackNotifier(null as never, mockLog);
  const posted: any[] = [];
  (notifier as any).app = {
    settings: async () => ({
      configured: connected,
      binding: connected
        ? { generation: "g", baseUrl: "http://lan:6767" }
        : null,
    }),
    postBlocks: async (input: any) => {
      posted.push(input);
      return { channelId: "C1", timestamp: "1.1", generation: "g" };
    },
    hasScope: () => true,
    uploadImage: async () => "F1",
  };
  return { notifier, posted };
}

describe("SlackNotifier.sendNotification (notify)", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
  });

  it("sends through the Slack app as the agent", async () => {
    const { notifier, posted } = withSlackApp(true);
    const result = await notifier.sendNotification(makeAgent(), {
      message: "Hello from agent",
    });

    expect(result).toEqual({ sent: true });
    expect(posted).toHaveLength(1);
    expect(posted[0].username).toBe("test-agent");
    expect(JSON.stringify(posted[0].blocks)).toContain("Hello from agent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing when the Slack app isn't connected", async () => {
    const { notifier, posted } = withSlackApp(false);
    const result = await notifier.sendNotification(makeAgent(), {
      message: "test",
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/Slack app connected/);
    expect(posted).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bypasses focus filtering by default", async () => {
    const { notifier, posted } = withSlackApp(true);
    notifier.setFocusCheck(() => true); // agent is focused

    const result = await notifier.sendNotification(makeAgent(), {
      message: "Important update",
    });

    expect(result).toEqual({ sent: true });
    expect(posted).toHaveLength(1);
  });

  it("respects focus when respectFocus is true", async () => {
    const { notifier, posted } = withSlackApp(true);
    notifier.setFocusCheck(() => true);

    const result = await notifier.sendNotification(makeAgent(), {
      message: "Skippable update",
      respectFocus: true,
    });

    expect(result).toEqual({
      sent: false,
      reason: "Notification suppressed — user is focused on this agent.",
    });
    expect(posted).toHaveLength(0);
  });

  it("rate limits after 5 notifications in a minute", async () => {
    const { notifier, posted } = withSlackApp(true);
    const agent = makeAgent();

    for (let i = 0; i < 5; i++) {
      const result = await notifier.sendNotification(agent, {
        message: `msg ${i}`,
      });
      expect(result.sent).toBe(true);
    }

    const result = await notifier.sendNotification(agent, {
      message: "one too many",
    });
    expect(result).toEqual({
      sent: false,
      reason: "Rate limited — max 5 notifications per minute per agent.",
    });
    expect(posted).toHaveLength(5);
  });

  it("cleans up expired rate limit entries from the map", async () => {
    const { notifier } = withSlackApp(true);
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

  it("routes to the Slack thread reply, never to the channel", async () => {
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

  it("needs the Slack app connected: nothing is sent otherwise", async () => {
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

  it("needs the Slack app connected: creates nothing otherwise", async () => {
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
      "section",
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
