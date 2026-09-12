// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHarnessCommands } from "./use-harness-commands";

const api = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => api.mockReset());

describe("useHarnessCommands", () => {
  it("maps the engine's commands to slash items, hint folded into the description", async () => {
    api.mockResolvedValue({
      commands: [
        { name: "review", description: "Review the branch", input: null },
        {
          name: "compact",
          description: "Compact the context",
          input: { hint: "what to keep" },
        },
      ],
    });
    const { result } = renderHook(() => useHarnessCommands("agt_1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/harness/commands");
    expect(result.current).toEqual([
      { name: "review", description: "Review the branch" },
      { name: "compact", description: "Compact the context · what to keep" },
    ]);
  });

  it("hands back the same list across a rerender with unchanged data", async () => {
    api.mockResolvedValue({
      commands: [{ name: "review", description: "Review", input: null }],
    });
    const { result, rerender } = renderHook(() => useHarnessCommands("agt_1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
    const first = result.current;
    rerender();
    // The composer takes this as a prop; a fresh array every render would
    // defeat every memo below it.
    expect(result.current).toBe(first);
  });

  it("asks nothing without an agent", () => {
    const { result } = renderHook(() => useHarnessCommands(null), { wrapper });
    expect(result.current).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
});
