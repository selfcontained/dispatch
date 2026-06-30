import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentLaunchToolsContext,
  registerAgentLaunchTools,
} from "../src/shared/mcp/agent-launch-tools.js";

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

const AGENT_ID = "agt_launch_test";

function baseContext(): AgentLaunchToolsContext {
  return {
    agentId: AGENT_ID,
    launchAgent: vi.fn(async () => ({
      agentId: "agt_child_123",
      name: "test-child",
    })),
  };
}

describe("registerAgentLaunchTools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  describe("conditional registration", () => {
    it("registers dispatch_launch_agent when allowed and context is complete", () => {
      registerAgentLaunchTools(
        server as never,
        new Set(["dispatch_launch_agent"]),
        baseContext()
      );
      const names = server.tools.map((t) => t.name);
      expect(names).toEqual(["dispatch_launch_agent"]);
    });

    it("registers nothing when allowed set is empty", () => {
      registerAgentLaunchTools(server as never, new Set(), baseContext());
      expect(server.tools).toHaveLength(0);
    });

    it("skips when launchAgent callback is missing", () => {
      const ctx = baseContext();
      delete (ctx as Record<string, unknown>).launchAgent;
      registerAgentLaunchTools(
        server as never,
        new Set(["dispatch_launch_agent"]),
        ctx
      );
      expect(server.tools).toHaveLength(0);
    });
  });

  describe("dispatch_launch_agent handler", () => {
    it("calls launchAgent with name and prompt", async () => {
      const ctx = baseContext();
      registerAgentLaunchTools(
        server as never,
        new Set(["dispatch_launch_agent"]),
        ctx
      );

      const tool = server.tools.find(
        (t) => t.name === "dispatch_launch_agent"
      )!;
      const result = await tool.handler({
        name: "test-child",
        prompt: "Do stuff",
      });

      expect(ctx.launchAgent).toHaveBeenCalledWith(AGENT_ID, {
        name: "test-child",
        prompt: "Do stuff",
      });
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: 'Launched agent "test-child" (agt_child_123).',
          },
        ],
        structuredContent: { agentId: "agt_child_123", name: "test-child" },
      });
    });

    it("passes optional parameters through", async () => {
      const ctx = baseContext();
      registerAgentLaunchTools(
        server as never,
        new Set(["dispatch_launch_agent"]),
        ctx
      );

      const tool = server.tools.find(
        (t) => t.name === "dispatch_launch_agent"
      )!;
      await tool.handler({
        name: "isolated-worker",
        prompt: "Do stuff in isolation",
        type: "codex",
        useWorktree: true,
        createNewBranch: true,
        baseBranch: "main",
        fullAccess: false,
      });

      expect(ctx.launchAgent).toHaveBeenCalledWith(AGENT_ID, {
        name: "isolated-worker",
        prompt: "Do stuff in isolation",
        type: "codex",
        useWorktree: true,
        createNewBranch: true,
        baseBranch: "main",
        fullAccess: false,
      });
    });

    it("returns tool error on failure", async () => {
      const ctx = baseContext();
      (ctx.launchAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Agent type disabled")
      );
      registerAgentLaunchTools(
        server as never,
        new Set(["dispatch_launch_agent"]),
        ctx
      );

      const tool = server.tools.find(
        (t) => t.name === "dispatch_launch_agent"
      )!;
      const result = (await tool.handler({
        name: "child",
        prompt: "hello",
      })) as { isError: boolean };

      expect(result.isError).toBe(true);
    });
  });
});
