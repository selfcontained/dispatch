import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";

import { useInjectApp } from "./helpers/inject-app.js";
import { ChatStore } from "../src/chat/store.js";
import { ChatService } from "../src/chat/service.js";
import { registerChatRoutes } from "../src/routes/chat.js";
import { AgentError } from "../src/agents/errors.js";
import { handleAgentError } from "../src/server/http-helpers.js";

const ctx = useInjectApp();

async function authedInject(
  method: "GET" | "POST",
  url: string,
  payload?: unknown
) {
  const cookie = await ctx.sessionCookie();
  return ctx.app.inject({
    method,
    url,
    headers: { cookie, "content-type": "application/json" },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function createAgent(name: string): Promise<string> {
  const res = await authedInject("POST", "/api/v1/agents", {
    cwd: "/tmp",
    useWorktree: false,
    name,
  });
  expect(res.statusCode).toBe(201);
  return res.json().agent.id as string;
}

let agentId: string;
let store: ChatStore;

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agent_chat_messages");
  await ctx.pool.query("DELETE FROM agent_messages");
  await ctx.pool.query("DELETE FROM agent_events");
  await ctx.pool.query("DELETE FROM media");
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
  agentId = await createAgent("Chatty");
  store = new ChatStore(ctx.pool);
});

describe("GET /api/v1/agents/:id/chat", () => {
  it("404s for an unknown agent", async () => {
    const res = await authedInject("GET", "/api/v1/agents/agt_nope/chat");
    expect(res.statusCode).toBe(404);
  });

  it("validates before and limit", async () => {
    const bad = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/chat?before=yesterday`
    );
    expect(bad.statusCode).toBe(400);
    const badLimit = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/chat?limit=lots`
    );
    expect(badLimit.statusCode).toBe(400);
  });

  it("returns the composed feed with unreadCount", async () => {
    await store.insert({ agentId, authorKind: "agent", text: "hi there" });
    const res = await authedInject("GET", `/api/v1/agents/${agentId}/chat`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasMore).toBe(false);
    expect(body.unreadCount).toBe(1);
    // The agent create emitted status rows too; the chat row is present.
    expect(
      body.entries.some(
        (e: { type: string; message?: { text: string } }) =>
          e.type === "chat" && e.message?.text === "hi there"
      )
    ).toBe(true);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/chat`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/v1/agents/:id/chat/messages (inert runtime)", () => {
  it("400s on missing or oversized text", async () => {
    const empty = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/messages`,
      { text: "   " }
    );
    expect(empty.statusCode).toBe(400);
    const big = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/messages`,
      { text: "x".repeat(20_001) }
    );
    expect(big.statusCode).toBe(400);
    expect(big.json().error).toMatch(/20000 characters or fewer/);
  });

  it("409s when the agent has no tmux session, and persists nothing", async () => {
    // Same boundary as terminal inject-text: agents run inert in tests.
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/messages`,
      { text: "hello?" }
    );
    expect(res.statusCode).toBe(409);
    const rows = await ctx.pool.query(
      "SELECT 1 FROM agent_chat_messages WHERE agent_id = $1",
      [agentId]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("404s for an unknown agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nope/chat/messages",
      { text: "hello?" }
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/agents/:id/chat/messages/:messageId/answer (inert runtime)", () => {
  it("404s when the message is not a question on this agent", async () => {
    const plain = await store.insert({
      agentId,
      authorKind: "agent",
      text: "plain",
    });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/messages/${plain.id}/answer`,
      { value: "a" }
    );
    expect(res.statusCode).toBe(404);
  });

  it("409s once a question is answered, before checking deliverability", async () => {
    const q = await store.insert({
      agentId,
      authorKind: "agent",
      kind: "question",
      text: "?",
      question: { options: [{ label: "a" }] },
    });
    await store.recordAnswer(q.id, {
      value: "a",
      replyMessageId: q.id,
      answeredAt: new Date().toISOString(),
    });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
      { value: "a" }
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already answered/i);
  });

  it("409s for an unanswered question when there is no session", async () => {
    const q = await store.insert({
      agentId,
      authorKind: "agent",
      kind: "question",
      text: "?",
      question: { options: [{ label: "a" }] },
    });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
      { value: "a" }
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).not.toMatch(/already answered/i);
    expect((await store.getById(q.id))?.answer).toBeNull();
  });
});

describe("POST /api/v1/agents/:id/chat/read", () => {
  it("marks agent messages read and returns the new unread count", async () => {
    const first = await store.insert({
      agentId,
      authorKind: "agent",
      text: "1",
    });
    await store.insert({ agentId, authorKind: "agent", text: "2" });
    const partial = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/read`,
      { upTo: first.id }
    );
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toEqual({ unreadCount: 1 });
    const all = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/read`,
      {}
    );
    expect(all.json()).toEqual({ unreadCount: 0 });
  });

  it("404s for an unknown agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nope/chat/read",
      {}
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("chat-surface setting", () => {
  it("defaults off and round-trips", async () => {
    const initial = await authedInject(
      "GET",
      "/api/v1/app/settings/chat-surface"
    );
    expect(initial.json()).toEqual({ enabled: false });
    const bad = await authedInject(
      "POST",
      "/api/v1/app/settings/chat-surface",
      {
        enabled: "yes",
      }
    );
    expect(bad.statusCode).toBe(400);
    const on = await authedInject("POST", "/api/v1/app/settings/chat-surface", {
      enabled: true,
    });
    expect(on.json()).toEqual({ enabled: true });
    const after = await authedInject(
      "GET",
      "/api/v1/app/settings/chat-surface"
    );
    expect(after.json()).toEqual({ enabled: true });
  });
});

describe("agent MCP route exposes the chat tools", () => {
  it("lists dispatch_chat_post and dispatch_chat_update", async () => {
    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/mcp/${agentId}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, agentId)}`,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(200);
    const names: string[] = [];
    for (const line of res.body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const parsed = JSON.parse(line.slice(5));
      for (const tool of parsed.result?.tools ?? []) names.push(tool.name);
    }
    expect(names).toContain("dispatch_chat_post");
    expect(names).toContain("dispatch_chat_update");
  });
});

// Delivery semantics need a live-looking terminal, which the inert runtime
// never provides — so drive the route module directly with a fake access
// check and prompt injector against the same database.
describe("chat routes with a deliverable terminal", () => {
  function buildApp(opts: {
    inject?: (agentId: string, prompt: string) => Promise<void>;
    held?: boolean;
    access?: () => Promise<{ mode: "tmux"; sessionName: string }>;
  }) {
    const published: unknown[] = [];
    const prompts: Array<{ agentId: string; prompt: string }> = [];
    const chat = new ChatService({
      pool: ctx.pool,
      publishUiEvent: (event) => published.push(event),
      getAgent: async (id) => ({ id, mediaDir: null, pins: [] }),
      mediaRoot: "/tmp/media",
    });
    const app = Fastify();
    const ready = registerChatRoutes(app, {
      pool: ctx.pool,
      chat,
      agentManager: {
        getTerminalAccess:
          opts.access ??
          (async () => ({ mode: "tmux" as const, sessionName: "s" })),
      } as never,
      injectionCoordinator: {
        holdState: () => ({
          held: opts.held ?? false,
          pendingCount: 0,
          quietMs: 0,
        }),
      },
      sendAgentPrompt: async (id, prompt) => {
        prompts.push({ agentId: id, prompt });
        if (opts.inject) await opts.inject(id, prompt);
      },
      handleAgentError,
    });
    return { app, ready, published, prompts };
  }

  it("persists then injects the envelope, reporting delivered and held", async () => {
    const { app, ready, published, prompts } = buildApp({ held: true });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages`,
      payload: { text: "please do X" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(true);
    expect(body.held).toBe(true);
    expect(body.message).toMatchObject({
      authorKind: "user",
      kind: "reply",
      text: "please do X",
      delivered: true,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].agentId).toBe(agentId);
    expect(prompts[0].prompt).toBe(
      [
        `--- DISPATCH CHAT (id: ${body.message.id}) ---`,
        "please do X",
        "--- END DISPATCH CHAT ---",
        `Reply in the Chat tab with dispatch_chat_post (replyTo: "${body.message.id}").`,
      ].join("\n")
    );
    expect(published).toEqual([{ type: "chat.changed", agentId }]);
    await app.close();
  });

  it("keeps the row with delivered=false when injection fails", async () => {
    const { app, ready } = buildApp({
      inject: async () => {
        throw new Error("session gone");
      },
    });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages`,
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(false);
    expect(res.json().message.delivered).toBe(false);
    await app.close();
  });

  it("maps AgentError from the access check through handleAgentError", async () => {
    const { app, ready } = buildApp({
      access: async () => {
        throw new AgentError("Agent is not running.", 409);
      },
    });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages`,
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("answers a question: records the answer, injects the label as a reply", async () => {
    const { app, ready, prompts, published } = buildApp({});
    await ready;
    const q = await store.insert({
      agentId,
      authorKind: "agent",
      kind: "question",
      text: "Ship it?",
      question: { options: [{ label: "Yes", value: "yes" }, { label: "No" }] },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
      payload: { value: "yes", label: "Yes" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(true);
    expect(body.reply).toMatchObject({
      authorKind: "user",
      text: "Yes",
      replyTo: q.id,
      delivered: true,
    });
    expect(body.question.answer).toMatchObject({
      value: "yes",
      label: "Yes",
      replyMessageId: body.reply.id,
    });
    expect(prompts[0].prompt).toContain(`(id: ${body.reply.id})`);
    expect(prompts[0].prompt).toContain("\nYes\n");
    expect(published).toEqual([{ type: "chat.changed", agentId }]);

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
      payload: { value: "no" },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("uses the value as text when no label is given", async () => {
    const { app, ready } = buildApp({});
    await ready;
    const q = await store.insert({
      agentId,
      authorKind: "agent",
      kind: "question",
      text: "?",
      question: { options: [{ label: "a" }], allowFreeform: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
      payload: { value: "something typed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply.text).toBe("something typed");
    await app.close();
  });

  it("400s an answer without a value", async () => {
    const { app, ready } = buildApp({});
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages/x/answer`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
