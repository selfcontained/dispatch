// @vitest-environment jsdom
import { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { useAgentActions } from "./use-agent-actions";

afterEach(cleanup);

it("keeps the live agent state when startup beats the create response", async () => {
  const client = new QueryClient();
  const creating = { id: "agent-race", status: "creating" } as Agent;
  const running = { ...creating, status: "running", setupPhase: null } as Agent;
  const { result } = renderHook(
    () =>
      useAgentActions({
        routeAgentId: undefined,
        setExpandedAgentId: vi.fn(),
        setCreateOpen: vi.fn(),
        setRequestedCreateType: vi.fn(),
        setLastUsedAgentType: vi.fn(),
        refreshFiles: vi.fn(),
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <MemoryRouter>{children}</MemoryRouter>
        </QueryClientProvider>
      ),
    }
  );
  // SSE startup completed while POST /agents was still on the wire.
  client.setQueryData(["agents"], [running]);
  await act(() => result.current.handleAgentCreated(creating, "codex"));
  expect(client.getQueryData<Agent[]>(["agents"])?.[0]).toEqual(running);
});
