// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageBudgetSettings } from "./usage-budget-settings";

const state: { budgets: Record<string, number> } = { budgets: {} };
const save = vi.fn(async (budgets: Record<string, number>) => {
  state.budgets = budgets;
  return { budgets };
});
vi.mock("@/hooks/use-usage-budgets", () => ({
  useUsageBudgets: () => ({
    budgets: state.budgets,
    loaded: true,
    save,
    saving: false,
    error: null,
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  state.budgets = {};
  save.mockClear();
});

describe("UsageBudgetSettings", () => {
  it("starts empty and offers every provider, Gemini included", () => {
    render(<UsageBudgetSettings />, { wrapper });
    expect(screen.getByTestId("usage-budget-empty")).toBeTruthy();
    expect(screen.queryAllByTestId("usage-budget-row")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("usage-budget-add"));
    const names = screen
      .getAllByRole("option")
      .map((o) => o.textContent?.trim());
    expect(names).toEqual(["OpenAI", "DeepSeek", "Anthropic", "Gemini"]);
  });

  it("lists saved budgets, saves an edited amount on Enter, and removes a row", async () => {
    state.budgets = { openai: 50, google: 5 };
    render(<UsageBudgetSettings />, { wrapper });
    const rows = screen.getAllByTestId("usage-budget-row");
    expect(rows.map((r) => r.getAttribute("data-provider"))).toEqual([
      "openai",
      "google",
    ]);
    const amount = rows[0].querySelector(
      '[data-testid="usage-budget-amount"]'
    ) as HTMLInputElement;
    expect(amount.value).toBe("50");
    fireEvent.change(amount, { target: { value: "75" } });
    fireEvent.keyDown(amount, { key: "Enter" });
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({ openai: 75, google: 5 })
    );
    fireEvent.click(
      rows[1].querySelector('[data-testid="usage-budget-remove"]')!
    );
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ openai: 75 }));
    // Gemini is offered again once its row is gone.
    fireEvent.click(screen.getByTestId("usage-budget-add"));
    expect(
      screen.getAllByRole("option").map((o) => o.textContent?.trim())
    ).toEqual(["DeepSeek", "Anthropic", "Gemini"]);
  });
});

describe("UsageBudgetSettings validation", () => {
  it("keeps a new row that has no amount yet and does not save until it does", async () => {
    render(<UsageBudgetSettings />, { wrapper });
    fireEvent.click(screen.getByTestId("usage-budget-add"));
    fireEvent.click(screen.getByRole("option", { name: "Gemini" }));
    const row = screen.getByTestId("usage-budget-row");
    const amount = row.querySelector(
      '[data-testid="usage-budget-amount"]'
    ) as HTMLInputElement;
    fireEvent.blur(amount);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId("usage-budget-row")).toBeTruthy();
    expect(screen.getByTestId("usage-budget-invalid").textContent).toContain(
      "Enter an amount"
    );
    fireEvent.change(amount, { target: { value: "-5" } });
    fireEvent.blur(amount);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId("usage-budget-invalid").textContent).toContain(
      "positive"
    );
    fireEvent.change(amount, { target: { value: "12.5" } });
    fireEvent.keyDown(amount, { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenCalledWith({ google: 12.5 }));
  });
});
