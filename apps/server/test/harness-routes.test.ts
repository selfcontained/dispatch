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

describe("GET /api/v1/agents/:id/harness/turns", () => {
  it("404s for an unknown agent and 400s for a bad limit", async () => {
    expect(
      (await authedGet("/api/v1/agents/agt_nope/harness/turns")).statusCode
    ).toBe(404);
    expect(
      (await authedGet(`/api/v1/agents/${agentId}/harness/turns?limit=abc`))
        .statusCode
    ).toBe(400);
  });

  it("returns assembled turns with the chat prompt joined", async () => {
    const chat = await ctx.pool.query<{ id: string }>(
      `INSERT INTO agent_chat_messages (id, agent_id, author_kind, kind, text, attachments, delivered)
       VALUES (gen_random_uuid(), $1, 'user', 'reply', 'look please', '[]'::jsonb, true)
       RETURNING id`,
      [agentId]
    );
    const chatId = chat.rows[0].id;
    await ctx.pool.query(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload) VALUES
        ($1, 1, 'turn', $2::jsonb),
        ($1, 2, 'tool_call', '{"toolKind":"execute","title":"bash","status":"completed","locations":[],"diff":null,"terminalOutput":"ok\\n"}'),
        ($1, 3, 'assistant', '{"text":"hi","streaming":false}')`,
      [
        agentId,
        JSON.stringify({
          state: "settled",
          prompt: { source: "chat", chatMessageId: chatId },
          stopReason: "end_turn",
          endedAt: new Date().toISOString(),
        }),
      ]
    );
    const res = await authedGet(`/api/v1/agents/${agentId}/harness/turns`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      turns: {
        prompt: { source: string; text: string };
        trace: { finalResult?: string; steps: { kind: string }[] };
        result: { text: string; streaming: boolean } | null;
      }[];
    };
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].prompt).toMatchObject({
      source: "chat",
      text: "look please",
    });
    expect(body.turns[0].trace.finalResult).toBe("ok");
    expect(body.turns[0].trace.steps.map((s) => s.kind)).toEqual(["execute"]);
    expect(body.turns[0].result).toEqual({ text: "hi", streaming: false });
    // No harness runs in this app: the queue is empty, and present.
    expect((res.json() as { queued: unknown[] }).queued).toEqual([]);
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

describe("GET /api/v1/agents/:id/harness/usage", () => {
  it("reports the agent's month, null cost when the engine sent none", async () => {
    await ctx.pool.query(
      `UPDATE agents SET type = 'dispatch', model = 'codex/default' WHERE id = $1`,
      [agentId]
    );
    const res = await authedGet(`/api/v1/agents/${agentId}/harness/usage`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      agent: { agentId, tokens: 0, costUsd: null },
    });
    expect(typeof res.json().monthStart).toBe("string");
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
      },
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
          senderName: "Reviewer",
          attachments: [],
          createdAt: "2026-09-08T10:00:01.000Z",
        },
      ],
    });
    await app.close();
  });
});
