import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";
import { MessageStore } from "../src/messages/store.js";

const ctx = useInjectApp();

async function authedInject(
  method: string,
  url: string,
  opts?: { payload?: unknown; headers?: Record<string, string> }
): Promise<ReturnType<typeof ctx.app.inject>> {
  const cookie = await ctx.sessionCookie();
  const headers: Record<string, string> = { cookie, ...opts?.headers };
  if (opts?.payload !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return ctx.app.inject({
    method: method as "GET" | "POST",
    url,
    headers,
    ...(opts?.payload !== undefined ? { payload: opts.payload } : {}),
  });
}

async function createAgent(name: string): Promise<{ id: string }> {
  const res = await authedInject("POST", "/api/v1/agents", {
    payload: { cwd: "/tmp", useWorktree: false, name },
  });
  expect(res.statusCode).toBe(201);
  const agent = res.json().agent;
  return { id: agent.id };
}

let agentA: string;
let agentB: string;

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agent_messages");
  await ctx.pool.query("DELETE FROM media_seen");
  await ctx.pool.query("DELETE FROM media");
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");

  const a = await createAgent("Alice");
  const b = await createAgent("Bob");
  agentA = a.id;
  agentB = b.id;

  const store = new MessageStore(ctx.pool);
  await store.insertMessage({
    senderAgentId: agentA,
    recipientAgentId: agentB,
    senderName: "Alice",
    recipientName: "Bob",
    content: "hi",
    delivered: true,
    senderRepoRoot: "/repo",
    recipientRepoRoot: "/repo",
  });
});

describe("GET /api/v1/agents/:id/messages (list)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/agt_nonexistent/messages"
    );
    expect(res.statusCode).toBe(404);
  });

  it("lists messages for an agent with a server-computed unread count", async () => {
    const res = await authedInject("GET", `/api/v1/agents/${agentB}/messages`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      messages: Array<{ content: string }>;
      unreadCount: number;
    };
    expect(body.messages.map((m) => m.content)).toContain("hi");
    // Bob is the recipient of the unread "hi" message.
    expect(body.unreadCount).toBe(1);
  });
});

describe("POST /api/v1/agents/:id/messages/read (mark read)", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/messages/read"
    );
    expect(res.statusCode).toBe(404);
  });

  it("marks messages read and returns updated count", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentB}/messages/read`
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean; updated: number }).updated).toBe(1);

    // Second call should update 0 since the message is already read.
    const res2 = await authedInject(
      "POST",
      `/api/v1/agents/${agentB}/messages/read`
    );
    expect(res2.statusCode).toBe(200);
    expect((res2.json() as { updated: number }).updated).toBe(0);
  });
});
