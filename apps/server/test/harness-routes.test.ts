import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";

import { registerAgentHarnessRoutes } from "../src/routes/agents/harness-routes.js";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function authedGet(url: string) {
  const cookie = await ctx.sessionCookie();
  return ctx.app.inject({ method: "GET", url, headers: { cookie } });
}

async function createAgent(name: string): Promise<string> {
  const cookie = await ctx.sessionCookie();
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/agents",
    headers: { cookie, "content-type": "application/json" },
    payload: { cwd: "/tmp", useWorktree: false, name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().agent.id as string;
}

let agentId: string;

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agent_stream_events");
  await ctx.pool.query("DELETE FROM agent_chat_messages");
  await ctx.pool.query("DELETE FROM agents");
  agentId = await createAgent("Harnessed");
});

describe("the retired turns route", () => {
  // The turns endpoint was the second reader of agent_stream_events; the
  // chat feed's `turn` entries replaced it. The queue route is the control:
  // it proves the 404 is this route's absence and not a broken prefix.
  it("404s where the queue route on the same prefix still answers", async () => {
    const turns = await authedGet(`/api/v1/agents/${agentId}/harness/turns`);
    expect(turns.statusCode).toBe(404);
    const queue = await authedGet(`/api/v1/agents/${agentId}/harness/queue`);
    expect(queue.statusCode).toBe(200);
  });
});

describe("POST /api/v1/agents/:id/harness/interrupt", () => {
  it("409s when nothing is running and 404s for an unknown agent", async () => {
    const cookie = await ctx.sessionCookie();
    const idle = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/harness/interrupt`,
      headers: { cookie },
    });
    expect(idle.statusCode).toBe(409);
    const missing = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/agt_nope/harness/interrupt`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("harness queue routes", () => {
  it("404 when the message is not queued, and for an unknown agent", async () => {
    const cookie = await ctx.sessionCookie();
    const sendNow = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/harness/queue/not-queued/send-now`,
      headers: { cookie },
    });
    expect(sendNow.statusCode).toBe(404);
    expect(sendNow.json().error).toMatch(/no longer queued/);
    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agentId}/harness/queue/not-queued`,
      headers: { cookie },
    });
    expect(remove.statusCode).toBe(404);
    const missing = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/agents/agt_nope/harness/queue/x`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Agent not found.");
  });
});

describe("GET /api/v1/agents/:id/harness/commands", () => {
  it("404s for an unknown agent and returns an empty list for one with no live session", async () => {
    expect(
      (await authedGet("/api/v1/agents/agt_nope/harness/commands")).statusCode
    ).toBe(404);
    const res = await authedGet(`/api/v1/agents/${agentId}/harness/commands`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ commands: [] });
  });
});

describe("GET /api/v1/harness/usage", () => {
  it("lists the four engines", async () => {
    const res = await authedGet("/api/v1/harness/usage");
    expect(res.statusCode).toBe(200);
    expect(res.json().engines.map((e: { id: string }) => e.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
  });
});

describe("GET /api/v1/agents/:id/harness/queue", () => {
  it("returns an empty queue for a running agent and 404s for an unknown one", async () => {
    const empty = await authedGet(`/api/v1/agents/${agentId}/harness/queue`);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ queued: [] });
    const missing = await authedGet("/api/v1/agents/agt_nope/harness/queue");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Agent not found.");
  });

  it("shapes a queued chat prompt with its chat text joined", async () => {
    const app = Fastify();
    const chat = await ctx.pool.query<{ id: string }>(
      `INSERT INTO agent_chat_messages
         (id, agent_id, author_kind, kind, text, attachments, delivered)
       VALUES (gen_random_uuid(), $1, 'user', 'reply', 'queued please',
               '[]'::jsonb, NULL)
       RETURNING id`,
      [agentId]
    );
    const chatId = chat.rows[0].id;
    await registerAgentHarnessRoutes(app, {
      pool: ctx.pool,
      harness: {
        getConfigOptions: () => null,
        getSessionStartedAt: () => null,
        setConfigOption: async () => [],
        getCommands: () => null,
        listQueued: () => [
          {
            id: chatId,
            source: { source: "chat", chatMessageId: chatId },
            createdAt: "2026-09-08T10:00:00.000Z",
          },
          {
            id: "q_2",
            source: {
              source: "agent",
              senderId: "agt_other",
              senderName: "Reviewer",
              text: "take a look",
            },
            createdAt: "2026-09-08T10:00:01.000Z",
          },
        ],
        sendQueuedNow: async () => false,
        removeQueued: () => false,
        interrupt: async () => false,
        runningPromptId: () => null,
        holdQueue: () => ({ release: () => {} }),
        interruptAndWait: async () => false,
      },
      chat: {} as never,
      appLog: app.log,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/harness/queue`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      queued: [
        {
          id: chatId,
          source: "chat",
          text: "queued please",
          chatMessageId: chatId,
          attachments: [],
          createdAt: "2026-09-08T10:00:00.000Z",
        },
        {
          id: "q_2",
          source: "agent",
          text: "take a look",
          senderAgentId: "agt_other",
          senderName: "Reviewer",
          attachments: [],
          createdAt: "2026-09-08T10:00:01.000Z",
        },
      ],
    });
    await app.close();
  });
});

describe("POST /api/v1/agents/:id/harness/turn/edit", () => {
  const RUNNING = "0f3d2a8e-6c4b-4c1e-9b7a-1d2e3f4a5b6c";

  /** The route over stubs that record the order things happen in. */
  async function build(
    opts: {
      running?: string | null;
      recalled?: boolean;
      sendFails?: boolean;
      stopFails?: boolean;
    } = {}
  ) {
    const calls: string[] = [];
    const app = Fastify();
    await registerAgentHarnessRoutes(app, {
      pool: ctx.pool,
      appLog: app.log,
      harness: {
        getConfigOptions: () => null,
        getSessionStartedAt: () => null,
        setConfigOption: async () => [],
        getCommands: () => null,
        listQueued: () => [],
        sendQueuedNow: async () => false,
        removeQueued: () => false,
        interrupt: async () => false,
        runningPromptId: () =>
          opts.running === undefined ? RUNNING : opts.running,
        holdQueue: () => {
          calls.push("hold");
          return {
            release: (firstId?: string) => {
              calls.push(`release:${firstId ?? ""}`);
            },
          };
        },
        interruptAndWait: async () => {
          calls.push("interruptAndWait");
          if (opts.stopFails)
            throw new Error("The agent did not stop in time.");
          return true;
        },
      },
      chat: {
        recallTurn: async (_agent: string, id: string) => {
          calls.push(`recall:${id}`);
          return opts.recalled === false
            ? null
            : { text: "teh typo", attachments: [] };
        },
        sendUserMessage: async (_agent: string, text: string) => {
          calls.push(`send:${text}`);
          if (opts.sendFails) throw new Error("delivery broke");
          return { message: { id: "new-id" }, delivered: null, held: true };
        },
      } as never,
    });
    const post = (payload: unknown, id = agentId) =>
      app.inject({
        method: "POST",
        url: `/api/v1/agents/${id}/harness/turn/edit`,
        headers: { "content-type": "application/json" },
        payload: payload as never,
      });
    return { app, calls, post };
  }

  it("stops the turn, recalls it, sends the edit, and releases it first in line", async () => {
    const { app, calls, post } = await build();
    const res = await post({ chatMessageId: RUNNING, text: "the typo" });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.id).toBe("new-id");
    expect(calls).toEqual([
      "hold",
      "interruptAndWait",
      `recall:${RUNNING}`,
      "send:the typo",
      "release:new-id",
    ]);
    await app.close();
  });

  it("refuses without touching the turn when it is no longer the running one", async () => {
    for (const running of [null, "some-other-message"]) {
      const { app, calls, post } = await build({ running });
      const res = await post({ chatMessageId: RUNNING, text: "the typo" });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("TURN_ENDED");
      expect(calls).toEqual([]);
      await app.close();
    }
  });

  it("validates before it stops anything", async () => {
    const { app, calls, post } = await build();
    expect(
      (await post({ chatMessageId: RUNNING, text: "  " })).statusCode
    ).toBe(400);
    expect((await post({ text: "x" })).statusCode).toBe(400);
    expect(
      (await post({ chatMessageId: RUNNING, text: "x".repeat(20_001) }))
        .statusCode
    ).toBe(400);
    expect(
      (await post({ chatMessageId: RUNNING, text: "x" }, "agt_nope")).statusCode
    ).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("releases the queue when the agent will not stop, and deletes nothing", async () => {
    const { app, calls, post } = await build({ stopFails: true });
    const res = await post({ chatMessageId: RUNNING, text: "the typo" });
    expect(res.statusCode).toBe(502);
    expect(calls).toEqual(["hold", "interruptAndWait", "release:"]);
    await app.close();
  });

  it("releases the queue when the send fails", async () => {
    const { app, calls, post } = await build({ sendFails: true });
    const res = await post({ chatMessageId: RUNNING, text: "the typo" });
    expect(res.statusCode).toBe(502);
    expect(calls[calls.length - 1]).toBe("release:");
    await app.close();
  });

  it("409s when the turn's rows are already gone", async () => {
    const { app, calls, post } = await build({ recalled: false });
    const res = await post({ chatMessageId: RUNNING, text: "the typo" });
    expect(res.statusCode).toBe(409);
    expect(calls).toEqual([
      "hold",
      "interruptAndWait",
      `recall:${RUNNING}`,
      "release:",
    ]);
    await app.close();
  });
});
