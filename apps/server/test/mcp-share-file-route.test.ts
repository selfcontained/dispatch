import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

describe("share_file over the real MCP route", () => {
  const ctx = useInjectApp();

  beforeEach(async () => {
    await ctx.pool.query("DELETE FROM agent_events");
    await ctx.pool.query("DELETE FROM media_seen");
    await ctx.pool.query("DELETE FROM media");
    await ctx.pool.query("DELETE FROM agents");
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, role, status, cwd, persona, parent_agent_id, full_access)
       VALUES ('agt_sharerename', 'sharer', 'codex', 'standard', 'running', '/tmp', null, null, false)`
    );
  });

  async function call(payload: unknown) {
    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;
    return ctx.app.inject({
      method: "POST",
      url: "/api/mcp/agt_sharerename",
      headers: {
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, "agt_sharerename")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: payload as Record<string, unknown>,
    });
  }

  it("lists share_file and not the retired dispatch_share alias", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"share_file"');
    expect(response.body).not.toContain('"dispatch_share"');
  });
});
