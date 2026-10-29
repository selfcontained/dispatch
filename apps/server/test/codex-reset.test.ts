import { describe, expect, it, vi } from "vitest";
import { createCodexResetCoordinator } from "../src/agents/codex-reset.js";
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
