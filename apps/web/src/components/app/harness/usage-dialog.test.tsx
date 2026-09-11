// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type {
  HarnessProviderUsageReport,
  HarnessUsageReport,
} from "@dispatch/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageDialog, formatTokens, formatUsd } from "./usage-dialog";

const report: HarnessUsageReport = {
  generatedAt: "2026-09-07T12:00:00.000Z",
  monthStart: "2026-09-01T00:00:00.000Z",
  engines: [
    {
      id: "claude",
      label: "Claude Code",
      publishesPlan: true,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: true,
      loginCommand: "claude /login",
      tokens: 1_200_000,
      costUsd: 14.5,
      budgetUsd: 20,
      agents: [
        { agentId: "a", name: "Docs bot", tokens: 1_200_000, costUsd: 14.5 },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      publishesPlan: true,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: false,
      loginCommand: "codex login --device-auth",
      tokens: 55_000,
      costUsd: null,
      budgetUsd: null,
      agents: [{ agentId: "b", name: "Fixer", tokens: 55_000, costUsd: null }],
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      publishesPlan: false,
      publishesModelOption: false,
      reportsUsage: false,
      reportsCost: false,
      loginCommand: "NO_BROWSER=true gemini",
      tokens: 0,
      costUsd: null,
      budgetUsd: null,
      agents: [{ agentId: "c", name: "Gem", tokens: 0, costUsd: null }],
    },
    {
      id: "opencode",
      label: "OpenCode",
      publishesPlan: false,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: true,
      loginCommand: "opencode auth login",
      tokens: 0,
      costUsd: null,
      budgetUsd: null,
      agents: [],
    },
  ],
};

const providerReport: HarnessProviderUsageReport = {
  checkedAt: "2026-09-11T00:00:00.000Z",
  providers: [
    {
      engineId: "claude",
      plan: "Team",
      observedAt: "2026-09-11T00:00:00.000Z",
      windows: [
        {
          id: "session",
          label: "5-hour",
          usedPercent: 32,
          resetsAt: null,
        },
      ],
      spend: { used: 12, limit: 50, currency: "USD" },
    },
  ],
};

vi.mock("./use-harness-usage", () => ({
  HARNESS_USAGE_QUERY_KEY: ["harness-usage"],
  useHarnessUsage: () => ({
    data: report,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  }),
}));
vi.mock("./use-harness-auth", () => ({
  HARNESS_AUTH_QUERY_KEY: ["harness-auth"],
  useHarnessAuth: () => ({
    data: {
      checkedAt: "2026-09-11T00:00:00.000Z",
      engines: [
        {
          engineId: "claude",
          kind: "subscription",
          label: "Claude team subscription",
        },
        {
          engineId: "codex",
          kind: "subscription",
          label: "ChatGPT subscription",
        },
      ],
    },
  }),
}));
vi.mock("./use-provider-usage", () => ({
  HARNESS_PROVIDER_USAGE_QUERY_KEY: ["harness-provider-usage"],
  useHarnessProviderUsage: () => ({
    data: providerReport,
    refetch: vi.fn(),
    isFetching: false,
  }),
}));

afterEach(cleanup);

function renderDialog() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <UsageDialog
        open
        onOpenChange={() => {}}
        providerId="claude"
        contextUsage={{ used: 42_000, size: 200_000, costUsd: 1.25 }}
      />
    </QueryClientProvider>
  );
}

describe("UsageDialog", () => {
  it("shows current context and the selected provider plan", () => {
    renderDialog();
    const context = screen.getByTestId("harness-context-usage");
    expect(within(context).getByText("42k of 200k · 21%")).toBeTruthy();
    const plan = screen.getByTestId("harness-provider-plan");
    expect(within(plan).getByText("Team")).toBeTruthy();
    expect(within(plan).getByText("32% used")).toBeTruthy();
    expect(within(plan).getByText("Extra usage: $12 of $50")).toBeTruthy();
  });

  it("shows one row per engine with tokens, cost where reported, and a budget bar where set", () => {
    renderDialog();
    const claude = screen.getByTestId("harness-usage-engine-claude");
    // The one agent under claude carries the same totals as the engine, so
    // both the engine summary and the agent line read "1.2M" / "$14.50".
    expect(within(claude).getAllByText("1.2M").length).toBeGreaterThan(0);
    expect(within(claude).getAllByText("$14.50").length).toBeGreaterThan(0);
    expect(
      within(claude).getByTestId("harness-usage-bar").getAttribute("data-pct")
    ).toBe("73");
    const codex = screen.getByTestId("harness-usage-engine-codex");
    expect(within(codex).getByText("ChatGPT subscription")).toBeTruthy();
    expect(within(codex).getAllByText("55k").length).toBeGreaterThan(0);
    expect(within(codex).getByText("no cost reported")).toBeTruthy();
    expect(within(codex).queryByTestId("harness-usage-bar")).toBeNull();
    const gemini = screen.getByTestId("harness-usage-engine-gemini");
    expect(within(gemini).getByText("not reported over ACP")).toBeTruthy();
    const opencode = screen.getByTestId("harness-usage-engine-opencode");
    expect(within(opencode).getByText("no agents this month")).toBeTruthy();
  });

  it("says what the bar is a fraction of", () => {
    // A bar at 73% with only the spend beside it never says 73% of what.
    renderDialog();
    expect(
      within(screen.getByTestId("harness-usage-engine-claude")).getByTestId(
        "harness-usage-budget-caption"
      ).textContent
    ).toBe("$14.50 of $20");
  });

  it("lists the agents under an engine", () => {
    renderDialog();
    expect(
      within(screen.getByTestId("harness-usage-engine-claude")).getByText(
        "Docs bot"
      )
    ).toBeTruthy();
  });
});

describe("formatters", () => {
  it("format tokens and dollars", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(55_000)).toBe("55k");
    expect(formatUsd(14.5)).toBe("$14.50");
    expect(formatUsd(120)).toBe("$120");
  });
});
