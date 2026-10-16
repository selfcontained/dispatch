// @vitest-environment jsdom
import type { ProviderPlan } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);
const { UseResetButton } = await import("./composer-meta");

// Radix's dialog reaches for pointer APIs jsdom lacks.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const plan: ProviderPlan = {
  engine: "codex",
  plan: "Pro",
  observedAt: "2026-10-16T00:00:00Z",
  source: "live",
  windows: [{ id: "primary", label: "Weekly", usedPercent: 1, resetsAt: null }],
  credits: { balance: 62500, unlimited: false },
  limitResets: {
    available: 3,
    applicable: 0,
    oldestExpiresAt: "2026-10-22T21:00:57Z",
    items: [
      {
        id: "a",
        title: "Full reset",
        grantedAt: null,
        expiresAt: "2026-10-22T21:00:57Z",
      },
    ],
  },
};

function renderButton() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UseResetButton plan={plan} now={Date.parse("2026-10-16T00:00:00Z")} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("UseResetButton", () => {
  it("asks for confirmation again after a result is closed with the button", async () => {
    apiMock.mockResolvedValueOnce({ code: "ok", windowsReset: 1 });
    renderButton();

    fireEvent.click(screen.getByTestId("usage-codex-reset"));
    expect(screen.getByTestId("usage-codex-reset-confirm")).toBeTruthy();
    // Nothing is sent until the dialog is confirmed.
    expect(apiMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("usage-codex-reset-confirm"));
    await waitFor(() =>
      expect(
        screen.getByTestId("usage-codex-reset-outcome").textContent
      ).toMatch(/Reset applied/)
    );
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/usage/codex/resets/consume", {
      method: "POST",
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByTestId("usage-codex-reset-outcome")).toBeNull()
    );

    // Reopened: the old outcome is gone and the confirmation is offered again.
    fireEvent.click(screen.getByTestId("usage-codex-reset"));
    expect(screen.queryByTestId("usage-codex-reset-outcome")).toBeNull();
    expect(screen.getByTestId("usage-codex-reset-confirm")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed attempt when cancelled", async () => {
    apiMock.mockRejectedValueOnce(
      new Error("ChatGPT refused the reset request")
    );
    renderButton();
    fireEvent.click(screen.getByTestId("usage-codex-reset"));
    fireEvent.click(screen.getByTestId("usage-codex-reset-confirm"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(screen.getByTestId("usage-codex-reset"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
