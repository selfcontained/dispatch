import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
}));

import {
  createDispatchMcpServer,
  type McpRequestContext,
} from "../src/shared/mcp/server.js";

const AGENT = {
  id: "agt_tool_blip",
  cwd: "/tmp",
  type: "claude" as const,
  role: "agent" as const,
  persona: null,
  parentAgentId: null,
  baseBranch: "main",
};

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  vi.useRealTimers();
});

async function connect(context: Partial<McpRequestContext>) {
  const server = await createDispatchMcpServer({
    agent: AGENT,
    repoRoot: null,
    worktreeRoot: null,
    upsertEvent: vi.fn(async () => {}),
    renameSession: vi.fn(async (_id, name) => ({ id: AGENT.id, name })),
    ...context,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("agent.tool_invoked", () => {
  it("publishes one event per tool call, before the tool runs", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-03T12:00:00.000Z") });
    const publishUiEvent = vi.fn();
    const renameSession = vi.fn(async (_id: string, name: string) => {
      // The blip precedes the tool's own work.
      expect(publishUiEvent).toHaveBeenCalledTimes(1);
      return { id: AGENT.id, name };
    });
    const client = await connect({ publishUiEvent, renameSession });

    const result = await client.callTool({
      name: "dispatch_rename_session",
      arguments: { name: "Renamed" },
    });
    expect(result.isError).toBeFalsy();
    expect(renameSession).toHaveBeenCalledWith(AGENT.id, "Renamed");
    expect(publishUiEvent).toHaveBeenCalledTimes(1);
    expect(publishUiEvent).toHaveBeenCalledWith({
      type: "agent.tool_invoked",
      agentId: AGENT.id,
      tool: "dispatch_rename_session",
      at: "2026-09-03T12:00:00.000Z",
    });
  });

  it("skips dispatch_event, which already drives the phase", async () => {
    const publishUiEvent = vi.fn();
    const upsertEvent = vi.fn(async () => {});
    const client = await connect({ publishUiEvent, upsertEvent });

    const result = await client.callTool({
      name: "dispatch_event",
      arguments: { type: "working", message: "busy" },
    });
    expect(result.isError).toBeFalsy();
    expect(upsertEvent).toHaveBeenCalled();
    expect(publishUiEvent).not.toHaveBeenCalled();
  });

  it("covers dynamic repo tools", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "tool-blip-"));
    await mkdir(path.join(repoRoot, ".dispatch"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".dispatch", "tools.json"),
      JSON.stringify({
        tools: [
          { name: "echo", description: "Echo.", command: ["echo", "hi"] },
        ],
      })
    );
    const publishUiEvent = vi.fn();
    const client = await connect({ publishUiEvent, repoRoot });

    const result = await client.callTool({
      name: "repo_echo",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(publishUiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent.tool_invoked", tool: "repo_echo" })
    );
  });

  it("never lets a throwing publisher break the tool call", async () => {
    const publishUiEvent = vi.fn(() => {
      throw new Error("broker down");
    });
    const renameSession = vi.fn(async (_id: string, name: string) => ({
      id: AGENT.id,
      name,
    }));
    const client = await connect({ publishUiEvent, renameSession });

    const result = await client.callTool({
      name: "dispatch_rename_session",
      arguments: { name: "Still works" },
    });
    expect(result.isError).toBeFalsy();
    expect(renameSession).toHaveBeenCalledWith(AGENT.id, "Still works");
    expect(publishUiEvent).toHaveBeenCalledTimes(1);
  });

  it("stays quiet without a publisher", async () => {
    const renameSession = vi.fn(async (_id: string, name: string) => ({
      id: AGENT.id,
      name,
    }));
    const client = await connect({ renameSession });
    const result = await client.callTool({
      name: "dispatch_rename_session",
      arguments: { name: "Quiet" },
    });
    expect(result.isError).toBeFalsy();
  });
});
