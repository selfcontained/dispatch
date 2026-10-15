import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProviderPlansResponse } from "@dispatch/shared";
import { createDispatchMcpServer } from "../src/shared/mcp/server.js";
import { summarizeUsage } from "../src/shared/mcp/usage-tools.js";
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
      observedAt: "2026-09-24T11:55:00Z",
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
            suggestedType: null,
            summary:
              "Every reported type is low or exhausted; codex, opencode do not report usage. Tell the user before launching. " +
              "claude: 0% headroom (exhausted); codex: unknown; opencode: unknown.",
            providers: [
              {
                type: "claude",
                status: "exhausted",
                headroomPercent: 0,
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
                status: "unknown",
                headroomPercent: null,
                observedAt: null,
                windows: [],
                unavailableReason: "No usage report available.",
              },
              {
                type: "opencode",
                status: "unknown",
                headroomPercent: null,
                models: [],
                observedAt: null,
                windows: [],
                unavailableReason:
                  "OpenCode ACP reports session usage, but does not expose provider subscription limits.",
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

  /** Claude's weekly window is nearly spent; Codex is barely touched. */
  const lowClaude: ProviderPlansResponse = {
    checkedAt: report.checkedAt,
    providers: [
      {
        engine: "claude",
        plan: "Max",
        observedAt: report.providers[0]!.observedAt,
        windows: [
          { id: "session", label: "5-hour", usedPercent: 40, resetsAt: null },
          { id: "weekly", label: "Weekly", usedPercent: 88, resetsAt: null },
        ],
      },
      {
        engine: "codex",
        plan: "Plus",
        observedAt: report.providers[0]!.observedAt,
        windows: [
          { id: "primary", label: "5-hour", usedPercent: 10, resetsAt: null },
        ],
      },
    ],
  };

  it("never suggests a type that is disabled in settings", async () => {
    await withClient(
      {
        ...base,
        providerPlans: async () => lowClaude,
        enabledAgentTypes: async () => ["claude", "opencode"],
      },
      async (client) => {
        const result = await client.callTool({
          name: "get_usage",
          arguments: {},
        });
        expect(result.structuredContent).toMatchObject({
          suggestedType: null,
          summary:
            "Every reported type is low or exhausted; opencode does not report usage. Tell the user before launching. " +
            "claude: 12% headroom (low); codex: 90% headroom (ok), disabled in settings; opencode: unknown.",
          providers: [
            { type: "claude", enabled: true, status: "low" },
            {
              type: "codex",
              enabled: false,
              status: "ok",
              headroomPercent: 90,
            },
            { type: "opencode", enabled: true, status: "unknown" },
          ],
        });
      }
    );
  });

  it("suggests the type with headroom when the parent's is running low", async () => {
    const providerPlans = vi.fn(async () => lowClaude);
    await withClient({ ...base, providerPlans }, async (client) => {
      const result = await client.callTool({
        name: "get_usage",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        suggestedType: "codex",
        summary:
          "Prefer codex: claude is low. " +
          "claude: 12% headroom (low); codex: 90% headroom (ok); opencode: unknown.",
        providers: [
          { type: "claude", status: "low", headroomPercent: 12 },
          { type: "codex", status: "ok", headroomPercent: 90 },
          { type: "opencode", status: "unknown" },
        ],
      });
    });
  });

  it("keeps zero headroom low when credits remain and the provider says the limit is not reached", async () => {
    const plans: ProviderPlansResponse = {
      checkedAt: report.checkedAt,
      providers: [
        {
          engine: "codex",
          plan: "Pro",
          observedAt: "2026-09-24T11:55:00Z",
          source: "live",
          windows: [
            {
              id: "primary",
              label: "Weekly",
              usedPercent: 100,
              resetsAt: null,
            },
          ],
          credits: { balance: 62500, unlimited: false },
          limitReached: false,
        },
      ],
    };
    await withClient(
      { ...base, providerPlans: async () => plans },
      async (client) => {
        const result = await client.callTool({
          name: "get_usage",
          arguments: { type: "codex" },
        });
        expect(result.structuredContent).toMatchObject({
          providers: [
            {
              status: "low",
              headroomPercent: 0,
              source: "live",
              limitReached: false,
              credits: { balance: 62500, unlimited: false },
            },
          ],
        });
      }
    );
  });

  it("marks a provider-reported limit reached as exhausted even below 100%", async () => {
    const plans: ProviderPlansResponse = {
      checkedAt: report.checkedAt,
      providers: [
        {
          engine: "codex",
          plan: "Pro",
          observedAt: "2026-09-24T11:55:00Z",
          source: "live",
          windows: [
            { id: "primary", label: "Weekly", usedPercent: 40, resetsAt: null },
          ],
          credits: { balance: 62500, unlimited: false },
          limitReached: true,
        },
      ],
    };
    await withClient(
      { ...base, providerPlans: async () => plans },
      async (client) => {
        const result = await client.callTool({
          name: "get_usage",
          arguments: { type: "codex" },
        });
        expect(result.structuredContent).toMatchObject({
          providers: [
            { status: "exhausted", headroomPercent: 60, limitReached: true },
          ],
        });
      }
    );
  });

  it("adds a source-aware caveat for reports older than fifteen minutes", async () => {
    const plans: ProviderPlansResponse = {
      checkedAt: report.checkedAt,
      providers: [
        {
          engine: "codex",
          plan: "Pro",
          observedAt: "2026-09-24T09:00:00Z",
          source: "local",
          windows: [
            { id: "primary", label: "Weekly", usedPercent: 40, resetsAt: null },
          ],
        },
      ],
    };
    await withClient(
      { ...base, providerPlans: async () => plans },
      async (client) => {
        const result = await client.callTool({
          name: "get_usage",
          arguments: { type: "codex" },
        });
        expect(result.structuredContent?.summary as string).toContain(
          "codex's report is 3h old (local report)"
        );
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

describe("summarizeUsage", () => {
  it("prefers an open type over one whose limit is reached with more headroom", () => {
    // A spend cap exhausts Codex while its windows still show 90% left.
    expect(
      summarizeUsage([
        { type: "claude", enabled: true, headroomPercent: 30, status: "ok" },
        {
          type: "codex",
          enabled: true,
          headroomPercent: 90,
          status: "exhausted",
        },
      ])
    ).toEqual({
      suggestedType: "claude",
      summary:
        "Prefer claude: codex is exhausted. " +
        "claude: 30% headroom (ok); codex: 90% headroom (exhausted).",
    });
  });
});
