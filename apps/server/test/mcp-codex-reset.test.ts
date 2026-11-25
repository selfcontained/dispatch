import * as agentModels from "../src/shared/agent-models.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { createLocalEngineRunner } from "../src/agents/local-runner-engine.js";
import { createProviderPlansReporter } from "../src/agents/provider-plans.js";
import { createPluginStatusChecker } from "../src/shared/plugin-status.js";
import { registerPluginRoutes } from "../src/routes/plugin.js";
import { registerSystemRoutes } from "../src/routes/system.js";
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
      limitResets: {
        available: 3,
        applicable: 0,
        oldestExpiresAt: "2026-11-07T12:00:00Z",
        items: [
          {
            id: "oldest",
            title: "Reset",
            grantedAt: null,
            expiresAt: "2026-11-07T12:00:00Z",
          },
        ],
      },
    },
  ],
};

const { applicable: _rawCount, ...agentResets } =
  report.providers[0]!.limitResets;
const agentReport = {
  ...report,
  providers: [{ ...report.providers[0]!, limitResets: agentResets }],
};

describe("authenticated Codex reset MCP HTTP transport (mock provider only)", () => {
  it.each(["ok", "nothing_to_reset", "no_credit"])(
    "omits undocumented applicability while preserving %s and reset inventory",
    async (code) => {
      const server = new McpServer({ name: "test", version: "1" });
      const consume = vi.fn(async () => ({ ...outcome, code }));
      const providerPlans = Object.assign(
        vi.fn(async () => report),
        { invalidate: vi.fn() }
      );
      registerUsageTools(server, new Set(["get_usage", "redeem_codex_reset"]), {
        providerPlans,
        redeemCodexReset: createCodexResetCoordinator({
          consume,
          providerPlans,
        }),
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "1" });
      await server.connect(b);
      await client.connect(a);
      try {
        const usage = await client.callTool({
          name: "get_usage",
          arguments: { type: "codex" },
        });
        expect(usage.structuredContent).toMatchObject({
          providers: [{ limitResets: agentResets, windows: [] }],
        });
        expect(JSON.stringify(usage)).not.toContain('"applicable"');
        const result = await client.callTool({
          name: "redeem_codex_reset",
          arguments: { idempotencyKey: key },
        });
        expect(result.structuredContent).toEqual({
          outcome: { ...outcome, code },
          error: null,
          usage: agentReport,
          refreshError: null,
        });
        expect(JSON.stringify(result)).not.toContain('"applicable"');
        expect(consume).toHaveBeenCalledExactlyOnceWith(key);
        expect(report.providers[0]!.limitResets.applicable).toBe(0);
      } finally {
        await client.close();
        await server.close();
      }
    }
  );

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
    const home = await mkdtemp(
      path.join(os.tmpdir(), "native-engine-boundary-")
    );
    const codexBin = path.join(home, "codex");
    await mkdir(path.join(home, ".codex"));
    await writeFile(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          account_id: "native-fixture-account",
          access_token: "native-fixture-token",
        },
      })
    );
    await writeFile(
      codexBin,
      `#!/bin/sh
cd "$(dirname "$0")"
case "$*" in
  "plugin list --json")
    if test -f installed; then
      echo '{"installed":[{"pluginId":"dispatch@dispatch","version":"1.2.3","enabled":true}]}'
    else
      echo '{"installed":[]}'
    fi ;;
  "plugin marketplace list --json")
    printf '{"marketplaces":[{"name":"dispatch","root":"%s"}]}\n' "$PWD" ;;
  "plugin marketplace upgrade dispatch --json") ;;
  "plugin add dispatch@dispatch") touch installed ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 }
    );
    const consume = vi.fn();
    const fetchUsage = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe(
          "Bearer native-fixture-token"
        );
        expect(headers.get("ChatGPT-Account-Id")).toBe(
          "native-fixture-account"
        );
        if (String(url).endsWith("/consume")) {
          consume(JSON.parse(String(init?.body)).redeem_request_id);
          return Response.json({
            code: outcome.code,
            windows_reset: outcome.windowsReset,
            credit: { id: outcome.credit.id, title: outcome.credit.title },
          });
        }
        if (String(url).endsWith("/usage")) {
          return Response.json({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 25,
                limit_window_seconds: 604800,
              },
            },
          });
        }
        return Response.json({
          available_count: 3,
          applicable_available_count: 0,
        });
      }
    );
    const localEngines = createLocalEngineRunner({
      bins: { codex: codexBin, claude: codexBin },
      providerOptions: {
        homeDir: home,
        env: {},
        platform: "linux",
        fetchUsage,
      },
    });
    const readModels = vi.spyOn(agentModels, "agentModelCatalog");
    const readChoices = vi.spyOn(agentModels, "getAgentModelOptions");
    const providerPlans = createProviderPlansReporter({
      load: localEngines.readProviderPlans,
    });
    const redeemCodexReset = createCodexResetCoordinator({
      consume: localEngines.consumeCodexReset,
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
      localEngines,
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
    await registerPluginRoutes(app, {
      pool: deps.pool as never,
      plugins: createPluginStatusChecker({ binFor: () => codexBin }),
    });
    await registerSystemRoutes(app, { pool: deps.pool, localEngines } as never);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const transcript: unknown[] = [
      {
        safety:
          "Loopback HTTP with scoped MCP tokens and the native runner. A real temporary home supplies fixture credentials, a real CLI subprocess implements plugin changes, and provider HTTP is stubbed.",
      },
    ];
    try {
      const models = await app.inject({
        method: "GET",
        url: "/api/v1/agent-models",
      });
      expect(models.json()).toHaveProperty("models.codex");
      expect(readModels).toHaveBeenCalledOnce();
      const plan = await app.inject({
        method: "GET",
        url: "/api/v1/usage/plans",
      });
      expect(plan.json()).toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({
            engine: "codex",
            plan: "Plus",
            source: "live",
          }),
        ]),
      });
      const pluginBefore = await app.inject({
        method: "GET",
        url: "/api/v1/plugin/status",
      });
      expect(pluginBefore.json()).toMatchObject({
        statuses: expect.arrayContaining([
          expect.objectContaining({ agentType: "codex", installed: false }),
        ]),
      });
      const plugin = await app.inject({
        method: "POST",
        url: "/api/v1/plugin/install",
        payload: { agentType: "codex" },
      });
      expect(plugin.json()).toMatchObject({
        status: { installed: true, currentVersion: "1.2.3" },
      });
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
          const usage = await client.callTool({
            name: "get_usage",
            arguments: { type: "codex" },
          });
          expect(usage.structuredContent).toMatchObject({
            providers: [
              {
                engine: "codex",
                plan: "Plus",
                models: expect.any(Array),
              },
            ],
          });
          expect(readChoices).toHaveBeenCalledWith("codex");
          const invalid = await client.callTool({
            name: "redeem_codex_reset",
            arguments: { idempotencyKey: "not-a-uuid" },
          });
          expect(invalid.isError).toBe(true);
          const result = await client.callTool({
            name: "redeem_codex_reset",
            arguments: { idempotencyKey: key },
          });
          expect(result.structuredContent).toMatchObject({
            outcome,
            error: null,
            usage: {
              providers: expect.arrayContaining([
                expect.objectContaining({
                  engine: "codex",
                  limitResets: expect.objectContaining({ available: 3 }),
                }),
              ]),
            },
            refreshError: null,
          });
          expect(JSON.stringify(result)).not.toContain('"applicable"');
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
      await rm(home, { recursive: true, force: true });
    }
  });
});
