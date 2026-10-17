import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { parseMcpInventory } from "../src/agents/acp/mcp-inventory.js";
import { registerAgentPromptRoutes } from "../src/routes/agents/prompt-routes.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";

describe("MCP inventory boundary", () => {
  it("projects metadata and keeps known empty distinct from unknown", () => {
    const value = parseMcpInventory({
      version: 1,
      secret: "secret",
      servers: [
        {
          name: "empty",
          state: "connected",
          toolsState: "known",
          tools: [],
          config: "secret",
        },
        {
          name: "unknown",
          state: "pending",
          toolsState: "unknown",
          tools: null,
        },
        {
          name: "with-tools",
          state: "connected",
          toolsState: "known",
          tools: [
            { name: "read", description: "Reads", inputSchema: "secret" },
          ],
        },
      ],
    });
    expect(value.servers[0]!.tools).toEqual([]);
    expect(value.servers[1]!.tools).toBeNull();
    expect(JSON.stringify(value)).not.toContain("secret");
  });
  it.each([
    {},
    { version: 2, servers: [] },
    {
      version: 1,
      servers: [
        { name: "bad", state: "connected", toolsState: "unknown", tools: [] },
      ],
    },
  ])("rejects invalid schema", (value) =>
    expect(() => parseMcpInventory(value)).toThrow()
  );
  it("targets the requested child only, does not launch, and preserves response states", async () => {
    const app = Fastify();
    const getMcpInventory = vi.fn(async (agentId) => ({
      agentId,
      status: "unsupported",
      inventory: null,
    }));
    await registerAgentPromptRoutes(app, {
      agentManager: {
        getAgent: async (id: string) => (id === "missing" ? null : {}),
        getMcpInventory,
      },
    } as unknown as AgentRouteDeps);
    try {
      const response = await app.inject({
        url: "/api/v1/agents/child/mcp-inventory",
      });
      expect(response.json()).toEqual({
        agentId: "child",
        status: "unsupported",
        inventory: null,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(getMcpInventory).toHaveBeenCalledExactlyOnceWith("child");
      expect(
        (await app.inject({ url: "/api/v1/agents/missing/mcp-inventory" }))
          .statusCode
      ).toBe(404);
      expect(getMcpInventory).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
