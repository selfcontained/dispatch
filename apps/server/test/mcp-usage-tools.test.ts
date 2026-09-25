import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProviderPlansResponse } from "@dispatch/shared";
import { createDispatchMcpServer } from "../src/shared/mcp/server.js";
import {
  forgetLearnedAgentModels,
  setLearnedAgentModels,
} from "../src/shared/agent-models.js";

const report: ProviderPlansResponse = {
  checkedAt: "2026-09-24T12:00:00Z",
  providers: [
    {
      engine: "claude",
      plan: "Max",
      observedAt: "2026-09-24T11:00:00Z",
      windows: [
        {
          id: "session",
          label: "5-hour",
          usedPercent: 100,
          resetsAt: "2026-09-24T13:00:00Z",
        },
        {
          id: "weekly_scoped:Sonnet",
          label: "Sonnet weekly",
          usedPercent: 23,
          resetsAt: null,
        },
      ],
      spend: { used: 12, limit: 10, currency: "USD" },
      unavailableReason: "Refresh failed; cached report.",
    },
  ],
};

afterEach(forgetLearnedAgentModels);

async function withClient(
  context: Parameters<typeof createDispatchMcpServer>[0],
  run: (client: Client) => Promise<void>
) {
  const server = await createDispatchMcpServer(context);
  const client = new Client({ name: "usage-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const base = {
  agent: { id: "test", cwd: "/tmp" },
  repoRoot: null,
  worktreeRoot: null,
};

describe("get_usage", () => {
  it.each([false, true])(
    "is callable by agents and jobs (job=%s), preserving quota scope and freshness",
    async (job) => {
      setLearnedAgentModels("claude", [
        { id: "custom-model", label: "Learned model" },
      ]);
      const providerPlans = vi.fn(async () => report);
      await withClient(
        { ...base, providerPlans, ...(job ? { jobTools: {} as never } : {}) },
        async (client) => {
          const result = await client.callTool({
            name: "get_usage",
            arguments: { force: true },
          });
          expect(result.isError).not.toBe(true);
          expect(providerPlans).toHaveBeenCalledWith({ force: true });
          expect(result.structuredContent).toMatchObject({
            checkedAt: report.checkedAt,
            providers: [
              {
                type: "claude",
                models: [{ id: "custom-model" }],
                observedAt: report.providers[0]!.observedAt,
                unavailableReason: "Refresh failed; cached report.",
                windows: [
                  { id: "session", remainingPercent: 0 },
                  { id: "weekly_scoped:Sonnet", remainingPercent: 77 },
                ],
                spend: { remaining: 0, currency: "USD" },
              },
              {
                type: "codex",
                observedAt: null,
                windows: [],
                unavailableReason: "No usage report available.",
              },
            ],
          });
        }
      );
    }
  );

  it("filters types and rejects unsupported inputs", async () => {
    const providerPlans = vi.fn(async () => report);
    await withClient({ ...base, providerPlans }, async (client) => {
      const result = await client.callTool({
        name: "get_usage",
        arguments: { type: "codex" },
      });
      expect(result.structuredContent!.providers as unknown[]).toHaveLength(1);
      expect(result.structuredContent).toMatchObject({
        providers: [{ type: "codex" }],
      });
      const invalid = await client.callTool({
        name: "get_usage",
        arguments: { type: "unknown" },
      });
      expect(invalid.isError).toBe(true);
      expect(providerPlans).toHaveBeenCalledTimes(1);
    });
  });

  it("returns provider failures as tool errors", async () => {
    await withClient(
      {
        ...base,
        providerPlans: async () => {
          throw new Error("Usage unavailable");
        },
      },
      async (client) => {
        const result = await client.callTool({
          name: "get_usage",
          arguments: {},
        });
        expect(result.isError).toBe(true);
      }
    );
  });

  it("does not expose usage on the unscoped endpoint", async () => {
    await withClient(
      { ...base, agent: null, providerPlans: async () => report },
      async (client) => {
        await expect(
          client.callTool({ name: "get_usage", arguments: {} })
        ).rejects.toThrow("Method not found");
      }
    );
  });
});
