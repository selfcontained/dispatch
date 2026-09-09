// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDispatchHarnessEnabled } from "@/hooks/use-dispatch-harness-enabled";
import { dispatchHarnessEnabledHintAtom } from "@/lib/store";

import { DispatchHarnessSettings } from "./dispatch-harness-settings";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

/** Reads the flag the way routing and the type pickers do. */
function FlagProbe(): JSX.Element {
  const { enabled } = useDispatchHarnessEnabled();
  return <span data-testid="flag">{enabled ? "on" : "off"}</span>;
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DispatchHarnessSettings />
      <FlagProbe />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  getDefaultStore().set(dispatchHarnessEnabledHintAtom, null);
  apiMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("DispatchHarnessSettings", () => {
  it("says what turning it off does to agents already running", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId("dispatch-harness-toggle")).not.toBeNull()
    );
    expect(screen.getByText("Dispatch Harness (beta)")).not.toBeNull();
    expect(
      screen.getByText(
        "Turning this off stops new dispatch agents from being created and leaves the ones already running alone."
      )
    ).not.toBeNull();
  });

  // One cache: the card is a write-through, not a second copy of the value.
  it("writes through the same query the flag reads", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("flag").textContent).toBe("off")
    );

    apiMock.mockResolvedValue({ enabled: true });
    fireEvent.click(screen.getByTestId("dispatch-harness-toggle"));

    await waitFor(() =>
      expect(screen.getByTestId("flag").textContent).toBe("on")
    );
    const post = apiMock.mock.calls.find(
      (call) => (call[1] as { method?: string } | undefined)?.method === "POST"
    )!;
    expect(post[0]).toBe("/api/v1/app/settings/dispatch-harness");
    expect(JSON.parse((post[1] as { body: string }).body)).toEqual({
      enabled: true,
    });
  });

  it("shows the error line when the write fails", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("flag").textContent).toBe("off")
    );

    apiMock.mockRejectedValue(new Error("server said no"));
    fireEvent.click(screen.getByTestId("dispatch-harness-toggle"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("server said no")
    );
  });
});
