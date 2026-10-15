import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, utimes, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
      source: "local",
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
    expect(plan.source).toBe("local");
  });

  it("reads credits and limit status from rollout rate limits", () => {
    const line = JSON.parse(codexLine(NOW.toISOString(), 100, 0));
    line.payload.rate_limits.credits = {
      has_credits: true,
      unlimited: false,
      balance: "62500.0000000000",
    };
    line.payload.rate_limits.spend_control_reached = true;
    expect(parseCodexRollout(JSON.stringify(line))).toMatchObject({
      credits: { balance: 62500, unlimited: false },
      limitReached: true,
      source: "local",
    });
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
  const fallback = codexLine("2026-09-24T09:00:00Z", 30, 3);
  const codexAuth = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "codex-token", account_id: "account-123" },
  });
  const codexUsage = {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 0,
        limit_window_seconds: 604800,
        reset_after_seconds: 593939,
        reset_at: 1792687999,
      },
      secondary_window: null,
    },
    credits: {
      has_credits: true,
      unlimited: false,
      overage_limit_reached: false,
      balance: "62500.0000000000",
    },
    spend_control: { reached: false, individual_limit: null },
    rate_limit_reached_type: null,
  };
  const codexOptions = (auth?: string) => ({
    now: NOW,
    homeDir: "/home",
    env: {},
    platform: "linux" as const,
    read: async (file: string) =>
      file === "/home/.codex/auth.json" && auth !== undefined
        ? auth
        : read(file),
    codexFiles: async () => ["/rollout"],
    readTail: async () => fallback,
  });

  it("fetches live Codex usage with its existing login and maps weekly-only quota and credits", async () => {
    const fetchUsage = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("chatgpt.com") ? codexUsage : claudeUtilization
          )
        )
    );
    const report = await loadProviderPlans({
      ...codexOptions(codexAuth),
      fetchUsage: fetchUsage as unknown as typeof fetch,
    });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    const [, init] = fetchUsage.mock.calls.find(([url]) =>
      url.includes("chatgpt.com")
    )! as [string, RequestInit];
    expect(init).toMatchObject({
      redirect: "error",
      headers: {
        Authorization: "Bearer codex-token",
        "ChatGPT-Account-Id": "account-123",
      },
    });
    expect(init.signal).toBeDefined();
    expect(report.providers[1]).toMatchObject({
      plan: "Pro",
      source: "live",
      observedAt: NOW.toISOString(),
      credits: { balance: 62500, unlimited: false },
      limitReached: false,
      windows: [
        {
          id: "primary",
          label: "Weekly",
          usedPercent: 0,
          resetsAt: new Date(1792687999 * 1000).toISOString(),
        },
      ],
    });
    expect(report.providers[1]?.windows).toHaveLength(1);
  });

  it.each([
    ["missing auth", undefined],
    ["API key mode", JSON.stringify({ auth_mode: "apikey" })],
  ])("uses rollout silently for %s", async (_name, auth) => {
    const warn = vi.fn();
    const fetchUsage = vi.fn(
      async () => new Response(JSON.stringify(claudeUtilization))
    );
    const report = await loadProviderPlans({
      ...codexOptions(auth),
      fetchUsage: fetchUsage as unknown as typeof fetch,
      log: { warn },
    });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(report.providers[1]).toMatchObject({
      source: "local",
      observedAt: "2026-09-24T09:00:00Z",
    });
    expect(report.providers[1]?.unavailableReason).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "could not refresh Codex plan usage"
    );
  });

  const expiredToken = `x.${Buffer.from(
    JSON.stringify({ exp: Math.floor(NOW.valueOf() / 1000) - 1 })
  ).toString("base64url")}.x`;

  it.each([
    // An expired token is never sent: the endpoint is not asked at all.
    [
      "expired JWT",
      "expired",
      "login_expired",
      0,
      /login on this machine has expired/,
    ],
    [
      "401",
      "unauthorized",
      "login_rejected",
      1,
      /login on this machine has expired/,
    ],
    [
      "network failure",
      "network",
      "request_failed",
      1,
      /Could not refresh Codex/,
    ],
  ])(
    "falls back with a reason for %s",
    async (_name, failure, reason, codexCalls, message) => {
      const token = failure === "expired" ? expiredToken : "codex-token";
      const auth = JSON.stringify({
        tokens: { access_token: token, account_id: "account-123" },
      });
      const fetchUsage = vi.fn(async (url: string) => {
        if (!url.includes("chatgpt.com"))
          return new Response(JSON.stringify(claudeUtilization));
        if (failure === "network") throw new Error("offline");
        return new Response("", { status: 401 });
      });
      const warn = vi.fn();
      const report = await loadProviderPlans({
        ...codexOptions(auth),
        fetchUsage: fetchUsage as unknown as typeof fetch,
        log: { warn },
      });
      expect(
        fetchUsage.mock.calls.filter(([url]) => url.includes("chatgpt.com"))
      ).toHaveLength(codexCalls);
      expect(report.providers[1]?.source).toBe("local");
      expect(report.providers[1]?.windows[0]?.usedPercent).toBe(30);
      expect(report.providers[1]?.unavailableReason).toMatch(message);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason }),
        "could not refresh Codex plan usage"
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
    }
  );

  it("chooses the newest timestamp from every candidate tail", async () => {
    const report = await loadProviderPlans({
      ...codexOptions(),
      codexFiles: async () => ["/mtime-new", "/mtime-old"],
      readTail: async (file) =>
        file === "/mtime-new"
          ? codexLine("2026-09-24T08:00:00Z", 80, 2)
          : codexLine("2026-09-24T10:00:00Z", 10, 1),
    });
    expect(report.providers[1]?.observedAt).toBe("2026-09-24T10:00:00Z");
  });

  it("considers all files in the newest day before limiting to twelve", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-rollouts-"));
    try {
      const day = path.join(root, "sessions", "2026", "09", "24");
      await mkdir(day, { recursive: true });
      for (let i = 0; i < 13; i++) {
        const file = path.join(day, `${String(i).padStart(2, "0")}.jsonl`);
        await writeFile(
          file,
          i === 0 ? codexLine("2026-09-24T00:00:00Z", 0, 0) : ""
        );
        await utimes(
          file,
          new Date(NOW.valueOf() + (i === 0 ? 100_000 : i * 1000)),
          new Date(NOW.valueOf() + (i === 0 ? 100_000 : i * 1000))
        );
      }
      const report = await loadProviderPlans({
        now: NOW,
        homeDir: "/home",
        env: { CODEX_HOME: root },
        platform: "linux",
        read,
        fetchUsage: vi.fn(
          async () => new Response(JSON.stringify(claudeUtilization))
        ) as unknown as typeof fetch,
      });
      expect(report.providers[1]?.observedAt).toBe("2026-09-24T00:00:00Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("keeps the last good Codex windows when a later refresh fails", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      let codexCalls = 0;
      const fetchUsage = vi.fn(async (url: string) => {
        if (!url.includes("chatgpt.com"))
          return new Response(JSON.stringify(claudeUtilization));
        codexCalls += 1;
        if (codexCalls === 2) throw new Error("offline");
        return new Response(JSON.stringify(codexUsage));
      });
      const reporter = createProviderPlansReporter({
        ...codexOptions(codexAuth),
        fetchUsage: fetchUsage as unknown as typeof fetch,
      });
      const first = await reporter();
      vi.setSystemTime(new Date(NOW.valueOf() + 60_000));
      const second = await reporter({ force: true });
      expect(first.providers[1]?.source).toBe("live");
      expect(second.providers[1]).toMatchObject({
        source: "live",
        observedAt: NOW.toISOString(),
        unavailableReason: expect.stringMatching(/Could not refresh Codex/),
      });
      expect(second.providers[1]?.windows).toEqual(first.providers[1]?.windows);
    } finally {
      vi.useRealTimers();
    }
  });
});
