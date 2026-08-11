import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

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

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agents");
});

// This is the API the mobile fullscreen input's Submit/Paste buttons go
// through instead of writing straight to the terminal WS, so the boundary
// checks (empty text, oversized text, no live session, auth) matter here.
describe("POST /api/v1/agents/:id/terminal/inject-text", () => {
  it("returns 400 when text is missing", async () => {
    const agent = await createAgent();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/terminal/inject-text`,
      headers: {
        cookie: await ctx.sessionCookie(),
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text is required/i);
  });

  it("returns 400 when text exceeds the max length", async () => {
    const agent = await createAgent();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/terminal/inject-text`,
      headers: {
        cookie: await ctx.sessionCookie(),
        "content-type": "application/json",
      },
      payload: { text: "x".repeat(10_001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/10000 characters or fewer/i);
  });

  it("returns 409 when the agent has no live session to inject into", async () => {
    // Agents run inert in tests: the text validates, then delivery has
    // nowhere to go — same boundary as inject-phrase/inject-pin.
    const agent = await createAgent();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/terminal/inject-text`,
      headers: {
        cookie: await ctx.sessionCookie(),
        "content-type": "application/json",
      },
      payload: { text: "echo hi", submit: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects an unauthenticated request", async () => {
    const agent = await createAgent();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/terminal/inject-text`,
      headers: { "content-type": "application/json" },
      payload: { text: "echo hi" },
    });
    expect(res.statusCode).toBe(401);
  });
});
