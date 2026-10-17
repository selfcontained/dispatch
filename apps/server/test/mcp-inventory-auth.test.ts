import { describe, expect, it } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();
describe("authenticated MCP inventory HTTP route", () => {
  it("requires Dispatch authentication and never accepts an agent MCP token as account access", async () => {
    const url = "/api/v1/agents/inventory-auth/mcp-inventory";
    expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    const token = (
      await ctx.pool.query(
        "SELECT value FROM settings WHERE key = 'auth_token'"
      )
    ).rows[0].value;
    expect(
      (
        await ctx.app.inject({
          url,
          headers: {
            authorization: `Bearer ${ctx.auth.createAgentMcpToken(token, "inventory-auth")}`,
          },
        })
      ).statusCode
    ).toBe(401);
    const cookie = await ctx.sessionCookie();
    expect(
      (await ctx.app.inject({ url, headers: { cookie } })).statusCode
    ).toBe(404);
    await ctx.pool.query(
      "INSERT INTO agents (id, name, type, status, cwd, files_dir) VALUES ('inventory-auth', 'Inventory', 'claude', 'stopped', '/tmp', '/tmp')"
    );
    const result = await ctx.app.inject({ url, headers: { cookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      agentId: "inventory-auth",
      status: "offline",
      inventory: null,
    });
  });
});
