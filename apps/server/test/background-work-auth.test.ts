import { describe, expect, it } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";
import { backgroundFixture } from "./helpers/background-fixture.js";
const ctx = useInjectApp();
describe("background work HTTP access", () => {
  it("rejects scoped sibling/parent/child tokens and exposes durable provider reports only to account access", async () => {
    const id = "background-owner";
    await ctx.pool.query(
      "INSERT INTO agents (id, name, type, status, cwd) VALUES ($1, 'Background owner', 'claude', 'stopped', '/tmp')",
      [id]
    );
    const url = `/api/v1/agents/${id}/background-work`;
    expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    const token = (
      await ctx.pool.query(
        "SELECT value FROM settings WHERE key = 'auth_token'"
      )
    ).rows[0].value;
    for (const caller of [id, "sibling", "parent", "private-child"]) {
      expect(
        (
          await ctx.app.inject({
            url,
            headers: {
              authorization: `Bearer ${ctx.auth.createAgentMcpToken(token, caller)}`,
            },
          })
        ).statusCode
      ).toBe(401);
    }
    const cookie = await ctx.sessionCookie();
    const fixture = await backgroundFixture(ctx.pool, id, "claude");
    try {
      await fixture.report({
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "monitor-1",
        name: "Watch deploy",
        taskType: "monitor",
        canStop: false,
        showInTranscript: false,
        outputFilePath: "/secret/no-read",
      });
      const response = await ctx.app.inject({ url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        capability: "supported",
        items: [
          { name: "Watch deploy", taskType: "monitor", state: "running" },
        ],
      });
      expect(response.body).not.toContain("/secret");
    } finally {
      await fixture.close();
    }
    expect(
      (await ctx.app.inject({ url, headers: { cookie } })).json().stale
    ).toBe(true);
  });
});
