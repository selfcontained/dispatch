import type { AgentConfigOption, AgentUsageResponse } from "@dispatch/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  choiceName,
  contextRemainingPercent,
  remainingPercent,
  formatCost,
  formatCredits,
  formatExtraUsage,
  formatLimitResets,
  formatResetExpiry,
  formatResetExpiryDate,
  hasExpiringResets,
  resetExpiresSoon,
  pickableOptions,
  reportAge,
  resetsIn,
} from "./composer-meta-format";

const option = (
  id: string,
  category: string | null,
  currentValue = "a"
): AgentConfigOption => ({
  id,
  name: id,
  category,
  currentValue,
  choices: [{ value: "a", name: "A" }],
});

describe("pickableOptions", () => {
  it("offers the model and one effort setting, model first, never mode", () => {
    const picked = pickableOptions([
      option("mode", "mode"),
      option("reasoning_effort", null),
      option("model", "model"),
      option("thought", "thought_level"),
    ]);
    expect(picked.map((o) => o.id)).toEqual(["model", "reasoning_effort"]);
  });
});

describe("choiceName", () => {
  it("names a grouped choice with its group", () => {
    expect(
      choiceName({
        ...option("model", "model", "gpt-6-sol"),
        choices: [{ value: "gpt-6-sol", name: "6 Sol", group: "GPT" }],
      })
    ).toBe("GPT 6 Sol");
  });

  it("falls back to the raw value the engine did not list", () => {
    expect(choiceName(option("model", "model", "mystery"))).toBe("mystery");
  });
});

describe("contextRemainingPercent", () => {
  it("rounds, caps at 100, and is null before any report", () => {
    const usage = (used: number, size: number) =>
      ({ context: { used, size } }) as AgentUsageResponse;
    expect(contextRemainingPercent(usage(84_000, 200_000))).toBe(58);
    expect(contextRemainingPercent(usage(300, 200))).toBe(0);
    expect(
      contextRemainingPercent({ context: null } as AgentUsageResponse)
    ).toBeNull();
  });
});

describe("formatCost", () => {
  it("shows cents to three places under a dollar", () => {
    expect(formatCost(0.4213, "USD")).toBe("$0.421");
    expect(formatCost(12.5, "USD")).toBe("$12.50");
    expect(formatCost(3, "EUR")).toBe("3.00 EUR");
  });
});

describe("resetsIn", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  it("reads a future reset relative to now", () => {
    expect(resetsIn("2026-09-24T14:10:00Z", now)).toBe("in 2h 10m");
    expect(resetsIn("2026-09-24T11:00:00Z", now)).toBe("now");
    expect(resetsIn(null, now)).toBeNull();
  });
});

describe("reportAge", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  it("calls a report under a minute old live, unless it was read locally", () => {
    expect(reportAge("2026-09-24T11:59:30Z", "live", now)).toBe("live");
    expect(reportAge("2026-09-24T11:59:30Z", undefined, now)).toBe("live");
    expect(reportAge("2026-09-24T11:59:30Z", "local", now)).toBe(
      "as of just now"
    );
  });

  it("says how old an older report is, and where it came from", () => {
    expect(reportAge("2026-09-24T11:57:00Z", "live", now)).toBe(
      "updated 3m ago"
    );
    expect(reportAge("2026-09-24T09:00:00Z", "local", now)).toBe(
      "as of 3h ago"
    );
  });

  it("treats a timestamp ahead of the clock as now, and none as unknown", () => {
    expect(reportAge("2026-09-24T12:05:00Z", undefined, now)).toBe("live");
    expect(reportAge(null, "live", now)).toBeNull();
    expect(reportAge("not a date", "live", now)).toBeNull();
  });
});

describe("formatExtraUsage", () => {
  it("shows the spend, or that it is off and why", () => {
    expect(formatExtraUsage({ used: 0.42, limit: 100, currency: "USD" })).toBe(
      "$0.420 of $100.00"
    );
    expect(
      formatExtraUsage({
        used: 0,
        limit: 100,
        currency: "USD",
        enabled: false,
        disabledReason: "out_of_credits",
      })
    ).toBe("Off · out of credits");
    expect(
      formatExtraUsage({ used: 0, limit: 100, currency: "USD", enabled: false })
    ).toBe("Off");
    expect(formatExtraUsage(undefined)).toBe("—");
  });
});

describe("formatLimitResets", () => {
  it("counts resets, or says none were reported", () => {
    expect(formatLimitResets({ available: 3 })).toBe("3 available");
    expect(formatLimitResets(undefined)).toBe("—");
  });
});

describe("reset expiry dates", () => {
  const DateTimeFormat = Intl.DateTimeFormat;
  let timeZone = "UTC";
  beforeEach(() => {
    timeZone = "UTC";
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      (_locale, options) =>
        new DateTimeFormat("en-US", { ...options, timeZone })
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses the browser locale/timezone, omits the year, includes minutes, and omits seconds", () => {
    expect(formatResetExpiryDate("2026-10-22T21:00:57Z")).toBe(
      "Oct 22, 9:00 PM UTC"
    );
    expect(Intl.DateTimeFormat).toHaveBeenCalledWith(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  });

  it("converts the date and time to the browser timezone across midnight and DST", () => {
    timeZone = "America/Los_Angeles";
    expect(formatResetExpiryDate("2026-10-22T01:12:54Z")).toBe(
      "Oct 21, 6:12 PM PDT"
    );
    expect(formatResetExpiryDate("2026-12-22T01:12:54Z")).toBe(
      "Dec 21, 5:12 PM PST"
    );
  });

  it("lists one valid expiration per line chronologically without changing the input", () => {
    const items = [
      { expiresAt: "2026-10-29T19:12:54Z" },
      { expiresAt: "2026-10-22T21:00:57Z" },
      { expiresAt: null },
      { expiresAt: "invalid" },
    ];
    expect(formatResetExpiry({ available: 4, items })).toBe(
      "Oct 22, 9:00 PM UTC\nOct 29, 7:12 PM UTC"
    );
    expect(items[0].expiresAt).toBe("2026-10-29T19:12:54Z");
  });

  it("shows the oldest absolute expiry even when no valid item dates were reported", () => {
    expect(
      formatResetExpiry({
        available: 3,
        oldestExpiresAt: "2026-10-22T21:00:00Z",
        items: [{ expiresAt: "invalid" }],
      })
    ).toBe("oldest expires Oct 22, 9:00 PM UTC");
  });

  it("omits bare days rather than displaying an invented midnight time", () => {
    expect(
      formatResetExpiry({
        available: 2,
        items: [
          { expiresAt: "2026-10-22" },
          { expiresAt: "2026-10-29T19:12:54Z" },
        ],
      })
    ).toBe("Oct 29, 7:12 PM UTC");
    expect(
      formatResetExpiry({ available: 1, items: [{ expiresAt: "2026-10-22" }] })
    ).toBeNull();
  });

  it("does not invent dates for invalid/missing metadata or unavailable resets", () => {
    for (const expiresAt of [null, undefined, "invalid", "", "2026-10-22"]) {
      expect(formatResetExpiryDate(expiresAt)).toBeNull();
      expect(
        formatResetExpiry({ available: 3, oldestExpiresAt: expiresAt })
      ).toBeNull();
    }
    expect(
      formatResetExpiry({
        available: 0,
        oldestExpiresAt: "2026-10-22T21:00:00Z",
      })
    ).toBeNull();
    expect(
      formatResetExpiry({
        available: 0,
        items: [{ expiresAt: "2026-10-22T21:00:00Z" }],
      })
    ).toBeNull();
    expect(formatResetExpiry({ available: 3 })).toBeNull();
    expect(formatResetExpiry(undefined)).toBeNull();
  });
});

describe("formatCredits", () => {
  it("separates thousands, and names unlimited and unknown balances", () => {
    expect(formatCredits({ balance: 12500, unlimited: false })).toBe("12,500");
    expect(formatCredits({ balance: 3.456, unlimited: false })).toBe("3.46");
    expect(formatCredits({ balance: null, unlimited: true })).toBe("Unlimited");
    expect(formatCredits({ balance: null, unlimited: false })).toBe("—");
    expect(formatCredits(undefined)).toBe("—");
  });
});

describe("reset expiry reminder", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  const week = 7 * 24 * 60 * 60 * 1000;
  const iso = (offset: number) => new Date(now + offset).toISOString();

  it("includes seven days exactly, but excludes elapsed, missing and invalid dates", () => {
    expect(resetExpiresSoon(iso(1), now)).toBe(true);
    expect(resetExpiresSoon(iso(week), now)).toBe(true);
    for (const date of [
      iso(week + 1),
      iso(0),
      iso(-1),
      null,
      undefined,
      "invalid",
    ]) {
      expect(resetExpiresSoon(date, now)).toBe(false);
    }
  });

  it("requires available credits and accepts either reported expiry source", () => {
    const resets = { available: 1, applicable: 0, oldestExpiresAt: iso(week) };
    expect(hasExpiringResets(resets, now)).toBe(true);
    expect(hasExpiringResets({ ...resets, available: 0 }, now)).toBe(false);
    expect(hasExpiringResets({ ...resets, available: -1 }, now)).toBe(false);
    expect(hasExpiringResets(undefined, now)).toBe(false);
    expect(hasExpiringResets({ available: 1, applicable: 0 }, now)).toBe(false);
    expect(
      hasExpiringResets(
        {
          available: 1,
          applicable: 0,
          items: [
            { id: "a", title: "Reset", grantedAt: null, expiresAt: iso(-1) },
            { id: "b", title: "Reset", grantedAt: null, expiresAt: iso(week) },
          ],
        },
        now
      )
    ).toBe(true);
  });
});

describe("remaining capacity", () => {
  it.each([
    [0, 100],
    [60, 40],
    [100, 0],
    [-5, 100],
    [105, 0],
    [60.49, 40],
    [60.5, 40],
    [60.51, 39],
    [99.6, 0],
  ])("converts %s used to %s left", (used, left) => {
    expect(remainingPercent(used)).toBe(left);
  });
  it.each([undefined, null, NaN, Infinity, -Infinity, "60"])(
    "keeps %s unknown",
    (value) => {
      expect(remainingPercent(value)).toBeNull();
    }
  );
  it("rejects invalid context denominators and nonfinite facts", () => {
    for (const [used, size] of [
      [60, 0],
      [60, -1],
      [NaN, 100],
      [60, Infinity],
      [Infinity, 100],
    ]) {
      expect(
        contextRemainingPercent({
          context: { used, size },
        } as AgentUsageResponse)
      ).toBeNull();
    }
    expect(contextRemainingPercent(undefined)).toBeNull();
  });
});
