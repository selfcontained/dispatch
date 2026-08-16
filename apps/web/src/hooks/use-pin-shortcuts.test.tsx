// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRunPinShortcut } from "./use-pin-shortcuts";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { api } = await import("@/lib/api");
const { toast } = await import("sonner");
const apiMock = vi.mocked(api);
const successMock = vi.mocked(toast.success);
const errorMock = vi.mocked(toast.error);

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  apiMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  // restoreAllMocks only restores vi.spyOn spies, not module-factory vi.fn()s,
  // so reset these explicitly — otherwise call history leaks between tests.
  apiMock.mockReset();
  successMock.mockReset();
  errorMock.mockReset();
});

/**
 * Firing a shortcut is a write into a live agent session: the server resolves
 * the prompt from the pin ID and types it into the terminal. The E2E suite
 * proves the button reaches this endpoint once; what is only checkable here is
 * the request the hook builds and which toast each outcome produces.
 */
describe("useRunPinShortcut", () => {
  it("posts to the inject-pin endpoint for the given agent and pin", async () => {
    const { result } = renderHook(() => useRunPinShortcut(), { wrapper });

    act(() => {
      result.current.mutate({ agentId: "agt_abc", pinId: "pin_xyz" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/agents/agt_abc/terminal/inject-pin/pin_xyz",
      { method: "POST" }
    );
  });

  it("names the shortcut in the success toast so stacked toasts stay distinct", async () => {
    const { result } = renderHook(() => useRunPinShortcut(), { wrapper });

    act(() => {
      result.current.mutate({
        agentId: "agt_abc",
        pinId: "pin_xyz",
        label: "Rebuild",
      });
    });

    await waitFor(() => expect(successMock).toHaveBeenCalledTimes(1));
    expect(successMock).toHaveBeenCalledWith('Sent "Rebuild" to agent');
  });

  it("falls back to a generic success toast when the pin has no label", async () => {
    const { result } = renderHook(() => useRunPinShortcut(), { wrapper });

    act(() => {
      result.current.mutate({ agentId: "agt_abc", pinId: "pin_xyz" });
    });

    await waitFor(() => expect(successMock).toHaveBeenCalledTimes(1));
    expect(successMock).toHaveBeenCalledWith("Sent to agent");
  });

  it("surfaces the server's message when the request fails", async () => {
    apiMock.mockRejectedValue(new Error("Agent has no active session"));
    const { result } = renderHook(() => useRunPinShortcut(), { wrapper });

    act(() => {
      result.current.mutate({
        agentId: "agt_abc",
        pinId: "pin_xyz",
        label: "Rebuild",
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(errorMock).toHaveBeenCalledWith("Agent has no active session");
  });

  it("falls back to generic copy when the rejection is not an Error", async () => {
    // api() rejects with an Error on every HTTP path, but a network-layer
    // throw or a future caller need not — and a bare string would render as
    // "undefined" in the toast if the message were read off it blindly.
    apiMock.mockRejectedValue("boom");
    const { result } = renderHook(() => useRunPinShortcut(), { wrapper });

    act(() => {
      result.current.mutate({ agentId: "agt_abc", pinId: "pin_xyz" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(errorMock).toHaveBeenCalledWith("Failed to send shortcut");
  });
});
