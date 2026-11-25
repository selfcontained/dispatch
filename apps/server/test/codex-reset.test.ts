import { localEngineWorkload } from "../src/agents/remote/engine-runner-executor.js";
import {
  scopedEngineCalls,
  localEngineCalls,
  inProcessEngines,
} from "../src/runners/local.js";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { describe, expect, it, vi } from "vitest";
import {
  createRunnerUsage,
  createCodexResetCoordinator,
} from "../src/agents/codex-reset.js";
import { CodexResetError } from "../src/agents/provider-plans.js";

const key = "a8b3cda6-7890-4a17-a031-9affc78a1eba";
const otherKey = "bbf3cda6-7890-4a17-a031-9affc78a1eba";
const report = {
  checkedAt: "2026-10-28T12:00:00Z",
  providers: [
    { engine: "codex" as const, plan: "Plus", windows: [], observedAt: null },
  ],
};
const ok = { code: "ok", windowsReset: 1, credit: null };
const reporter = () =>
  Object.assign(
    vi.fn(async () => report),
    { invalidate: vi.fn() }
  );

describe("account-shared Codex reset orchestration", () => {
  it.each(["ok", "nothing_to_reset", "no_credit", "future_provider_code"])(
    "preserves %s and refreshes, replaying without spending",
    async (code) => {
      const consume = vi.fn(async () => ({ ...ok, code }));
      const providerPlans = reporter();
      const redeem = createCodexResetCoordinator({ consume, providerPlans });
      const first = await redeem(key);
      expect(first).toEqual({
        outcome: { ...ok, code },
        error: null,
        usage: report,
        refreshError: null,
      });
      expect(await redeem(key)).toEqual(first);
      expect(consume).toHaveBeenCalledExactlyOnceWith(key);
      expect(providerPlans.invalidate).toHaveBeenCalledOnce();
      expect(providerPlans).toHaveBeenCalledExactlyOnceWith({ force: true });
    }
  );

  it("joins same-key requests and refuses overlapping distinct UI/MCP attempts", async () => {
    let finish!: (value: typeof ok) => void;
    const consume = vi.fn(
      () =>
        new Promise<typeof ok>((resolve) => {
          finish = resolve;
        })
    );
    const redeem = createCodexResetCoordinator({
      consume,
      providerPlans: reporter(),
    });
    const first = redeem(key);
    expect(redeem(key)).toBe(first);
    expect((await redeem(otherKey)).error?.reason).toBe("reset_in_progress");
    expect((await redeem()).error?.reason).toBe("reset_in_progress");
    await Promise.resolve();
    finish(ok);
    await first;
    expect(consume).toHaveBeenCalledOnce();
  });

  it.each([
    "not_signed_in",
    "login_expired",
    "login_rejected",
    "request_failed",
    "http_error",
    "no_usage_reported",
    "unexpected",
  ] as const)(
    "preserves %s, uncertainty and replay protection",
    async (reason) => {
      const consume = vi.fn(async () => {
        throw new CodexResetError(reason, "provider error");
      });
      const providerPlans = reporter();
      const redeem = createCodexResetCoordinator({ consume, providerPlans });
      const result = await redeem(key);
      const possiblyConsumed = !["not_signed_in", "login_expired"].includes(
        reason
      );
      expect(result.error).toEqual({
        reason,
        message: "provider error",
        possiblyConsumed,
      });
      expect(providerPlans.invalidate).toHaveBeenCalledTimes(
        reason === "not_signed_in" ? 0 : 1
      );
      expect(result.usage).toEqual(report);
      await redeem(key);
      expect(consume).toHaveBeenCalledOnce();
    }
  );

  it.each(["unavailable", "missing"])(
    "keeps a resolved %s Codex refresh failure separate from successful redemption",
    async (kind) => {
      const providerPlans = reporter();
      providerPlans.mockResolvedValue(
        kind === "missing"
          ? { ...report, providers: [] }
          : ({
              ...report,
              providers: [
                {
                  ...report.providers[0],
                  unavailableReason: "Login expired; local report only.",
                },
              ],
            } as typeof report)
      );
      const result = await createCodexResetCoordinator({
        consume: async () => ok,
        providerPlans,
      })(key);
      expect(result.outcome).toEqual(ok);
      expect(result.error).toBeNull();
      expect(result.refreshError).toBe(
        kind === "missing"
          ? "Refreshed usage did not include Codex."
          : "Login expired; local report only."
      );
    }
  );

  it("handles unexpected throws conservatively and keeps refresh errors separate", async () => {
    const providerPlans = reporter();
    providerPlans.mockRejectedValue(new Error("refresh offline"));
    const redeem = createCodexResetCoordinator({
      consume: async () => {
        throw new Error("secret");
      },
      providerPlans,
    });
    const result = await redeem(key);
    expect(result.error).toMatchObject({
      reason: "unexpected",
      possiblyConsumed: true,
    });
    expect(result.error?.message).not.toContain("secret");
    expect(result.refreshError).toBe("refresh offline");
    expect(providerPlans.invalidate).toHaveBeenCalledOnce();
    const success = await createCodexResetCoordinator({
      consume: async () => ok,
      providerPlans,
    })(key);
    expect(success.outcome).toEqual(ok);
    expect(success.error).toBeNull();
    expect(success.refreshError).toBe("refresh offline");
  });

  it("keeps the same provider request UUID across retention expiry and process restart", async () => {
    let now = 0;
    const consume = vi.fn(async () => ok);
    const deps = { consume, providerPlans: reporter(), now: () => now };
    const redeem = createCodexResetCoordinator(deps);
    await redeem(key);
    now += 600_001;
    await redeem(key);
    await createCodexResetCoordinator(deps)(key);
    expect(consume.mock.calls).toEqual([[key], [key], [key]]);
  });

  it.each(["nothing_to_reset", "no_credit", "not_signed_in", "login_expired"])(
    "does not retain legacy UI definitive no-spend %s",
    async (code) => {
      const consume = vi.fn(async () => {
        if (code === "not_signed_in" || code === "login_expired")
          throw new CodexResetError(code, code);
        return { ...ok, code };
      });
      const redeem = createCodexResetCoordinator({
        consume,
        providerPlans: reporter(),
      });
      await redeem();
      await redeem();
      expect(consume).toHaveBeenCalledTimes(2);
    }
  );

  it("retains successful and uncertain legacy UI calls", async () => {
    for (const consume of [
      vi.fn(async () => ok),
      vi.fn(async () => {
        throw new Error("lost response");
      }),
    ]) {
      const redeem = createCodexResetCoordinator({
        consume,
        providerPlans: reporter(),
      });
      await redeem();
      await redeem();
      expect(consume).toHaveBeenCalledOnce();
    }
  });

  it("rejects capacity overflow without evicting protected results", async () => {
    const consume = vi.fn(async () => ok);
    const redeem = createCodexResetCoordinator({
      consume,
      providerPlans: reporter(),
    });
    for (let i = 0; i < 1024; i++) await redeem(String(i));
    expect((await redeem("overflow")).error?.reason).toBe(
      "idempotency_capacity"
    );
    await redeem("0");
    expect(consume).toHaveBeenCalledTimes(1024);
  });
});

describe("runner usage coordinator", () => {
  it("retains unknown reset outcomes without re-sending or losing fresh usage", async () => {
    const call = vi.fn(async (op: string) => {
      if (op === "engine.usage") return report;
      throw new Error("fixture lost acknowledgement");
    });
    const usage = createRunnerUsage({ call } as never);
    const first = await usage.redeemCodexReset(key);
    expect(first.error).toEqual({
      reason: "unexpected",
      message:
        "Reset execution failed; whether a credit was spent is unknown. Check usage before retrying.",
      possiblyConsumed: true,
    });
    expect(first.usage).toEqual(report);
    expect(await usage.redeemCodexReset(key)).toEqual(first);
    expect(
      call.mock.calls.filter(([op]) => op === "engine.quota.reset")
    ).toHaveLength(1);
  });
  it("keeps caches and reset replay independent for each runner", async () => {
    const call = vi.fn(async (op: string) =>
      op === "engine.usage"
        ? report
        : { ...ok, credit: { id: "credit", title: "Reset", expiresAt: null } }
    );
    const first = createRunnerUsage({ call } as never);
    const second = createRunnerUsage({ call } as never);
    expect((await first.redeemCodexReset(key)).outcome?.credit).toEqual({
      id: "credit",
      title: "Reset",
      expiresAt: null,
    });
    await first.redeemCodexReset(key);
    await second.redeemCodexReset(key);
    expect(
      call.mock.calls.filter(([op]) => op === "engine.quota.reset")
    ).toHaveLength(2);
  });
});

it("a lost local-child reset acknowledgement never calls the in-process host", async () => {
  const fallback = inProcessEngines();
  const spend = vi.spyOn(fallback, "quotaReset");
  vi.spyOn(fallback, "usage").mockResolvedValue(report);
  const call = vi.fn(async () => {
    throw new RunnerCallError({
      code: "unknown_outcome",
      message: "fixture lost reply",
    });
  });
  const calls = localEngineCalls(
    () => ({ connection: { state: "ready" }, call }) as never,
    fallback
  );
  const usage = createRunnerUsage(calls);
  const result = await usage.redeemCodexReset(key);
  expect(result.error?.possiblyConsumed).toBe(true);
  await usage.redeemCodexReset(key);
  expect(
    call.mock.calls.filter(
      (args) => (args as unknown[])[0] === "engine.quota.reset"
    )
  ).toHaveLength(1);
  expect(call).toHaveBeenCalledWith(
    "engine.quota.reset",
    { engine: "codex", account: "", requestId: key },
    { wait: false }
  );
  expect(spend).not.toHaveBeenCalled();
  fallback.close();
});

it("the host port retains snapshot details and full reset outcomes with fixture transport", async () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const credit = {
    id: "fixture-credit",
    title: "Fixture reset",
    expires_at: "2027-01-01T00:00:00Z",
  };
  const fetchUsage = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          code: "future_provider_code",
          windows_reset: 2,
          credit,
        })
      )
  );
  const host = localEngineWorkload(
    {},
    {
      providerOptions: {
        now,
        env: {},
        homeDir: "/fixture",
        platform: "linux",
        read: async (file) => {
          if (file === "/fixture/.codex/auth.json")
            return JSON.stringify({
              auth_mode: "chatgpt",
              tokens: {
                access_token: "fixture-token",
                account_id: "fixture-account",
              },
            });
          if (file === "/fixture/.claude.json")
            return JSON.stringify({
              cachedUsageUtilization: {
                fetchedAtMs: now.valueOf(),
                utilization: {
                  limits: [
                    {
                      kind: "session",
                      percent: 42,
                      severity: "warning",
                      resets_at: "2026-11-24T15:00:00Z",
                    },
                  ],
                },
              },
            });
          throw new Error("fixture absent");
        },
        codexFiles: async () => [],
        fetchUsage: fetchUsage as unknown as typeof fetch,
      },
    }
  );
  try {
    const usage = await host.usage({});
    expect(usage.providers.map(({ engine }) => engine)).toEqual([
      "claude",
      "codex",
    ]);
    expect(usage.providers[0]?.windows[0]).toMatchObject({
      id: "session",
      severity: "warning",
      usedPercent: 42,
    });
    expect(
      await host.quotaReset({ engine: "codex", account: "", requestId: key })
    ).toEqual({
      code: "future_provider_code",
      windowsReset: 2,
      credit: {
        id: credit.id,
        title: credit.title,
        expiresAt: credit.expires_at,
      },
    });
    // The transport captures no ambient credentials; the fixture login is the only input.
    expect(fetchUsage).toHaveBeenCalled();
  } finally {
    host.close();
  }
});

it("the enrolled adapter sends an ambiguous reset only once", async () => {
  const callEngine = vi.fn(async (_runner: string, op: string) => {
    if (op === "engine.usage") return report;
    throw new RunnerCallError({
      code: "unknown_outcome",
      message: "fixture lost reply",
    });
  });
  const local = { call: vi.fn() };
  const usage = createRunnerUsage(
    scopedEngineCalls(local as never, { callEngine } as never, {
      kind: "runner",
      runnerId: "fixture-runner",
    })
  );
  const result = await usage.redeemCodexReset(key);
  expect(result.error?.possiblyConsumed).toBe(true);
  expect(await usage.redeemCodexReset(key)).toEqual(result);
  expect(
    callEngine.mock.calls.filter(([, op]) => op === "engine.quota.reset")
  ).toHaveLength(1);
  expect(local.call).not.toHaveBeenCalled();
});

it("retains newer good windows after a runner refresh loses its reply", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const good = {
      checkedAt: new Date().toISOString(),
      providers: [
        {
          engine: "codex",
          plan: "Pro",
          observedAt: new Date().toISOString(),
          windows: [
            { id: "primary", label: "5-hour", usedPercent: 42, resetsAt: null },
          ],
        },
      ],
    };
    let reads = 0;
    const call = vi.fn(async () => {
      if (++reads === 1) return good;
      throw new Error("fixture disconnected");
    });
    const usage = createRunnerUsage({ call } as never);
    await usage.providerPlans();
    vi.advanceTimersByTime(60_001);
    const refreshed = await usage.providerPlans();
    expect(
      refreshed.providers.find(({ engine }) => engine === "codex")
    ).toEqual({
      ...good.providers[0],
      unavailableReason: "fixture disconnected",
    });
  } finally {
    vi.useRealTimers();
  }
});

it.each(["success", "failure", "auth", "ambiguous", "transport"])(
  "shares main's process-wide spend guard across runners and releases after %s",
  async (kind) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spendA = vi.fn(async () => {
      await held;
      if (kind === "auth")
        throw new CodexResetError("not_signed_in", "fixture missing login");
      if (kind === "failure")
        throw new CodexResetError("request_failed", "fixture provider failure");
      if (kind === "ambiguous")
        throw new RunnerCallError({
          code: "unknown_outcome",
          message: "fixture lost acknowledgement",
        });
      if (kind === "transport") throw new Error("fixture transport throw");
      return ok;
    });
    const spendB = vi.fn(async () => ok);
    const runner = (spend: () => Promise<typeof ok>) =>
      createRunnerUsage({
        call: async (op: string) => (op === "engine.usage" ? report : spend()),
      } as never);
    const a = runner(spendA);
    const b = runner(spendB);
    const first = a.redeemCodexReset(key);
    try {
      expect(await b.redeemCodexReset(otherKey)).toEqual({
        outcome: null,
        error: {
          reason: "reset_in_progress",
          message:
            "Another account-shared reset is in progress. Check usage before making a new request.",
          possiblyConsumed: false,
        },
        usage: null,
        refreshError: null,
      });
      expect(spendB).not.toHaveBeenCalled();
    } finally {
      release();
    }
    const result = await first;
    if (kind === "success") expect(result.outcome).toEqual(ok);
    else expect(result.error?.possiblyConsumed).toBe(kind !== "auth");
    expect(spendA).toHaveBeenCalledOnce();
    // Same UUID on B is a different runner's replay map, but shares active exclusion.
    expect((await b.redeemCodexReset(key)).outcome).toEqual(ok);
    expect(spendB).toHaveBeenCalledOnce();
    expect(await a.redeemCodexReset(key)).toEqual(result);
    expect(spendA).toHaveBeenCalledOnce();
  }
);
