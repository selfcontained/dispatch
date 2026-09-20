import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentLifecycleContext,
  registerAgentLifecycleTools,
} from "../src/shared/mcp/agent-lifecycle-tools.js";

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

const AGENT_ID = "agt_test123";

function baseContext(): AgentLifecycleContext {
  return {
    agentId: AGENT_ID,
    upsertEvent: vi.fn(async () => {}),
    renameSession: vi.fn(async () => ({ id: AGENT_ID, name: "New Name" })),
    listFiles: vi.fn(async () => []),
    deleteFile: vi.fn(async () => {}),
  };
}

describe("registerAgentLifecycleTools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  // ── Conditional registration ────────────────────────────────────

  describe("conditional registration", () => {
    it("registers all lifecycle tools when all are allowed and context is complete", () => {
      const allowed = new Set(["rename_session", "list_files", "delete_file"]);
      registerAgentLifecycleTools(server as never, allowed, baseContext());

      const names = server.tools.map((t) => t.name);
      expect(names).toEqual(["rename_session", "list_files", "delete_file"]);
    });

    it("registers nothing when allowed set is empty", () => {
      registerAgentLifecycleTools(server as never, new Set(), baseContext());
      expect(server.tools).toHaveLength(0);
    });

    it("skips rename_session when renameSession is missing", () => {
      const ctx = baseContext();
      delete ctx.renameSession;
      registerAgentLifecycleTools(
        server as never,
        new Set(["rename_session"]),
        ctx
      );
      expect(server.tools).toHaveLength(0);
    });

    it("skips list_files when listFiles is missing", () => {
      const ctx = baseContext();
      delete ctx.listFiles;
      registerAgentLifecycleTools(
        server as never,
        new Set(["list_files"]),
        ctx
      );
      expect(server.tools).toHaveLength(0);
    });

    it("skips delete_file when deleteFile is missing", () => {
      const ctx = baseContext();
      delete ctx.deleteFile;
      registerAgentLifecycleTools(
        server as never,
        new Set(["delete_file"]),
        ctx
      );
      expect(server.tools).toHaveLength(0);
    });

    it("only registers tools that are in the allowed set", () => {
      registerAgentLifecycleTools(
        server as never,
        new Set(["list_files", "delete_file"]),
        baseContext()
      );
      const names = server.tools.map((t) => t.name);
      expect(names).toEqual(["list_files", "delete_file"]);
    });
  });

  describe("rename_session handler", () => {
    it("calls renameSession and returns result", async () => {
      const ctx = baseContext();
      registerAgentLifecycleTools(
        server as never,
        new Set(["rename_session"]),
        ctx
      );
      const handler = server.tools[0]!.handler;

      const result = await handler({ name: "My Session" });

      expect(ctx.renameSession).toHaveBeenCalledWith(AGENT_ID, "My Session");
      expect(result).toEqual({
        content: [{ type: "text", text: 'Renamed session to "New Name".' }],
        structuredContent: { id: AGENT_ID, name: "New Name" },
      });
    });

    it("returns tool error on failure", async () => {
      const ctx = baseContext();
      ctx.renameSession = vi.fn(async () => {
        throw new Error("Not found");
      });
      registerAgentLifecycleTools(
        server as never,
        new Set(["rename_session"]),
        ctx
      );

      const result = await server.tools[0]!.handler({ name: "x" });
      expect(result).toEqual({
        content: [{ type: "text", text: "Not found" }],
        isError: true,
      });
    });
  });

  it("never registers notify: post carries notify: true instead", () => {
    registerAgentLifecycleTools(
      server as never,
      new Set(["notify", "rename_session"]),
      baseContext()
    );
    expect(server.tools.map((t) => t.name)).toEqual(["rename_session"]);
  });

  // ── list_files handler ─────────────────────────────────

  describe("list_files handler", () => {
    it("calls listFiles and returns JSON items", async () => {
      const items = [
        {
          fileName: "screenshot.png",
          filePath: "/tmp/screenshot.png",
          source: "screenshot",
          description: null,
          sizeBytes: 1024,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      const ctx = baseContext();
      ctx.listFiles = vi.fn(async () => items);
      registerAgentLifecycleTools(
        server as never,
        new Set(["list_files"]),
        ctx
      );

      const result = await server.tools[0]!.handler({ source: "screenshot" });

      expect(ctx.listFiles).toHaveBeenCalledWith(AGENT_ID, {
        source: "screenshot",
        ownerAgentId: undefined,
      });
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify(items) }],
      });
    });

    it("passes undefined source when omitted", async () => {
      const ctx = baseContext();
      registerAgentLifecycleTools(
        server as never,
        new Set(["list_files"]),
        ctx
      );

      await server.tools[0]!.handler({});
      expect(ctx.listFiles).toHaveBeenCalledWith(AGENT_ID, {
        source: undefined,
        ownerAgentId: undefined,
      });
    });

    it("passes ownerAgentId through for a family read", async () => {
      const ctx = baseContext();
      registerAgentLifecycleTools(
        server as never,
        new Set(["list_files"]),
        ctx
      );

      await server.tools[0]!.handler({ ownerAgentId: "agt_child" });
      expect(ctx.listFiles).toHaveBeenCalledWith(AGENT_ID, {
        source: undefined,
        ownerAgentId: "agt_child",
      });
    });

    it("returns tool error on failure", async () => {
      const ctx = baseContext();
      ctx.listFiles = vi.fn(async () => {
        throw new Error("Storage unavailable");
      });
      registerAgentLifecycleTools(
        server as never,
        new Set(["list_files"]),
        ctx
      );

      const result = await server.tools[0]!.handler({});
      expect(result).toEqual({
        content: [{ type: "text", text: "Storage unavailable" }],
        isError: true,
      });
    });
  });

  describe("delete_file handler", () => {
    it("deletes the named file", async () => {
      const ctx = baseContext();
      ctx.deleteFile = vi.fn(async () => {});
      registerAgentLifecycleTools(
        server as never,
        new Set(["delete_file"]),
        ctx
      );

      const result = await server.tools[0]!.handler({
        fileName: "screenshot.png",
      });

      expect(ctx.deleteFile).toHaveBeenCalledWith(AGENT_ID, "screenshot.png");
      expect(result).toEqual({
        content: [{ type: "text", text: 'Deleted file "screenshot.png".' }],
      });
    });
  });
});
