import type { AgentConfigOption, AgentUsageResponse } from "@dispatch/shared";
import { describe, expect, it } from "vitest";

import {
  choiceName,
  contextPercent,
  formatCost,
  pickableOptions,
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
