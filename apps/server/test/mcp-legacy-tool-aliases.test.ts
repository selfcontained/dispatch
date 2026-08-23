import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyLegacyToolAliases,
  legacyToolAliases,
} from "../src/shared/mcp/server.js";
import { useInjectApp } from "./helpers/inject-app.js";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

describe("applyLegacyToolAliases", () => {
  it("rewrites a legacy tool name on tools/call", () => {
    expect(
      applyLegacyToolAliases({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "dispatch_share", arguments: { description: "x" } },
      })
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch_share_file", arguments: { description: "x" } },
    });
  });

  it("leaves current tool names untouched", () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch_share_file", arguments: {} },
    };
    expect(applyLegacyToolAliases(body)).toBe(body);
  });

  it("leaves other methods untouched", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect(applyLegacyToolAliases(body)).toBe(body);
  });

  it("rewrites inside a batch", () => {
    const result = applyLegacyToolAliases([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "dispatch_share" },
      },
    ]) as Array<{ params?: { name?: string } }>;
    expect(result[0]!.params).toEqual({});
    expect(result[1]!.params?.name).toBe("dispatch_share_file");
  });

  it("does not resolve names through the prototype chain", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name },
      };
      expect(applyLegacyToolAliases(body)).toBe(body);
    }
  });

  // A rename is only safe to undo once nobody can still be holding the old
  // name, which nothing observes on its own — so every entry has to carry the
  // trigger that says when to look.
  it("requires a removal trigger on every alias", () => {
    for (const [from, alias] of legacyToolAliases()) {
      expect(from).not.toBe(alias.to);
      expect(alias.to).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(alias.lastVersionWithOldName).toMatch(/^\d+\.\d+\.\d+$/);
      expect(alias.reviewAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(alias.reviewAfter))).toBe(false);
    }
  });

  it("tolerates malformed bodies", () => {
    expect(applyLegacyToolAliases(null)).toBeNull();
    expect(applyLegacyToolAliases("nope")).toBe("nope");
    expect(
      applyLegacyToolAliases({ method: "tools/call", params: { name: 7 } })
    ).toEqual({ method: "tools/call", params: { name: 7 } });
    expect(applyLegacyToolAliases({ method: "tools/call" })).toEqual({
      method: "tools/call",
    });
  });
});

describe("dispatch_share_file over the real MCP route", () => {
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

  it("lists the new name and not the old one", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"dispatch_share_file"');
    expect(response.body).not.toContain('"dispatch_share"');
  });

  it("still routes a tools/call made under the old name", async () => {
    const response = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "dispatch_share",
        arguments: { description: "legacy caller" },
      },
    });

    expect(response.statusCode).toBe(200);
    // Reaching the share handler's own argument check proves the call routed,
    // rather than failing with an unknown-tool error.
    expect(response.body).toContain("filePath is required");
    expect(response.body).not.toContain("not found");
  });
});
