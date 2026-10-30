import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createDispatchMcpServer } from "../src/shared/mcp/server.js";
import { registerTaskTools } from "../src/shared/mcp/task-tools.js";
import type { TaskService } from "../src/tasks/service.js";

async function withClient(
  job: boolean,
  run: (client: Client, update: ReturnType<typeof vi.fn>) => Promise<void>
) {
  const column = {
    id: "col_own",
    projectId: "own",
    key: "ready",
    name: "Ready",
    position: 2,
    capacity: 3,
    activeTaskCount: 0,
    isDone: false,
    trigger: null,
  };
  const update = vi.fn(async () => column);
  const server = await createDispatchMcpServer({
    agent: { id: "caller", cwd: "/repo", projectId: "own", fullAccess: false },
    repoRoot: null,
    worktreeRoot: null,
    ...(job ? { jobTools: {} as never } : {}),
    taskService: {
      projectForAgent: async () => "own",
      boardWatching: async () => false,
      watchBoard: async () => {},
      unwatchBoard: async () => {},
      resolveColumnKey: async () => column,
      updateColumn: update,
      getBoard: async () => ({
        projectId: "own",
        columns: [column],
        tasks: [],
      }),
    } as unknown as TaskService,
  });
  const client = new Client({ name: "task-tools-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client, update);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("task column MCP boundary", () => {
  it.each([false, true])(
    "registers and calls the tool for agents and jobs (job=%s)",
    async (job) => {
      await withClient(job, async (client, update) => {
        const inventory = await client.listTools();
        expect(
          inventory.tools.find((t) => t.name === "task_column_update")
        ).toMatchObject({
          inputSchema: {
            required: ["column"],
            properties: { trigger: expect.any(Object) },
          },
        });
        const result = await client.callTool({
          name: "task_column_update",
          arguments: {
            column: "ready",
            trigger: null,
            capacity: 50,
            isDone: true,
            id: "col_foreign",
          },
        });
        expect(result.isError).not.toBe(true);
        expect(update).toHaveBeenCalledExactlyOnceWith("col_own", {
          trigger: null,
        });
        expect(result.structuredContent).toMatchObject({
          projectId: "own",
          id: "col_own",
          position: 2,
          capacity: 3,
          isDone: false,
          activeTaskCount: 0,
          trigger: null,
        });
      });
    }
  );

  it("rejects malformed input at the SDK boundary before updating", async () => {
    await withClient(false, async (client, update) => {
      for (const args of [
        {},
        { column: "" },
        { column: "ready", trigger: {} },
        { column: "ready", trigger: { templateId: "" } },
        {
          column: "ready",
          trigger: { templateId: "tpl", agentType: "invalid" },
        },
        { column: "ready", trigger: { templateId: "tpl", model: 42 } },
        { column: "ready", trigger: { templateId: "tpl", assign: "true" } },
        { column: "ready", trigger: { templateId: "tpl", fireOnCreate: 1 } },
      ]) {
        const result = await client.callTool({
          name: "task_column_update",
          arguments: args,
        });
        expect(result.isError, JSON.stringify(args)).toBe(true);
      }
      expect(update).not.toHaveBeenCalled();
    });
  });

  it("honors the allowed tool set", () => {
    const registerTool = vi.fn();
    registerTaskTools({ registerTool } as never, new Set(["task_list"]), {
      caller: { kind: "agent", agentId: "caller" },
      resolveProject: async () => "own",
      service: {} as TaskService,
    });
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
      "task_list",
    ]);
  });
});

describe("board watch MCP boundary", () => {
  it.each([false, true])(
    "registers independent board watches for agents and callable jobs (job=%s)",
    async (job) => {
      await withClient(job, async (client) => {
        const inventory = await client.listTools();
        for (const name of ["task_board_watch", "task_board_unwatch"]) {
          const tool = inventory.tools.find((t) => t.name === name)!;
          expect(tool.inputSchema.properties).toEqual({
            projectId: expect.any(Object),
          });
          expect(tool.inputSchema.required ?? []).toEqual([]);
          expect(
            (await client.callTool({ name, arguments: {} })).structuredContent
          ).toEqual({
            projectId: "own",
            watching: name === "task_board_watch",
          });
          expect(
            (
              await client.callTool({
                name,
                arguments: { projectId: "foreign" },
              })
            ).isError
          ).toBe(true);
          expect(
            (await client.callTool({ name, arguments: { projectId: "" } }))
              .isError
          ).toBe(true);
        }
        const list = await client.callTool({
          name: "task_list",
          arguments: {},
        });
        expect(list.structuredContent).toMatchObject({
          projectId: "own",
          boardWatching: false,
        });
      });
    }
  );

  it("does not fabricate a subscriber for an unscoped/admin context", async () => {
    const server = await createDispatchMcpServer({
      repoRoot: null,
      worktreeRoot: null,
      taskService: {} as TaskService,
    });
    const client = new Client({ name: "board-admin-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      await expect(
        client.callTool({ name: "task_board_watch", arguments: {} })
      ).rejects.toThrow();
      await expect(
        client.callTool({ name: "task_board_unwatch", arguments: {} })
      ).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
