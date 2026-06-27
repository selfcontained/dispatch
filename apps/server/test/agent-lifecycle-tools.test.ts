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
    sendNotify: vi.fn(async () => ({ sent: true })),
    listMedia: vi.fn(async () => []),
  };
}

describe("registerAgentLifecycleTools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
  });

  // ── Conditional registration ────────────────────────────────────

  describe("conditional registration", () => {
    it("registers all four tools when all are allowed and context is complete", () => {
      const allowed = new Set([
        "dispatch_event",
        "dispatch_rename_session",
        "dispatch_notify",
        "dispatch_list_media",
      ]);
      registerAgentLifecycleTools(server as never, allowed, baseContext());

      const names = server.tools.map((t) => t.name);
      expect(names).toEqual([
        "dispatch_event",
        "dispatch_rename_session",
        "dispatch_notify",
        "dispatch_list_media",
      ]);
    });

    it("registers nothing when allowed set is empty", () => {
      registerAgentLifecycleTools(server as never, new Set(), baseContext());
      expect(server.tools).toHaveLength(0);
    });

    it("skips dispatch_event when upsertEvent is missing from context", () => {
      const ctx = baseContext();
      delete ctx.upsertEvent;
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_event"]),
        ctx
      );
      expect(server.tools).toHaveLength(0);
    });

    it("skips dispatch_rename_session when renameSession is missing", () => {
      const ctx = baseContext();
      delete ctx.renameSession;
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_rename_session"]),
        ctx
      );
      expect(server.tools).toHaveLength(0);
    });

    it("skips dispatch_notify when sendNotify is missing", () => {
      const ctx = baseContext();
      delete ctx.sendNotify;
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_notify"]),
        ctx
      );
      expect(server.tools).toHaveLength(0);
    });

    it("skips dispatch_list_media when listMedia is missing", () => {
      const ctx = baseContext();
      delete ctx.listMedia;
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_list_media"]),
        ctx
      );
      expect(server.tools).toHaveLength(0);
    });

    it("only registers tools that are in the allowed set", () => {
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_event", "dispatch_list_media"]),
        baseContext()
      );
      const names = server.tools.map((t) => t.name);
      expect(names).toEqual(["dispatch_event", "dispatch_list_media"]);
    });
  });

  // ── dispatch_event handler ──────────────────────────────────────

  describe("dispatch_event handler", () => {
    it("calls upsertEvent with correct args and returns formatted text", async () => {
      const ctx = baseContext();
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_event"]),
        ctx
      );
      const handler = server.tools[0]!.handler;

      const result = await handler({
        type: "working",
        message: "Reading files",
      });

      expect(ctx.upsertEvent).toHaveBeenCalledWith(AGENT_ID, {
        type: "working",
        message: "Reading files",
        metadata: undefined,
      });
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: `Updated ${AGENT_ID}: working - Reading files`,
          },
        ],
      });
    });

    it("passes metadata when provided", async () => {
      const ctx = baseContext();
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_event"]),
        ctx
      );
      const handler = server.tools[0]!.handler;

      await handler({
        type: "done",
        message: "Finished",
        metadata: { key: "value" },
      });

      expect(ctx.upsertEvent).toHaveBeenCalledWith(AGENT_ID, {
        type: "done",
        message: "Finished",
        metadata: { key: "value" },
      });
    });

    it("returns tool error when upsertEvent throws", async () => {
      const ctx = baseContext();
      ctx.upsertEvent = vi.fn(async () => {
        throw new Error("DB connection lost");
      });
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_event"]),
        ctx
      );

      const result = await server.tools[0]!.handler({
        type: "working",
        message: "test",
      });

      expect(result).toEqual({
        content: [{ type: "text", text: "DB connection lost" }],
        isError: true,
      });
    });
  });

  // ── dispatch_rename_session handler ─────────────────────────────

  describe("dispatch_rename_session handler", () => {
    it("calls renameSession and returns result", async () => {
      const ctx = baseContext();
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_rename_session"]),
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
        new Set(["dispatch_rename_session"]),
        ctx
      );

      const result = await server.tools[0]!.handler({ name: "x" });
      expect(result).toEqual({
        content: [{ type: "text", text: "Not found" }],
        isError: true,
      });
    });
  });

  // ── dispatch_notify handler ─────────────────────────────────────

  describe("dispatch_notify handler", () => {
    it("calls sendNotify and returns sent confirmation", async () => {
      const ctx = baseContext();
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_notify"]),
        ctx
      );
      const handler = server.tools[0]!.handler;

      const result = await handler({
        message: "Build finished",
        title: "CI",
        level: "success",
        respectFocus: false,
      });

      expect(ctx.sendNotify).toHaveBeenCalledWith(AGENT_ID, {
        message: "Build finished",
        title: "CI",
        level: "success",
        respectFocus: false,
      });
      expect(result).toEqual({
        content: [{ type: "text", text: "Notification sent to Slack." }],
      });
    });

    it("returns not-sent message with reason", async () => {
      const ctx = baseContext();
      ctx.sendNotify = vi.fn(async () => ({
        sent: false,
        reason: "No webhook configured",
      }));
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_notify"]),
        ctx
      );

      const result = await server.tools[0]!.handler({
        message: "test",
        level: "info",
        respectFocus: false,
      });

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Notification not sent: No webhook configured",
          },
        ],
      });
    });

    it("returns tool error on exception", async () => {
      const ctx = baseContext();
      ctx.sendNotify = vi.fn(async () => {
        throw new Error("Rate limited");
      });
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_notify"]),
        ctx
      );

      const result = await server.tools[0]!.handler({
        message: "x",
        level: "info",
        respectFocus: false,
      });
      expect(result).toEqual({
        content: [{ type: "text", text: "Rate limited" }],
        isError: true,
      });
    });
  });

  // ── dispatch_list_media handler ─────────────────────────────────

  describe("dispatch_list_media handler", () => {
    it("calls listMedia and returns JSON items", async () => {
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
      ctx.listMedia = vi.fn(async () => items);
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_list_media"]),
        ctx
      );

      const result = await server.tools[0]!.handler({ source: "screenshot" });

      expect(ctx.listMedia).toHaveBeenCalledWith(AGENT_ID, {
        source: "screenshot",
      });
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
      });
    });

    it("passes undefined source when omitted", async () => {
      const ctx = baseContext();
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_list_media"]),
        ctx
      );

      await server.tools[0]!.handler({});
      expect(ctx.listMedia).toHaveBeenCalledWith(AGENT_ID, {
        source: undefined,
      });
    });

    it("returns tool error on failure", async () => {
      const ctx = baseContext();
      ctx.listMedia = vi.fn(async () => {
        throw new Error("Storage unavailable");
      });
      registerAgentLifecycleTools(
        server as never,
        new Set(["dispatch_list_media"]),
        ctx
      );

      const result = await server.tools[0]!.handler({});
      expect(result).toEqual({
        content: [{ type: "text", text: "Storage unavailable" }],
        isError: true,
      });
    });
  });
});
