// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { HarnessUsageResponse } from "@dispatch/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({
  data: undefined as HarnessUsageResponse | undefined,
}));
vi.mock("./use-harness-usage", () => ({
  useHarnessUsage: () => ({
    data: usage.data,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: async () => undefined,
  }),
}));

import { resetsIn, UsageDialog } from "./usage-dialog";

afterEach(cleanup);

describe("resetsIn", () => {
  it("phrases the time to the reset, and nothing for a past or unknown one", () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    expect(resetsIn("2026-09-06T12:30:00Z", now)).toBe("resets in 30m");
    expect(resetsIn("2026-09-06T15:10:00Z", now)).toBe("resets in 3h 10m");
    expect(resetsIn("2026-09-10T12:00:00Z", now)).toBe("resets in 4d");
    expect(resetsIn("2026-09-06T11:00:00Z", now)).toBeNull();
    expect(resetsIn(null, now)).toBeNull();
  });
});

describe("UsageDialog with a ChatGPT plan", () => {
  it("draws one bar per window and prices the logs as an API equivalent", () => {
    usage.data = {
      generatedAt: "2026-09-06T12:00:00Z",
      monthStart: "2026-09-01T00:00:00Z",
      providers: [
        {
          id: "openai-codex",
          label: "ChatGPT (Codex)",
          keyEnv: null,
          hasKey: true,
          budgetUsd: null,
          subscription: {
            plan: "plus",
            windows: [
              {
                id: "primary",
                label: "5-hour",
                usedPercent: 12,
                windowSeconds: 18000,
                resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
              },
              {
                id: "secondary",
                label: "Weekly",
                usedPercent: 71,
                windowSeconds: 604800,
                resetsAt: null,
              },
            ],
            credits: null,
            limitReached: false,
          },
          logged: {
            since: "2026-09-01T00:00:00Z",
            tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
            usd: 3.5,
            models: [
              {
                model: "gpt-5.6-sol",
                tokens: {
                  input: 1000,
                  output: 200,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                usd: 3.5,
              },
            ],
          },
        },
      ],
    };
    render(<UsageDialog open onOpenChange={() => undefined} />);
    const row = screen.getByTestId("harness-usage-provider");
    expect(row.getAttribute("data-provider")).toBe("openai-codex");
    expect(screen.getByText("ChatGPT sign-in · plus")).toBeTruthy();
    // The headline figure is the fuller window, not a dollar amount.
    expect(screen.getByTestId("harness-usage-spend").textContent).toBe(
      "71% used"
    );
    const bars = screen.getAllByTestId("harness-usage-bar");
    expect(bars.map((b) => b.getAttribute("data-pct"))).toEqual(["12", "71"]);
    expect(screen.getByText(/resets in 1h 0m|resets in 59m/)).toBeTruthy();
    expect(screen.getByTestId("harness-usage-api-equivalent").textContent).toBe(
      "≈ $3.50 at API rates"
    );
    expect(screen.getByText("Included in the plan")).toBeTruthy();
  });

  it("says when the plan's limit is hit", () => {
    usage.data = {
      generatedAt: "2026-09-06T12:00:00Z",
      monthStart: "2026-09-01T00:00:00Z",
      providers: [
        {
          id: "openai-codex",
          label: "ChatGPT (Codex)",
          keyEnv: null,
          hasKey: true,
          budgetUsd: null,
          subscription: {
            plan: null,
            windows: [],
            credits: { balance: null, unlimited: true },
            limitReached: true,
          },
          logged: {
            since: "2026-09-01T00:00:00Z",
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            usd: 0,
            models: [],
          },
        },
      ],
    };
    render(<UsageDialog open onOpenChange={() => undefined} />);
    expect(screen.getByTestId("harness-usage-spend").textContent).toBe(
      "limit reached"
    );
    expect(screen.getByText("Credits unlimited")).toBeTruthy();
    expect(
      screen.getByText("The plan reported no rate-limit windows.")
    ).toBeTruthy();
  });
});
