import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerAgentPromptRoutes } from "../src/routes/agents/prompt-routes.js";
import type { AgentRouteDeps } from "../src/routes/agents/shared.js";

async function request(
  type: string,
  commands: Array<{
    name: string;
    description?: string;
    input?: { hint: string };
  }> | null,
  exists = true
) {
  const app = Fastify();
  const deps = {
    agentManager: {
      getAgent: vi.fn(async () => (exists ? { type } : null)),
      getCommands: vi.fn(() => commands),
    },
  } as unknown as AgentRouteDeps;
  await registerAgentPromptRoutes(app, deps);
  try {
    return await app.inject({
      method: "GET",
      url: "/api/v1/agents/agt_1/commands",
    });
  } finally {
    await app.close();
  }
}

describe("agent command discovery", () => {
  it.each(["claude", "codex"])(
    "enables MCP only for an advertising %s session",
    async (type) => {
      const response = await request(type, [
        {
          name: "mcp",
          description: "MCP status",
          input: { hint: "[reconnect]" },
        },
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        connected: true,
        mcp: { provider: type, available: true },
        commands: [
          { name: "mcp", description: "MCP status", inputHint: "[reconnect]" },
        ],
      });
      expect((await request(type, [])).json()).toMatchObject({
        connected: true,
        mcp: { available: false },
      });
    }
  );

  it("distinguishes an offline host from a connected session with no commands", async () => {
    expect((await request("claude", null)).json()).toEqual({
      connected: false,
      mcp: { provider: "claude", available: false },
      commands: [],
    });
    expect((await request("claude", [])).json()).toMatchObject({
      connected: true,
      commands: [],
    });
  });

  it("does not infer an untested provider contract from a command name", async () => {
    expect((await request("opencode", [{ name: "mcp" }])).json()).toMatchObject(
      {
        connected: true,
        mcp: { provider: null, available: false },
        commands: [{ name: "mcp" }],
      }
    );
  });

  it("does not expose provider fields outside the existing command contract", async () => {
    const response = await request("codex", [
      {
        name: "mcp",
        headers: { Authorization: "secret" },
        env: { TOKEN: "secret" },
        config: "secret",
      } as never,
    ]);
    expect(response.body).not.toContain("secret");
  });

  it("keeps missing agents a 404", async () => {
    expect((await request("claude", null, false)).statusCode).toBe(404);
  });
});
