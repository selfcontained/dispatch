import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type MessagingToolsContext,
  registerMessagingTools,
} from "../src/shared/mcp/messaging-tools.js";

type RegisteredCall = {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function createMockServer() {
  const tools: RegisteredCall[] = [];
  return {
    registerTool: vi.fn(
      (
        name: string,
        config: Record<string, unknown>,
        handler: (args: Record<string, unknown>) => Promise<unknown>
      ) => {
        tools.push({ name, config, handler });
      }
    ),
    tools,
  };
}

const AGENT_ID = "agt_msg_test";

function baseContext(): MessagingToolsContext {
  return {
    agentId: AGENT_ID,
    repoRoot: "/home/user/project",
    listAgentsForAgent: vi.fn(async () => []),
  };
}

describe("registerMessagingTools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  // ── Conditional registration ────────────────────────────────────

  describe("conditional registration", () => {
    it("registers both tools when allowed and context is complete", () => {
      registerMessagingTools(
        server as never,
        new Set(["list_agents"]),
        baseContext()
      );

      const names = server.tools.map((t) => t.name);
      expect(names).toEqual(["list_agents"]);
    });

    it("registers nothing when allowed set is empty", () => {
      registerMessagingTools(server as never, new Set(), baseContext());
      expect(server.tools).toHaveLength(0);
    });

    it("skips list_agents when listAgentsForAgent is missing", () => {
      const ctx = baseContext();
      delete ctx.listAgentsForAgent;
      registerMessagingTools(server as never, new Set(["list_agents"]), ctx);
      expect(server.tools).toHaveLength(0);
    });

    it("registers only allowed tools", () => {
      registerMessagingTools(
        server as never,
        new Set(["list_agents"]),
        baseContext()
      );
      expect(server.tools).toHaveLength(1);
      expect(server.tools[0]!.name).toBe("list_agents");
    });
  });

  // ── list_agents handler ─────────────────────────────────────────

  describe("list_agents handler", () => {
    it("calls listAgentsForAgent with agent id and repo root", async () => {
      const ctx = baseContext();
      const agents = [
        {
          id: "agt_other",
          name: "Other Agent",
          status: "running",
        },
      ];
      ctx.listAgentsForAgent = vi.fn(async () => agents);

      registerMessagingTools(server as never, new Set(["list_agents"]), ctx);

      const result = await server.tools[0]!.handler({});

      expect(ctx.listAgentsForAgent).toHaveBeenCalledWith(
        AGENT_ID,
        "/home/user/project"
      );
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ agents }) }],
        structuredContent: { agents },
      });
    });

    it("passes null repoRoot when context has null", async () => {
      const ctx = baseContext();
      ctx.repoRoot = null;
      registerMessagingTools(server as never, new Set(["list_agents"]), ctx);

      await server.tools[0]!.handler({});
      expect(ctx.listAgentsForAgent).toHaveBeenCalledWith(AGENT_ID, null);
    });

    it("returns tool error on failure", async () => {
      const ctx = baseContext();
      ctx.listAgentsForAgent = vi.fn(async () => {
        throw new Error("DB timeout");
      });
      registerMessagingTools(server as never, new Set(["list_agents"]), ctx);

      const result = await server.tools[0]!.handler({});
      expect(result).toEqual({
        content: [{ type: "text", text: "DB timeout" }],
        isError: true,
      });
    });
  });
});
