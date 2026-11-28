import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../../packages/runner/src/workload/shared/lib/run-command.js",
  () => import("../src/shared/lib/run-command.js")
);
vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
}));

import {
  createDispatchMcpServer,
  type McpRequestContext,
} from "../src/shared/mcp/server.js";

import type { FastifyBaseLogger } from "fastify";
import { requestCheckoutCommand } from "../src/agents/checkout-commands.js";
import type { AgentRecord } from "../src/agents/types.js";
import { discoverRepoTools } from "../src/server/mcp-checkout.js";
import { controllerPlacement } from "../src/runners/placement.js";

function nativeCatalog(root: string) {
  const agent = {
    ...AGENT,
    cwd: root,
    worktreePath: null,
    workspacePath: null,
  } as AgentRecord;
  const runners = {};
  const selector = {
    checkout: "effective",
    path: ".dispatch/tools.json",
  } as const;
  return () =>
    discoverRepoTools(
      {
        inspectCheckout: vi.fn(),
        readRepoManifest: () =>
          requestCheckoutCommand(runners, agent, { ...selector, kind: "read" }),
        runRepoCommand: (_, state, argv, signal) =>
          requestCheckoutCommand(
            runners,
            agent,
            { ...selector, kind: "run", state, argv },
            signal
          ),
      },
      agent
    );
}

const AGENT = {
  id: "agt_tool_blip",
  cwd: "/tmp",
  placement: controllerPlacement,
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
      name: "rename_session",
      arguments: { name: "Renamed" },
    });
    expect(result.isError).toBeFalsy();
    expect(renameSession).toHaveBeenCalledWith(AGENT.id, "Renamed");
    expect(publishUiEvent).toHaveBeenCalledTimes(1);
    expect(publishUiEvent).toHaveBeenCalledWith({
      type: "agent.tool_invoked",
      agentId: AGENT.id,
      tool: "rename_session",
      at: "2026-09-03T12:00:00.000Z",
    });
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
    const client = await connect({
      publishUiEvent,
      repoRoot,
      discoverRepoTools: nativeCatalog(repoRoot),
    });

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
      name: "rename_session",
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
      name: "rename_session",
      arguments: { name: "Quiet" },
    });
    expect(result.isError).toBeFalsy();
  });
});

it("leaves a native checkout command running when the MCP client cancels, as main did", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-repo-cancel-"));
  const abort = new AbortController();
  let pid = "";
  try {
    await mkdir(path.join(root, ".dispatch"));
    await writeFile(
      path.join(root, ".dispatch/tools.json"),
      JSON.stringify({
        tools: [
          {
            name: "wait",
            description: "Start a subprocess and wait for cancellation.",
            command: ["sh", "-c", 'sleep 60 & echo "$!" > child.pid; wait'],
          },
        ],
      })
    );
    const client = await connect({
      repoRoot: root,
      discoverRepoTools: nativeCatalog(root),
    });
    expect((await client.listTools()).tools).toContainEqual(
      expect.objectContaining({ name: "repo_wait" })
    );
    const result = client
      .callTool({ name: "repo_wait", arguments: {} }, undefined, {
        signal: abort.signal,
      })
      .catch((error: unknown) => error);
    const childFile = path.join(root, "child.pid");
    await vi.waitFor(async () => {
      pid = (await readFile(childFile, "utf8")).trim();
      expect(pid).toMatch(/^\d+$/);
    });
    abort.abort();
    expect(await result).toBeInstanceOf(Error);
    // Main ran repo tools without a cancellation signal: what they started
    // keeps running after the client gives up.
    await new Promise((resolve) => setTimeout(resolve, 200));
    let status = "";
    try {
      status = execFileSync("ps", ["-o", "stat=", "-p", pid], {
        encoding: "utf8",
      }).trim();
    } catch {
      // No matching process.
    }
    expect(status).toMatch(/^[^Z]/);
  } finally {
    abort.abort();
    if (pid) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
