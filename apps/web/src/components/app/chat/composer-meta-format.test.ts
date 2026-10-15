import type { AgentConfigOption, AgentUsageResponse } from "@dispatch/shared";
import { describe, expect, it } from "vitest";

import {
  choiceName,
  contextPercent,
  formatCost,
  formatCredits,
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

describe("contextPercent", () => {
  it("rounds, caps at 100, and is null before any report", () => {
    const usage = (used: number, size: number) =>
      ({ context: { used, size } }) as AgentUsageResponse;
    expect(contextPercent(usage(84_000, 200_000))).toBe(42);
    expect(contextPercent(usage(300, 200))).toBe(100);
    expect(contextPercent({ context: null } as AgentUsageResponse)).toBeNull();
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

describe("formatCredits", () => {
  it("separates thousands, and names unlimited and unknown balances", () => {
    expect(formatCredits({ balance: 12500, unlimited: false })).toBe("12,500");
    expect(formatCredits({ balance: 3.456, unlimited: false })).toBe("3.46");
    expect(formatCredits({ balance: null, unlimited: true })).toBe("Unlimited");
    expect(formatCredits({ balance: null, unlimited: false })).toBe("—");
    expect(formatCredits(undefined)).toBe("—");
  });
});
