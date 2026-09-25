import { describe, expect, it, vi } from "vitest";

import {
  createProviderPlansReporter,
  loadProviderPlans,
  parseClaudeCache,
  parseCodexRollout,
} from "../src/agents/provider-plans.js";

const NOW = new Date("2026-09-24T12:00:00Z");

const codexLine = (timestamp: string, primary: number, secondary: number) =>
  JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        plan_type: "pro",
        primary: {
          used_percent: primary,
          window_minutes: 300,
          resets_at: 1790000000,
        },
        secondary: {
          used_percent: secondary,
          window_minutes: 10080,
          resets_at: 1790500000,
        },
      },
    },
  });

const claudeUtilization = {
  five_hour: { utilization: 42, resets_at: "2026-09-24T15:00:00Z" },
  seven_day: { utilization: 7, resets_at: "2026-09-30T00:00:00Z" },
};

describe("parseCodexRollout", () => {
  it("takes the newest rate limits and names the windows", () => {
    const raw = [
      '{"partial line from the middle of a file',
      codexLine("2026-09-24T10:00:00Z", 10, 1),
      codexLine("2026-09-24T11:00:00Z", 55, 12),
      '{"type":"event_msg","payload":{"type":"agent_message"}}',
    ].join("\n");
    expect(parseCodexRollout(raw)).toEqual({
      engine: "codex",
      plan: "Pro",
      observedAt: "2026-09-24T11:00:00Z",
      windows: [
        {
          id: "primary",
          label: "5-hour",
          usedPercent: 55,
          resetsAt: new Date(1790000000 * 1000).toISOString(),
        },
        {
          id: "secondary",
          label: "Weekly",
          usedPercent: 12,
          resetsAt: new Date(1790500000 * 1000).toISOString(),
        },
      ],
    });
  });

  it("says so when there is nothing", () => {
    const plan = parseCodexRollout("");
    expect(plan.windows).toEqual([]);
    expect(plan.unavailableReason).toMatch(/Codex/);
  });
});

describe("parseClaudeCache", () => {
  it("reads what Claude Code's /usage cached", () => {
    const plan = parseClaudeCache(
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: NOW.valueOf(),
          utilization: claudeUtilization,
        },
      })
    );
    expect(plan.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5-hour", 42],
      ["Weekly", 7],
    ]);
    expect(plan.observedAt).toBe(NOW.toISOString());
  });
});

describe("loadProviderPlans", () => {
  const files: Record<string, string> = {
    "/home/.claude/.credentials.json": JSON.stringify({
      claudeAiOauth: { accessToken: "tok", expiresAt: NOW.valueOf() + 60_000 },
    }),
  };
  const read = async (file: string) => {
    const hit = files[file];
    if (hit === undefined) throw new Error("ENOENT");
    return hit;
  };

  it("asks Anthropic with the signed-in token and reads Codex's newest rollout", async () => {
    const fetchUsage = vi.fn(
      async () => new Response(JSON.stringify(claudeUtilization))
    );
    const report = await loadProviderPlans({
      now: NOW,
      homeDir: "/home",
      env: {},
      platform: "linux",
      read,
      fetchUsage: fetchUsage as unknown as typeof fetch,
      codexFiles: async () => ["/new", "/old"],
      readTail: async (file) =>
        file === "/new" ? "" : codexLine("2026-09-24T09:00:00Z", 30, 3),
    });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    const [, init] = fetchUsage.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok"
    );
    const [claude, codex] = report.providers;
    expect(claude?.windows.map((w) => w.usedPercent)).toEqual([42, 7]);
    expect(claude?.unavailableReason).toBeUndefined();
    // The newest rollout had no report; the next one did.
    expect(codex?.windows.map((w) => w.usedPercent)).toEqual([30, 3]);
  });

  it("explains a Claude login that is not there, without calling out", async () => {
    const fetchUsage = vi.fn();
    const report = await loadProviderPlans({
      now: NOW,
      homeDir: "/nobody",
      env: {},
      platform: "linux",
      read,
      fetchUsage: fetchUsage as unknown as typeof fetch,
      codexFiles: async () => [],
    });
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(report.providers[0]?.unavailableReason).toMatch(/not signed in/);
  });

  it("caches, and a forced refresh inside the floor still reuses", async () => {
    let calls = 0;
    const reporter = createProviderPlansReporter({
      homeDir: "/nobody",
      env: {},
      platform: "linux",
      read,
      codexFiles: async () => {
        calls += 1;
        return [];
      },
    });
    await reporter();
    await reporter();
    await reporter({ force: true });
    expect(calls).toBe(1);
  });
});
