import { describe, expect, it } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";
const ctx = useInjectApp();
describe("background work HTTP access", () => {
  it("rejects scoped sibling/parent/child tokens and keeps offline sessions empty for account access", async () => {
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
    const response = await ctx.app.inject({ url, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "offline", items: [] });
  });
});
