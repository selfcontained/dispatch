// @vitest-environment jsdom
import type { ProviderPlansResponse } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

const stored: ProviderPlansResponse = {
  checkedAt: "2026-09-24T09:00:00Z",
  providers: [
    {
      engine: "codex",
      plan: "Pro",
      observedAt: "2026-09-24T09:00:00Z",
      source: "local",
      windows: [{ id: "5h", label: "5-hour", usedPercent: 40, resetsAt: null }],
    },
  ],
};

// The persisted atom reads storage when the hooks' module loads, so seed it
// first.
window.localStorage.setItem("dispatch:usage-plans", JSON.stringify(stored));
const { useProviderPlans } = await import("./use-agent-usage");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("useProviderPlans", () => {
  it("opens on the last stored answer, then stores the fresh one", async () => {
    const fresh = { ...stored, checkedAt: "2026-09-24T12:00:00Z" };
    apiMock.mockResolvedValue(fresh);
    const { result, rerender } = renderHook(
      ({ enabled }) => useProviderPlans(enabled),
      { wrapper, initialProps: { enabled: false } }
    );
    expect(result.current.data).toEqual(stored);
    expect(apiMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toEqual(fresh));
    expect(apiMock).toHaveBeenCalledWith("/api/v1/usage/plans");
    expect(
      JSON.parse(window.localStorage.getItem("dispatch:usage-plans")!)
    ).toEqual(fresh);
  });

  it("keeps the last answer on screen when the refetch fails", async () => {
    apiMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useProviderPlans(true), { wrapper });
    await waitFor(() => expect(result.current.error?.message).toBe("offline"));
    expect(result.current.data?.providers[0]?.engine).toBe("codex");
  });
});
