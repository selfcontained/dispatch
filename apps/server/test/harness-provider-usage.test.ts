import { describe, expect, it, vi } from "vitest";

import {
  loadHarnessProviderUsage,
  createHarnessProviderUsageReporter,
  parseClaudeProviderUsage,
  parseCodexProviderUsage,
} from "../src/agents/harness/provider-usage.js";

describe("harness provider usage", () => {
  it("keeps the last live Claude report if a later request fails", async () => {
    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ five_hour: { utilization: 42 } }))
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const reporter = createHarnessProviderUsageReporter(
      {
        env: {},
        homeDir: "/test",
        codexFiles: async () => [],
        fetchUsage,
        read: async (file) =>
          file.endsWith(".credentials.json")
            ? JSON.stringify({ claudeAiOauth: { accessToken: "test-secret" } })
            : "{}",
      },
      0
    );
    const first = await reporter();
    const second = await reporter();
    expect(second.providers[0]).toMatchObject({
      observedAt: first.providers[0].observedAt,
      windows: [{ usedPercent: 42 }],
      unavailableReason: expect.stringContaining("Could not refresh"),
    });
  });

  it("refreshes Claude usage instead of rereading an old interactive cache", async () => {
    const fetchUsage = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            five_hour: { utilization: 42, resets_at: "2026-09-11T08:00:00Z" },
          })
        )
    ) as unknown as typeof fetch;
    const report = await loadHarnessProviderUsage({
      now: new Date("2026-09-11T03:00:00Z"),
      homeDir: "/test",
      env: {},
      codexFiles: async () => [],
      fetchUsage,
      read: async (file) =>
        file.endsWith(".credentials.json")
          ? JSON.stringify({ claudeAiOauth: { accessToken: "test-secret" } })
          : "{}",
    });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(report.providers[0]).toMatchObject({
      observedAt: "2026-09-11T03:00:00.000Z",
      windows: [{ usedPercent: 42 }],
    });
    expect(JSON.stringify(report)).not.toContain("test-secret");
  });

  it("keeps the original report time when refreshing Claude fails", async () => {
    const report = await loadHarnessProviderUsage({
      now: new Date("2026-09-11T03:00:00Z"),
      homeDir: "/test",
      env: {},
      codexFiles: async () => [],
      fetchUsage: vi.fn(
        async () => new Response("private error", { status: 429 })
      ) as unknown as typeof fetch,
      read: async (file) =>
        JSON.stringify(
          file.endsWith(".credentials.json")
            ? { claudeAiOauth: { accessToken: "test-secret" } }
            : {
                cachedUsageUtilization: {
                  fetchedAtMs: Date.parse("2026-09-10T03:00:00Z"),
                  utilization: { five_hour: { utilization: 10 } },
                },
              }
        ),
    });
    expect(report.providers[0]).toMatchObject({
      observedAt: "2026-09-10T03:00:00.000Z",
      windows: [{ usedPercent: 10 }],
      unavailableReason: expect.stringContaining("Could not refresh"),
    });
    expect(JSON.stringify(report)).not.toContain("private error");
  });

  it("compares Codex report timestamps even when an old log was touched recently", async () => {
    const report = await loadHarnessProviderUsage({
      env: {},
      codexFiles: async () => ["old", "new"],
      modifiedAt: async (file) => (file === "old" ? 20 : 10),
      read: async (file) => {
        if (!["old", "new"].includes(file)) throw new Error("missing");
        return JSON.stringify({
          type: "event_msg",
          timestamp:
            file === "old" ? "2026-09-10T00:00:00Z" : "2026-09-11T00:00:00Z",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: file === "old" ? 90 : 15 },
            },
          },
        });
      },
    });
    expect(report.providers[1].windows[0].usedPercent).toBe(15);
  });

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
        // Claude Code's state file is `~/.claude.json`, in the home directory
        // itself; a read anywhere else is the bug this pins.
        if (file === "/home/service/.claude.json") throw new Error("missing");
        if (file.endsWith(".claude.json")) {
          throw new Error(`unexpected Claude config path ${file}`);
        }
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

describe("claudeConfigPath", () => {
  it("is ~/.claude.json, or CLAUDE_CONFIG_DIR/.claude.json when that is set", async () => {
    const { claudeConfigPath } =
      await import("../src/agents/harness/provider-usage.js");
    expect(claudeConfigPath("/home/service", {})).toBe(
      "/home/service/.claude.json"
    );
    expect(
      claudeConfigPath("/home/service", { CLAUDE_CONFIG_DIR: "/etc/claude" })
    ).toBe("/etc/claude/.claude.json");
    expect(claudeConfigPath("/home/service", { CLAUDE_CONFIG_DIR: " " })).toBe(
      "/home/service/.claude.json"
    );
  });
});
