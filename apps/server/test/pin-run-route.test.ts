import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function authedInject(
  method: "GET" | "POST",
  url: string
): Promise<ReturnType<typeof ctx.app.inject>> {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie: await ctx.sessionCookie() },
  });
}

async function createAgent(): Promise<{ id: string }> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/agents",
    headers: {
      cookie: await ctx.sessionCookie(),
      "content-type": "application/json",
    },
    payload: { cwd: "/tmp", useWorktree: false },
  });
  expect(res.statusCode).toBe(201);
  return res.json().agent as { id: string };
}

async function setPins(
  agentId: string,
  pins: Array<Record<string, unknown>>
): Promise<void> {
  await ctx.pool.query("UPDATE agents SET pins = $2::jsonb WHERE id = $1", [
    agentId,
    JSON.stringify(pins),
  ]);
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query(
    "DELETE FROM settings WHERE key = 'chat_surface_enabled'"
  );
});

async function enableChatSurface(): Promise<void> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/app/settings/chat-surface",
    headers: {
      cookie: await ctx.sessionCookie(),
      "content-type": "application/json",
    },
    payload: { enabled: true },
  });
  expect(res.statusCode).toBe(200);
}

// The prompt is looked up server-side by pin ID, so this route is the boundary
// that decides what a click is allowed to inject. Every rejection path matters:
// a client must not be able to fire text the agent never pinned.
describe("POST /api/v1/agents/:id/terminal/inject-pin/:pinId", () => {
  it("returns 404 for an unknown agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_missing/terminal/inject-pin/p1"
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/agent not found/i);
  });

  it("returns 404 when the pin ID does not exist on the agent", async () => {
    const agent = await createAgent();
    await setPins(agent.id, [
      { id: "p1", label: "Go", value: "do the thing", type: "shortcut" },
    ]);

    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/terminal/inject-pin/not-a-real-pin`
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/pin not found/i);
  });

  it("refuses to run a pin that is not a shortcut", async () => {
    // Otherwise any pinned string — a URL, a file path — becomes injectable.
    const agent = await createAgent();
    await setPins(agent.id, [
      { id: "p1", label: "Notes", value: "rm -rf /", type: "string" },
    ]);

    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/terminal/inject-pin/p1`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a shortcut pin/i);
  });

  it("refuses to run a pin marked disabled", async () => {
    const agent = await createAgent();
    await setPins(agent.id, [
      {
        id: "p1",
        label: "Launch",
        value: "do the thing",
        type: "shortcut",
        disabled: true,
      },
    ]);

    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/terminal/inject-pin/p1`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/disabled/i);
  });

  it("returns 409 when the agent has no live session to inject into", async () => {
    // Agents run inert in tests, which is the same state as a stopped agent:
    // the lookup and type check pass, then delivery has nowhere to go.
    const agent = await createAgent();
    await setPins(agent.id, [
      { id: "p1", label: "Go", value: "do the thing", type: "shortcut" },
    ]);

    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/terminal/inject-pin/p1`
    );
    expect(res.statusCode).toBe(409);
  });

  it("leaves no Chat post behind when the prompt could not be delivered", async () => {
    // With the Chat surface on the click becomes a Chat message, but the
    // agent is inert: the send refuses before writing, so a click that never
    // reached the agent must not leave a post claiming it did.
    await enableChatSurface();
    const agent = await createAgent();
    await setPins(agent.id, [
      { id: "p1", label: "Go", value: "do the thing", type: "shortcut" },
    ]);

    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/terminal/inject-pin/p1`
    );
    expect(res.statusCode).toBe(409);
    const rows = await ctx.pool.query(
      "SELECT id FROM agent_chat_messages WHERE agent_id = $1",
      [agent.id]
    );
    expect(rows.rowCount).toBe(0);
  });

  it("still refuses a disabled pin with the Chat surface on", async () => {
    // The pin is the trust boundary either way — routing through Chat must
    // not become a way around it.
    await enableChatSurface();
    const agent = await createAgent();
    await setPins(agent.id, [
      {
        id: "p1",
        label: "Launch",
        value: "do the thing",
        type: "shortcut",
        disabled: true,
      },
    ]);

    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/terminal/inject-pin/p1`
    );
    expect(res.statusCode).toBe(400);
    const rows = await ctx.pool.query(
      "SELECT id FROM agent_chat_messages WHERE agent_id = $1",
      [agent.id]
    );
    expect(rows.rowCount).toBe(0);
  });

  it("rejects an unauthenticated request", async () => {
    const agent = await createAgent();
    await setPins(agent.id, [
      { id: "p1", label: "Go", value: "do the thing", type: "shortcut" },
    ]);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/terminal/inject-pin/p1`,
    });
    expect(res.statusCode).toBe(401);
  });
});
