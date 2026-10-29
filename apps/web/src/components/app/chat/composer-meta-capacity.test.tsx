// @vitest-environment jsdom
import type {
  AgentUsageResponse,
  PlanWindow,
  ProviderPlan,
} from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);
const { ComposerMeta } = await import("./composer-meta");
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

function mount(
  windows: PlanWindow[],
  context: AgentUsageResponse["context"] = { used: 120_000, size: 200_000 }
) {
  const providers: ProviderPlan[] = (["codex", "claude"] as const).map(
    (engine) => ({
      engine,
      plan: "Pro",
      observedAt: new Date().toISOString(),
      windows,
      ...(engine === "codex"
        ? { limitResets: { available: 1, applicable: 1 } }
        : {}),
    })
  );
  const usage: AgentUsageResponse = {
    context,
    session: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      total: 120,
    },
    sessionCost: { amount: 1.23, currency: "USD" },
    byModel: [],
  };
  apiMock.mockImplementation(async (url) => {
    if (url === "/api/v1/usage/plans")
      return { checkedAt: new Date().toISOString(), providers };
    if (url.endsWith("/usage")) return usage;
    if (url.endsWith("/config")) return { running: false, options: [] };
    return { models: {} };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["usage-plans"], {
    checkedAt: new Date().toISOString(),
    providers,
  });
  render(
    <QueryClientProvider client={client}>
      <ComposerMeta
        agentId="fixture"
        agent={{ id: "fixture", type: "codex" } as Agent}
        active
        liveUsage={null}
        turnKey="idle"
      />
    </QueryClientProvider>
  );
}

function assertBar(
  container: HTMLElement,
  name: string,
  left: number,
  tone?: string
) {
  const bar = within(container).getByRole("progressbar", {
    name: `${name} capacity left`,
  });
  expect(bar.getAttribute("aria-valuenow")).toBe(String(left));
  expect(bar.getAttribute("aria-valuetext")).toBe(`${left}% left`);
  expect(bar.getAttribute("title")).toBe(`${left}% left`);
  expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${left}%`);
  if (tone) expect(bar.firstElementChild!.className).toContain(tone);
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  localStorage.clear();
});

describe("capacity presentation", () => {
  it("uses remaining label and exact fill across both providers and reset summary without consuming", async () => {
    mount([
      { id: "weekly", label: "Weekly", usedPercent: 60, resetsAt: null },
      { id: "full", label: "Full", usedPercent: 0, resetsAt: null },
      { id: "empty", label: "Empty", usedPercent: 100, resetsAt: null },
    ]);
    const chip = await screen.findByRole("button", {
      name: "Context: 40% left",
    });
    expect(chip.title).toBe("Context: 40% left");
    expect(chip.querySelector(".composer-usage-full")!.textContent).toBe(
      "40% left · context"
    );
    expect(chip.querySelector(".composer-usage-short")!.textContent).toBe(
      "40% left"
    );
    fireEvent.click(chip);
    for (const engine of ["codex", "claude"]) {
      const card = await screen.findByTestId(`usage-plan-${engine}`);
      assertBar(card, "Weekly", 40, "bg-status-working");
      assertBar(card, "Full", 100);
      assertBar(card, "Empty", 0, "bg-destructive");
      expect(within(card).getByText("40% left")).toBeTruthy();
    }
    assertBar(screen.getByTestId("usage-agent-card"), "Context", 40);
    expect(screen.getByTestId("usage-context").textContent).toBe(
      "120.0K / 200.0K (40% left)"
    );
    expect(screen.getByTestId("usage-session-tokens").textContent).toBe(
      "120 tokens"
    );
    expect(screen.getByTestId("usage-session-cost").textContent).toBe("$1.23");
    fireEvent.click(screen.getByTestId("usage-codex-reset"));
    const dialog = screen.getByRole("dialog", {
      name: "Use a Codex limit reset?",
    });
    assertBar(dialog, "Weekly", 40);
    assertBar(dialog, "Empty", 0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      apiMock.mock.calls.some(([, options]) => options?.method === "POST")
    ).toBe(false);
  });

  it.each([
    [0, 100, "bg-status-working"],
    [100, 0, "bg-destructive"],
    [69.6, 30, "bg-status-waiting"],
    [89.6, 10, "bg-destructive"],
  ] as const)(
    "keeps context warning behavior at %s used",
    async (used, left, tone) => {
      mount([], { used, size: 100 });
      const chip = await screen.findByRole("button", {
        name: `Context: ${left}% left`,
      });
      fireEvent.click(chip);
      assertBar(screen.getByTestId("usage-agent-card"), "Context", left, tone);
    }
  );

  it("preserves raw used thresholds, provider severity, rounding, and unknowns", async () => {
    const cases = [
      ["Below warning", 69.6, 30, "bg-status-working", undefined],
      ["Warning", 70, 30, "bg-status-waiting", undefined],
      ["Below danger", 89.6, 10, "bg-status-waiting", undefined],
      ["Danger", 90, 10, "bg-destructive", undefined],
      ["Provider normal", 99, 1, "bg-status-working", "normal"],
      ["Provider warning", 0, 100, "bg-status-waiting", "warning"],
      ["Provider critical", 0, 100, "bg-destructive", "critical"],
      ["Rounded empty", 99.6, 0, "bg-destructive", undefined],
    ] as const;
    mount(
      [
        ...cases.map(([label, usedPercent, , , severity]) => ({
          id: label,
          label,
          usedPercent,
          resetsAt: null,
          severity,
        })),
        { id: "unknown", label: "Unknown", usedPercent: NaN, resetsAt: null },
      ],
      { used: 1, size: 0 }
    );
    fireEvent.click(await screen.findByTestId("composer-usage-chip"));
    const card = await screen.findByTestId("usage-plan-codex");
    for (const [label, , left, tone] of cases)
      assertBar(card, label, left, tone);
    const unknown = within(card).getByRole("progressbar", {
      name: "Unknown capacity left",
    });
    expect(unknown.hasAttribute("aria-valuenow")).toBe(false);
    expect(unknown.childElementCount).toBe(0);
    expect(unknown.getAttribute("aria-valuetext")).toBe("not reported yet");
    expect(
      screen.getByTestId("composer-usage-chip").getAttribute("aria-label")
    ).toBe("Usage");
    expect((await screen.findByTestId("usage-context")).textContent).toBe(
      "not reported yet"
    );
  });
});
