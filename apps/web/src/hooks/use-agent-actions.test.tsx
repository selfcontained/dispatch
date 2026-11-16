// @vitest-environment jsdom
import { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  type Location,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { useAgentActions } from "./use-agent-actions";
import { useAgentsViewRouting } from "./use-agents-view-routing";

vi.mock("@/lib/api", () => ({ api: vi.fn(async () => []) }));

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

it("stays in Agents when you archive the agent you are viewing", async () => {
  const client = new QueryClient();
  const seen: { location: Location | null } = { location: null };
  let live: string | null = "agt_me";
  let actions: ReturnType<typeof useAgentActions> | null = null;

  function Page() {
    const { agentId } = useParams();
    seen.location = useLocation();
    actions = useAgentActions({
      routeAgentId: agentId,
      setExpandedAgentId: vi.fn(),
      setCreateOpen: vi.fn(),
      setRequestedCreateType: vi.fn(),
      setLastUsedAgentType: vi.fn(),
      refreshFiles: vi.fn(),
    });
    useAgentsViewRouting({
      routeAgentId: agentId,
      agentsLoaded: true,
      validatedSelectedAgentId: agentId && agentId === live ? agentId : null,
    });
    return null;
  }

  const { rerender } = renderHook(() => null, {
    wrapper: () => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/agents/agt_me"]}>
          <Routes>
            <Route path="/agents" element={<Page />} />
            <Route path="/agents/:agentId/*" element={<Page />} />
            <Route path="*" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
  expect(seen.location?.pathname).toBe("/agents/agt_me");

  await act(() => actions!.deleteAgent({ id: "agt_me" } as Agent));
  live = null;
  rerender();

  expect(seen.location?.pathname).toBe("/agents");
  expect(seen.location?.state).toEqual({ dispatchViewedAgentLeft: true });
});
