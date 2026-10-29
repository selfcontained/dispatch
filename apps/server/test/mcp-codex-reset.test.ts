import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createAgentMcpToken,
  createJobMcpToken,
  validateAgentMcpToken,
  validateJobMcpToken,
} from "../src/auth.js";
import { createCodexResetCoordinator } from "../src/agents/codex-reset.js";
import { registerMcpRoutes } from "../src/routes/mcp.js";
import { registerAgentUsageRoutes } from "../src/routes/agents/usage-routes.js";
import { registerUsageTools } from "../src/shared/mcp/usage-tools.js";

const key = "a8b3cda6-7890-4a17-a031-9affc78a1eba";
const secret = "isolated-test-only-not-a-production-secret";
const outcome = {
  code: "ok",
  windowsReset: 1,
  credit: { id: "mock-credit", title: "Mock reset", expiresAt: null },
};
const report = {
  checkedAt: "2026-10-28T12:00:00Z",
  providers: [
    {
      engine: "codex" as const,
      plan: "Plus",
      observedAt: null,
      windows: [],
      limitResets: { available: 0, applicable: 0 },
    },
  ],
};

describe("authenticated Codex reset MCP HTTP transport (mock provider only)", () => {
  it("honors tool allowlists", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    const redeem = vi.fn();
    registerUsageTools(server, new Set(["get_usage"]), {
      redeemCodexReset: redeem,
      providerPlans: async () => report,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(b);
    await client.connect(a);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["get_usage"]
      );
      expect(
        (
          await client.callTool({
            name: "redeem_codex_reset",
            arguments: { idempotencyKey: key },
          })
        ).isError
      ).toBe(true);
      expect(redeem).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists/calls through real scoped-token HTTP, shares UI replay, denies wrong scopes and public access", async () => {
    const app = Fastify();
    const consume = vi.fn(async (_requestId: string) => outcome);
    const providerPlans = Object.assign(
      vi.fn(async () => report),
      { invalidate: vi.fn() }
    );
    const redeemCodexReset = createCodexResetCoordinator({
      consume,
      providerPlans,
    });
    const agentManager = {
      getAgent: async (id: string) => ({
        id,
        cwd: process.cwd(),
        fullAccess: false,
      }),
      listAgents: async () => [],
    };
    const deps = {
      config: { authToken: secret },
      providerPlans,
      redeemCodexReset,
      agentManager,
      pool: { query: async () => ({ rows: [] }) },
      jobService: {
        getActiveRunForAgent: async (id: string) =>
          id === "job-agent" ? { id: "run-test" } : null,
      },
      getBearerToken: (request: { headers: { authorization?: string } }) =>
        request.headers.authorization?.replace(/^Bearer /, "") ?? null,
      validateAgentMcpToken,
      validateJobMcpToken,
      loginLinkStore: { issue: () => ({}) },
      templateService: {},
      brainStore: {},
      publishBrainChanged: () => {},
      mcpMethodNotAllowed: () => ({}),
    };
    await registerMcpRoutes(app, deps as never);
    await registerAgentUsageRoutes(app, { ...deps, appLog: app.log } as never);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const transcript: unknown[] = [
      {
        safety:
          "Ephemeral loopback Fastify, real MCP HTTP transport and HMAC token validation; reset provider and usage mocked, no real account credentials or provider calls.",
      },
    ];
    try {
      for (const [route, token] of [
        ["/api/mcp/agent-test", createAgentMcpToken(secret, "agent-test")],
        [
          "/api/mcp/jobs/run-test/job-agent",
          createJobMcpToken(secret, "run-test", "job-agent"),
        ],
      ]) {
        const client = new Client({ name: "safe-reset-proof", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(route, address), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          })
        );
        try {
          const tools = (await client.listTools()).tools;
          const reset = tools.find(
            (tool) => tool.name === "redeem_codex_reset"
          );
          expect(reset?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          });
          expect(
            tools.find((tool) => tool.name === "get_usage")?.annotations
              ?.readOnlyHint
          ).toBe(true);
          const invalid = await client.callTool({
            name: "redeem_codex_reset",
            arguments: { idempotencyKey: "not-a-uuid" },
          });
          expect(invalid.isError).toBe(true);
          const result = await client.callTool({
            name: "redeem_codex_reset",
            arguments: { idempotencyKey: key },
          });
          expect(result.structuredContent).toEqual({
            outcome,
            error: null,
            usage: report,
            refreshError: null,
          });
          transcript.push({
            route,
            listedTool: reset,
            arguments: { idempotencyKey: key },
            result,
          });
        } finally {
          await client.close();
        }
      }
      const ui = await app.inject({
        method: "POST",
        url: "/api/v1/usage/codex/resets/consume",
        payload: { idempotencyKey: key },
      });
      expect(ui.json()).toEqual(outcome);
      expect(consume).toHaveBeenCalledExactlyOnceWith(key);
      const invalidUi = await app.inject({
        method: "POST",
        url: "/api/v1/usage/codex/resets/consume",
        payload: { idempotencyKey: "invalid" },
      });
      expect(invalidUi.statusCode).toBe(400);
      for (const [route, token] of [
        ["/api/mcp/agent-test", createAgentMcpToken(secret, "other-agent")],
        [
          "/api/mcp/jobs/run-test/job-agent",
          createJobMcpToken(secret, "wrong-run", "job-agent"),
        ],
        [
          "/api/mcp/agent-test",
          createJobMcpToken(secret, "run-test", "job-agent"),
        ],
      ]) {
        const response = await app.inject({
          method: "POST",
          url: route,
          headers: { authorization: `Bearer ${token}` },
          payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
        expect(response.statusCode).toBe(403);
        transcript.push({ route, wrongScopeStatus: response.statusCode });
      }
      for (const route of ["/api/mcp", "/api/mcp/agent-test"]) {
        const client = new Client({ name: "unprivileged-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(route, address))
        );
        try {
          if (route === "/api/mcp") {
            await expect(client.listTools()).rejects.toThrow(
              "Method not found"
            );
            await expect(
              client.callTool({
                name: "redeem_codex_reset",
                arguments: { idempotencyKey: key },
              })
            ).rejects.toThrow();
          } else {
            expect(
              (await client.listTools()).tools.some(
                (tool) => tool.name === "redeem_codex_reset"
              )
            ).toBe(false);
            expect(
              (
                await client.callTool({
                  name: "redeem_codex_reset",
                  arguments: { idempotencyKey: key },
                })
              ).isError
            ).toBe(true);
          }
          transcript.push({
            route,
            withoutScopedBearer: "redemption unavailable",
          });
        } finally {
          await client.close();
        }
      }
      transcript.push({
        providerExecutionCount: consume.mock.calls.length,
        uiResponse: ui.json(),
        mocked: true,
      });
      if (process.env.CODEX_RESET_PROOF_PATH)
        await writeFile(
          process.env.CODEX_RESET_PROOF_PATH,
          JSON.stringify(transcript, null, 2)
        );
    } finally {
      await app.close();
    }
  });
});
