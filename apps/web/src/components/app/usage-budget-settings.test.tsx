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
  it("starts empty and offers every engine that reports cost", () => {
    render(<UsageBudgetSettings />, { wrapper });
    expect(screen.getByTestId("usage-budget-empty")).toBeTruthy();
    expect(screen.queryAllByTestId("usage-budget-row")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("usage-budget-add"));
    // Options are compared by identity, not raw textContent: OpenCode's
    // mark is a visible "OC" glyph, which would otherwise run into the
    // label when read as plain text.
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(2);
    expect(options[0]).toBe(
      screen.getByRole("option", { name: "Claude Code" })
    );
    expect(options[1]).toBe(screen.getByRole("option", { name: "OpenCode" }));
  });

  it("lists a saved budget, adds another engine, and saves it on Enter", async () => {
    state.budgets = { claude: 20 };
    render(<UsageBudgetSettings />, { wrapper });
    const rows = screen.getAllByTestId("usage-budget-row");
    expect(rows.map((r) => r.getAttribute("data-provider"))).toEqual([
      "claude",
    ]);
    expect(rows[0].textContent).toContain("Claude Code");
    const amount = rows[0].querySelector(
      '[data-testid="usage-budget-amount"]'
    ) as HTMLInputElement;
    expect(amount.value).toBe("20");
    fireEvent.click(screen.getByTestId("usage-budget-add"));
    const remaining = screen.getAllByRole("option");
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toBe(screen.getByRole("option", { name: "OpenCode" }));
    fireEvent.click(screen.getByRole("option", { name: "OpenCode" }));
    const newRows = screen.getAllByTestId("usage-budget-row");
    expect(newRows.map((r) => r.getAttribute("data-provider"))).toEqual([
      "claude",
      "opencode",
    ]);
    const newAmount = newRows[1].querySelector(
      '[data-testid="usage-budget-amount"]'
    ) as HTMLInputElement;
    fireEvent.change(newAmount, { target: { value: "5" } });
    fireEvent.keyDown(newAmount, { key: "Enter" });
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith({ claude: 20, opencode: 5 })
    );
  });
});

describe("UsageBudgetSettings while a save is in flight", () => {
  it("keeps what was typed after the save was issued", async () => {
    state.budgets = { claude: 50 };
    let finish: (() => void) | null = null;
    save.mockImplementationOnce(
      (budgets: Record<string, number>) =>
        new Promise((resolve) => {
          finish = () => {
            state.budgets = budgets;
            resolve({ budgets });
          };
        })
    );
    render(<UsageBudgetSettings />, { wrapper });
    const amount = screen.getByTestId(
      "usage-budget-amount"
    ) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "75" } });
    fireEvent.keyDown(amount, { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenCalledWith({ claude: 75 }));
    // A newer edit while that save is still out.
    fireEvent.change(amount, { target: { value: "80" } });
    finish!();
    await waitFor(() => expect(state.budgets).toEqual({ claude: 75 }));
    // The settled save must not hand the row back to the server's 75.
    expect(amount.value).toBe("80");
    fireEvent.keyDown(amount, { key: "Enter" });
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ claude: 80 }));
  });
});

describe("UsageBudgetSettings validation", () => {
  it("keeps a new row that has no amount yet and does not save until it does", async () => {
    render(<UsageBudgetSettings />, { wrapper });
    fireEvent.click(screen.getByTestId("usage-budget-add"));
    fireEvent.click(screen.getByRole("option", { name: "OpenCode" }));
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
    await waitFor(() => expect(save).toHaveBeenCalledWith({ opencode: 12.5 }));
  });

  it("saves a removal even while another row still needs an amount", async () => {
    // The removal used to be dropped on the floor: persist() bailed because
    // the other row was invalid, nothing on screen said so, and the budget
    // came back on the next reload.
    state.budgets = { claude: 20 };
    render(<UsageBudgetSettings />, { wrapper });
    fireEvent.click(screen.getByTestId("usage-budget-add"));
    fireEvent.click(screen.getByRole("option", { name: "OpenCode" }));
    const rows = screen.getAllByTestId("usage-budget-row");
    expect(rows.map((r) => r.getAttribute("data-provider"))).toEqual([
      "claude",
      "opencode",
    ]);
    fireEvent.click(
      rows[0].querySelector(
        '[data-testid="usage-budget-remove"]'
      ) as HTMLElement
    );
    await waitFor(() => expect(save).toHaveBeenCalledWith({}));
    // The half-typed row is still on screen, and still says what it needs.
    expect(
      screen
        .getAllByTestId("usage-budget-row")
        .map((r) => r.getAttribute("data-provider"))
    ).toEqual(["opencode"]);
    expect(screen.getByTestId("usage-budget-invalid")).toBeTruthy();
  });
});
