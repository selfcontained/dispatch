import { describe, expect, it } from "vitest";

import {
  loadHarnessProviderUsage,
  parseClaudeProviderUsage,
  parseCodexProviderUsage,
} from "../src/agents/harness/provider-usage.js";

describe("harness provider usage", () => {
  it("reads Claude plan windows and extra usage without account metadata", () => {
    const result = parseClaudeProviderUsage(
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: Date.parse("2026-09-11T01:00:00Z"),
          accountUuid: "must-not-leak",
          utilization: {
            limits: [
              {
                kind: "session",
                percent: 30,
                resets_at: "2026-09-11T03:00:00Z",
              },
              {
                kind: "weekly_scoped",
                percent: 98,
                resets_at: "2026-09-12T02:00:00Z",
                scope: { model: { display_name: "Fable" } },
              },
            ],
            spend: {
              used: { amount_minor: 2010, exponent: 2, currency: "USD" },
              limit: { amount_minor: 5000, exponent: 2, currency: "USD" },
            },
          },
        },
      })
    );

    expect(result).toMatchObject({
      engineId: "claude",
      observedAt: "2026-09-11T01:00:00.000Z",
      windows: [
        { id: "session", label: "5-hour", usedPercent: 30 },
        {
          id: "weekly_scoped:Fable",
          label: "Fable weekly",
          usedPercent: 98,
        },
      ],
      spend: { used: 20.1, limit: 50, currency: "USD" },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("reads Codex plan windows from the newest token count", () => {
    const result = parseCodexProviderUsage(
      [
        JSON.stringify({
          timestamp: "2026-09-11T01:00:00Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              plan_type: "plus",
              primary: {
                used_percent: 12,
                window_minutes: 300,
                resets_at: 1789017210,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-11T02:00:00Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              plan_type: "team",
              primary: {
                used_percent: 25,
                window_minutes: 300,
                resets_at: 1789017210,
              },
              secondary: {
                used_percent: 40,
                window_minutes: 10080,
                resets_at: 1789447706,
              },
            },
          },
        }),
      ].join("\n")
    );

    expect(result.plan).toBe("Team");
    expect(result.observedAt).toBe("2026-09-11T02:00:00Z");
    expect(result.windows).toEqual([
      expect.objectContaining({ label: "5-hour", usedPercent: 25 }),
      expect.objectContaining({ label: "Weekly", usedPercent: 40 }),
    ]);
  });

  it("uses the newest rollout carrying provider limits", async () => {
    const files = ["/logs/old.jsonl", "/logs/new.jsonl"];
    const report = await loadHarnessProviderUsage({
      now: new Date("2026-09-11T03:00:00Z"),
      homeDir: "/home/service",
      codexFiles: async () => files,
      modifiedAt: async (file) => (file.includes("new") ? 2 : 1),
      read: async (file) => {
        if (file.endsWith(".claude.json")) throw new Error("missing");
        const used = file.includes("new") ? 70 : 20;
        return JSON.stringify({
          timestamp: "2026-09-11T02:30:00Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: used, window_minutes: 300 },
            },
          },
        });
      },
    });

    expect(report.checkedAt).toBe("2026-09-11T03:00:00.000Z");
    expect(report.providers).toHaveLength(4);
    expect(
      report.providers.find((item) => item.engineId === "codex")
    ).toMatchObject({
      windows: [expect.objectContaining({ usedPercent: 70 })],
    });
  });
});
