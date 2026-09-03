import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";

import { useInjectApp } from "./helpers/inject-app.js";
import { ChatStore } from "../src/chat/store.js";
import { ChatService } from "../src/chat/service.js";
import { registerChatRoutes } from "../src/routes/chat.js";
import { AgentError } from "../src/agents/errors.js";
import { handleAgentError } from "../src/server/http-helpers.js";
import type { ChatMessage } from "@dispatch/shared";

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

  it("validates cursor and limit, and refuses the retired before param", async () => {
    const badCursor = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/chat?cursor=garbage`
    );
    expect(badCursor.statusCode).toBe(400);
    // Forged but well-formed base64 cursors must be 400s, never SQL casts.
    const forged = [
      { at: "2026-01-01 00:00:00.000000", type: "chat", id: "x" },
      { at: "2026-01-01 00:00:00.000000", type: "status", id: "abc" },
      { at: "2026-02-30 00:00:00.000000", type: "status", id: "1" },
      { at: "2026-01-01 00:00:00.000000", type: "media", id: "99999999999" },
      { at: "0000-01-01 00:00:00.000000", type: "status", id: "1" },
    ];
    for (const value of forged) {
      const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
      const res = await authedInject(
        "GET",
        `/api/v1/agents/${agentId}/chat?cursor=${encodeURIComponent(encoded)}`
      );
      expect(res.statusCode, JSON.stringify(value)).toBe(400);
      expect(res.json().error).toMatch(/cursor/);
    }
    const before = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/chat?before=2026-01-01T00:00:00.000Z`
    );
    expect(before.statusCode).toBe(400);
    expect(before.json().error).toMatch(/nextCursor/);
    const badLimit = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/chat?limit=lots`
    );
    expect(badLimit.statusCode).toBe(400);
  });

  it("pages with the returned cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await store.insert({ agentId, authorKind: "agent", text: `m${i}` });
    }
    const first = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/chat?limit=2`
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().hasMore).toBe(true);
    expect(typeof first.json().nextCursor).toBe("string");
    const second = await authedInject(
      "GET",
      `/api/v1/agents/${agentId}/chat?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`
    );
    expect(second.statusCode).toBe(200);
    const ids = (r: { json: () => { entries: Array<{ id: string }> } }) =>
      r.json().entries.map((e) => e.id);
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(4);
  });

  it("returns the composed feed with unreadCount", async () => {
    await store.insert({ agentId, authorKind: "agent", text: "hi there" });
    const res = await authedInject("GET", `/api/v1/agents/${agentId}/chat`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
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

  it("400s malformed, oversized, or path-based attachment lists", async () => {
    const url = `/api/v1/agents/${agentId}/chat/messages`;
    const tooMany = await authedInject("POST", url, {
      text: "x",
      attachments: Array.from({ length: 21 }, () => ({
        type: "link",
        url: "https://example.com",
      })),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toMatch(/attachments/);
    // The user path takes files by mediaId only; fileName is the agent's key.
    const byName = await authedInject("POST", url, {
      text: "x",
      attachments: [{ type: "file", fileName: "shot.png" }],
    });
    expect(byName.statusCode).toBe(400);
    expect(byName.json().error).toMatch(/attachments\.0/);
    const badKind = await authedInject("POST", url, {
      text: "x",
      attachments: [{ type: "code", code: "x" }],
    });
    expect(badKind.statusCode).toBe(400);
    const badUrl = await authedInject("POST", url, {
      text: "x",
      attachments: [{ type: "link", url: "not a url" }],
    });
    expect(badUrl.statusCode).toBe(400);
    // Only absolute http(s) URLs: the value is persisted, printed into the
    // agent's pane, and rendered as an anchor href.
    for (const scheme of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "ftp://example.com/x",
    ]) {
      const badScheme = await authedInject("POST", url, {
        text: "x",
        attachments: [{ type: "link", url: scheme }],
      });
      expect(badScheme.statusCode).toBe(400);
      expect(badScheme.json().error).toMatch(/http or https/);
    }
    const oversizedUrl = await authedInject("POST", url, {
      text: "x",
      attachments: [
        { type: "link", url: `https://example.com/${"a".repeat(2100)}` },
      ],
    });
    expect(oversizedUrl.statusCode).toBe(400);
    expect(oversizedUrl.json().error).toMatch(/2048 characters or fewer/);
    const notArray = await authedInject("POST", url, {
      text: "x",
      attachments: { type: "link", url: "https://example.com" },
    });
    expect(notArray.statusCode).toBe(400);
    // Blank text needs at least one attachment.
    const blank = await authedInject("POST", url, {
      text: "",
      attachments: [],
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toMatch(/text is required/);
    // An unknown media id is a 400 from the service, and nothing persists.
    const unknownMedia = await authedInject("POST", url, {
      text: "",
      attachments: [{ type: "file", mediaId: 424242 }],
    });
    expect(unknownMedia.statusCode).toBe(400);
    expect(unknownMedia.json().error).toMatch(/Unknown file/);
    const rows = await ctx.pool.query(
      "SELECT 1 FROM agent_chat_messages WHERE agent_id = $1",
      [agentId]
    );
    expect(rows.rows).toHaveLength(0);
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
  it("400s a malformed messageId without querying", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/messages/not-a-uuid/answer`,
      { value: "a" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/UUID/);
  });

  it("400s a value that matches no option on a closed question", async () => {
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
      { value: "zzz" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/options/);
    expect((await store.getById(q.id))?.answer).toBeNull();
  });

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

  it("400s a present-but-invalid upTo and treats null as omitted", async () => {
    await store.insert({ agentId, authorKind: "agent", text: "1" });
    for (const upTo of ["nope", 5, {}]) {
      const res = await authedInject(
        "POST",
        `/api/v1/agents/${agentId}/chat/read`,
        { upTo }
      );
      expect(res.statusCode).toBe(400);
    }
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/chat/read`,
      { upTo: null }
    );
    expect(res.json()).toEqual({ unreadCount: 0 });
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

describe("GET /api/v1/chat/unread", () => {
  it("lists per-agent unread and pending-question counts", async () => {
    const other = await createAgent("Other");
    await store.insert({ agentId, authorKind: "agent", text: "1" });
    await store.insert({
      agentId,
      authorKind: "agent",
      kind: "question",
      text: "?",
      question: { options: [{ label: "a" }] },
    });
    const res = await authedInject("GET", "/api/v1/chat/unread");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      agents: { [agentId]: { unread: 2, pendingQuestions: 1 } },
    });
    expect(res.json().agents[other]).toBeUndefined();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/chat/unread",
    });
    expect(res.statusCode).toBe(401);
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
// check, coordinator, and terminal against the same database.
describe("chat routes with a deliverable terminal", () => {
  type Sent = { agentId: string; prompt: string };

  function buildApp(opts: {
    sendCommand?: (prompt: string) => Promise<void>;
    held?: boolean;
    access?: () => Promise<{ mode: "tmux"; sessionName: string }>;
    /** Resolve to release a delivery that should stay pending for a while. */
    gate?: Promise<void>;
  }) {
    const published: unknown[] = [];
    const prompts: Sent[] = [];
    const chat = new ChatService({
      pool: ctx.pool,
      publishUiEvent: (event) => published.push(event),
      getAgent: async (id) => ({
        id,
        mediaDir: null,
        pins: [{ id: "pin_1", label: "PR", value: "https://gh/1" }] as never,
      }),
      mediaRoot: "/media-root",
      delivery: {
        access:
          opts.access ??
          (async () => ({ mode: "tmux" as const, sessionName: "s" })),
        inject: async (id: string, _sessionName: string, prompt: string) => {
          if (opts.gate) await opts.gate;
          prompts.push({ agentId: id, prompt });
          if (opts.sendCommand) await opts.sendCommand(prompt);
        },
        held: () => opts.held ?? false,
      },
    });
    const app = Fastify();
    const ready = registerChatRoutes(app, {
      pool: ctx.pool,
      chat,
      handleAgentError,
    });
    return { app, ready, chat, published, prompts };
  }

  async function settled(id: string): Promise<ChatMessage> {
    for (let i = 0; i < 50; i++) {
      const row = await store.getById(id);
      if (row && row.delivered !== null) return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("delivery never settled");
  }

  it("persists as pending, responds at once, then settles delivered=true", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { app, ready, published, prompts } = buildApp({ held: true, gate });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages`,
      payload: { text: "please do X" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBeNull();
    expect(body.held).toBe(true);
    expect(body.message).toMatchObject({
      authorKind: "user",
      kind: "reply",
      text: "please do X",
      delivered: null,
    });
    // Still held: nothing has reached the pane and the row is pending.
    expect(prompts).toHaveLength(0);
    expect((await store.getById(body.message.id))?.delivered).toBeNull();
    expect(published).toEqual([{ type: "chat.changed", agentId }]);

    release();
    const row = await settled(body.message.id);
    expect(row.delivered).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toBe(
      [
        `--- DISPATCH CHAT (id: ${body.message.id}) ---`,
        "please do X",
        "--- END DISPATCH CHAT ---",
        `The user is reading the Chat tab, not this terminal — they only see what you post with dispatch_chat_post. Reply there (replyTo: "${body.message.id}"); terminal output alone will not reach them.`,
      ].join("\n")
    );
    expect(published).toEqual([
      { type: "chat.changed", agentId },
      { type: "chat.changed", agentId },
    ]);
    await app.close();
  });

  it("stores user attachments and lists them in the injected envelope", async () => {
    const media = await ctx.pool.query<{ id: number }>(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'upload-2026-01-01-00-00-00-000.pdf', 'user', 2048)
       RETURNING id`,
      [agentId]
    );
    const mediaId = media.rows[0].id;
    const { app, ready, prompts } = buildApp({});
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages`,
      payload: {
        text: "",
        attachments: [
          { type: "file", mediaId },
          { type: "pin", pinId: "pin_1" },
          { type: "link", url: "https://example.com/x" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message.text).toBe("");
    expect(body.message.attachments).toEqual([
      {
        type: "file",
        mediaId,
        fileName: "upload-2026-01-01-00-00-00-000.pdf",
        sizeBytes: 2048,
        mimeType: "application/pdf",
      },
      { type: "pin", pinId: "pin_1" },
      { type: "link", url: "https://example.com/x" },
    ]);
    await settled(body.message.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain(
      [
        `--- DISPATCH CHAT (id: ${body.message.id}) ---`,
        "Attachments:",
        `- file: /media-root/${agentId}/upload-2026-01-01-00-00-00-000.pdf (application/pdf, 2 KB)`,
        "- pin: PR — https://gh/1",
        "- link: https://example.com/x",
        "--- END DISPATCH CHAT ---",
      ].join("\n")
    );
    await app.close();
  });

  it("settles delivered=false when the pane write fails after the response", async () => {
    const { app, ready } = buildApp({
      sendCommand: async () => {
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
    expect(res.json().delivered).toBeNull();
    const row = await settled(res.json().message.id);
    expect(row.delivered).toBe(false);
    await app.close();
  });

  it("marks a delivery abandoned by a restart as not delivered on recovery", async () => {
    // The quiet gate never releases: this stands in for a process that died
    // with the delivery still queued in memory.
    const { app, ready, chat, published } = buildApp({
      held: true,
      gate: new Promise<void>(() => {}),
    });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages`,
      payload: { text: "lost in the restart" },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().message.id as string;
    expect((await store.getById(id))?.delivered).toBeNull();
    expect(chat.inFlightDeliveryCount).toBe(1);
    // Shutdown gives it a bounded chance to settle, then gives up.
    expect(await chat.waitForInFlightDeliveries(20)).toBe(false);

    // Next process start.
    published.length = 0;
    expect(await chat.recoverPendingDeliveries()).toEqual([agentId]);
    expect((await store.getById(id))?.delivered).toBe(false);
    expect(published).toEqual([{ type: "chat.changed", agentId }]);
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

  it("answers a question: resolves the option label server-side and injects it", async () => {
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
      // A client label that disagrees with the option is ignored.
      payload: { value: "yes", label: "Absolutely" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBeNull();
    expect(body.reply).toMatchObject({
      authorKind: "user",
      text: "Yes",
      replyTo: q.id,
      delivered: null,
    });
    expect(body.question.answer).toMatchObject({
      value: "yes",
      label: "Yes",
      replyMessageId: body.reply.id,
    });
    const row = await settled(body.reply.id);
    expect(row.delivered).toBe(true);
    expect(prompts[0].prompt).toContain(`(id: ${body.reply.id})`);
    expect(prompts[0].prompt).toContain("\nYes\n");
    expect(published[0]).toEqual({ type: "chat.changed", agentId });

    // Value-less options match on their label; but the question is taken.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
      payload: { value: "No" },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("accepts a typed answer only when allowFreeform is set", async () => {
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
      payload: { value: "something typed", label: "  typed  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply.text).toBe("something typed");
    expect(res.json().question.answer).toMatchObject({
      value: "something typed",
      label: "typed",
    });
    await app.close();
  });

  it("rejects an oversized freeform answer", async () => {
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
      payload: { value: "x".repeat(20_001) },
    });
    expect(res.statusCode).toBe(400);
    expect((await store.getById(q.id))?.answer).toBeNull();
    await app.close();
  });

  it("leaves no orphan reply when answers race", async () => {
    const { app, ready } = buildApp({});
    await ready;
    const q = await store.insert({
      agentId,
      authorKind: "agent",
      kind: "question",
      text: "?",
      question: { options: [{ label: "a" }, { label: "b" }] },
    });
    const results = await Promise.all(
      ["a", "b", "a", "b"].map((value) =>
        app.inject({
          method: "POST",
          url: `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
          payload: { value },
        })
      )
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409]);
    const replies = await ctx.pool.query(
      `SELECT id FROM agent_chat_messages WHERE reply_to = $1`,
      [q.id]
    );
    expect(replies.rows).toHaveLength(1);
    const winner = results.find((r) => r.statusCode === 200)!.json();
    expect(replies.rows[0].id).toBe(winner.reply.id);
    await app.close();
  });

  it("400s an answer without a value or with a non-string label", async () => {
    const { app, ready } = buildApp({});
    await ready;
    const q = await store.insert({
      agentId,
      authorKind: "agent",
      kind: "question",
      text: "?",
      question: { options: [{ label: "a" }] },
    });
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const badLabel = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/chat/messages/${q.id}/answer`,
      payload: { value: "a", label: 7 },
    });
    expect(badLabel.statusCode).toBe(400);
    await app.close();
  });
});
