// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import {
  MemoryRouter,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "@/components/app/types";
import { lastAgentIdAtomFamily, selectedProjectIdAtom } from "@/lib/store";
import { useProjectScope } from "./use-projects";
import { useAgents } from "./use-agents";
import { useAgentSelectionMemory } from "./use-agent-selection-memory";
import { useSectionNavigate } from "./use-section-navigate";
import { useAgentActions } from "./use-agent-actions";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  localStorage.clear();
});
const agents = [
  { id: "a1", projectId: "pa", status: "stopped" },
  { id: "a2", projectId: "pa", status: "running" },
  { id: "b1", projectId: "pb", status: "running" },
  { id: "archiving", projectId: "pa", status: "archiving" },
].map((agent) => ({ ...agent, createdAt: "2026-01-01" })) as Agent[];
function mount(
  path = "/agents/a1?project=pa",
  savedProject: string | null = null
) {
  const store = createStore();
  store.set(selectedProjectIdAtom, savedProject);
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  clients.push(client);
  client.setQueryData(["projects"], [{ id: "pa" }, { id: "pb" }]);
  client.setQueryData(["agents"], agents);
  const setMobileLeftOpen = vi.fn();
  const view = renderHook(
    () => {
      const location = useLocation();
      const rawNavigate = useNavigate();
      const routeAgentId = useMatch("/agents/:agentId/*")?.params.agentId;
      const { projectId } = useProjectScope();
      const { agents, agentsLoaded, validatedSelectedAgentId } = useAgents(
        true,
        routeAgentId ?? null,
        projectId
      );
      useAgentSelectionMemory({
        projectId,
        agents,
        agentsLoaded: agentsLoaded && location.pathname.startsWith("/agents"),
        selectedAgentId: validatedSelectedAgentId,
      });
      const section = useSectionNavigate({ isMobile: true, setMobileLeftOpen });
      const { closeAgentAndClearSelection: close } = useAgentActions({
        routeAgentId,
        setExpandedAgentId: vi.fn(),
        setCreateOpen: vi.fn(),
        setRequestedCreateType: vi.fn(),
        setLastUsedAgentType: vi.fn(),
        refreshFiles: vi.fn(),
      });
      return {
        location,
        rawNavigate,
        section,
        close,
        selected: validatedSelectedAgentId,
      };
    },
    {
      wrapper: ({ children }) => (
        <Provider store={store}>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
          </QueryClientProvider>
        </Provider>
      ),
    }
  );
  return { ...view, store, client, setMobileLeftOpen };
}

it("restores only from section navigation, to plain chat, with mobile sheet closed", async () => {
  const { result, store, setMobileLeftOpen } = mount(
    "/agents/a1/files?project=pa&file=x&thread=t#message"
  );
  expect(store.get(lastAgentIdAtomFamily("pa"))).toBe("a1");
  act(() => result.current.section("tasks"));
  expect(result.current.location.pathname).toBe("/tasks");
  act(() => result.current.section("agents"));
  await waitFor(() =>
    expect(result.current.location.pathname).toBe("/agents/a1")
  );
  expect(result.current.location.search).toBe("?project=pa");
  expect(result.current.location.hash).toBe("");
  expect(setMobileLeftOpen).toHaveBeenLastCalledWith(false);
  act(() => result.current.rawNavigate("/agents?project=pa"));
  expect(result.current.selected).toBeNull();
  expect(result.current.location.pathname).toBe("/agents");
  act(() => result.current.rawNavigate(-1));
  expect(result.current.location.pathname).toBe("/agents/a1");
  act(() => result.current.rawNavigate(1));
  expect(result.current.location.pathname).toBe("/agents");
});

it("keeps A, B, and All memories independent and explicit URL scope wins over saved scope", async () => {
  const { result, store } = mount(undefined, "pb");
  expect(result.current.selected).toBe("a1");
  act(() => result.current.rawNavigate("/agents/b1?project=pb"));
  act(() => result.current.rawNavigate("/agents/a2?project="));
  expect(store.get(lastAgentIdAtomFamily("pa"))).toBe("a1");
  expect(store.get(lastAgentIdAtomFamily("pb"))).toBe("b1");
  expect(store.get(lastAgentIdAtomFamily(null))).toBe("a2");
  for (const [scope, id] of [
    ["pa", "a1"],
    ["pb", "b1"],
    ["", "a2"],
  ]) {
    act(() => result.current.rawNavigate(`/tasks?project=${scope}`));
    act(() => result.current.section("agents"));
    await waitFor(() => expect(result.current.selected).toBe(id));
  }
});

it("never renders or remembers a foreign agent while scope changes", () => {
  const { result, store } = mount();
  store.set(lastAgentIdAtomFamily("pb"), "b1");
  act(() => result.current.rawNavigate("/agents/a1?project=pb"));
  expect(result.current.selected).toBeNull();
  expect(store.get(lastAgentIdAtomFamily("pb"))).toBe("b1");
  expect(store.get(lastAgentIdAtomFamily("pa"))).toBe("a1");
});

it("explicit close clears only the active scope, and later section taps stay empty", () => {
  const { result, store } = mount();
  store.set(lastAgentIdAtomFamily("pb"), "b1");
  act(() => result.current.close());
  expect(store.get(lastAgentIdAtomFamily("pa"))).toBeNull();
  expect(store.get(lastAgentIdAtomFamily("pb"))).toBe("b1");
  act(() => result.current.section("tasks"));
  act(() => result.current.section("agents"));
  expect(result.current.location.pathname).toBe("/agents");
  expect(result.current.selected).toBeNull();
});

it.each(["missing", "b1", "archiving"])(
  "clears invalid remembered %s instead of opening it",
  async (id) => {
    const { result, store } = mount("/tasks?project=pa");
    act(() => store.set(lastAgentIdAtomFamily("pa"), id));
    act(() => result.current.section("agents"));
    await waitFor(() =>
      expect(result.current.location.pathname).toBe("/agents")
    );
    expect(store.get(lastAgentIdAtomFamily("pa"))).toBeNull();
  }
);

it("clears memory when the selected agent disappears from the live list", async () => {
  const { result, store, client } = mount();
  act(() =>
    client.setQueryData(
      ["agents"],
      agents.filter((a) => a.id !== "a1")
    )
  );
  await waitFor(() => expect(result.current.selected).toBeNull());
  expect(store.get(lastAgentIdAtomFamily("pa"))).toBeNull();
});

it("a different explicit URL replaces memory, including on mount", () => {
  const { result, store } = mount("/agents/a2/changes?project=pa");
  expect(result.current.selected).toBe("a2");
  expect(store.get(lastAgentIdAtomFamily("pa"))).toBe("a2");
  expect(localStorage.getItem("dispatch:lastAgentId:project:pa")).toBe('"a2"');
});

it.each([123, {}, [], "", "   "])(
  "rejects malformed persisted memory %j",
  (value) => {
    const scope = `shape-${JSON.stringify(value)}`;
    localStorage.setItem(
      `dispatch:lastAgentId:project:${scope}`,
      JSON.stringify(value)
    );
    expect(createStore().get(lastAgentIdAtomFamily(scope))).toBeNull();
  }
);

it("reads persisted memory without selecting on a bare route", async () => {
  const scope = "persisted";
  localStorage.setItem(`dispatch:lastAgentId:project:${scope}`, '"a1"');
  expect(createStore().get(lastAgentIdAtomFamily(scope))).toBe("a1");
  const { result, store } = mount("/agents?project=pa");
  act(() => store.set(lastAgentIdAtomFamily("pa"), "a1"));
  expect(result.current.location.pathname).toBe("/agents");
  expect(result.current.selected).toBeNull();
});

it("an explicit valid URL replaces stale memory in the same commit", () => {
  const { result, store } = mount("/tasks?project=pa");
  act(() => store.set(lastAgentIdAtomFamily("pa"), "missing"));
  act(() => result.current.rawNavigate("/agents/a2?project=pa"));
  expect(store.get(lastAgentIdAtomFamily("pa"))).toBe("a2");
});

it("a scope switch carrying a valid URL preserves the target scope memory", async () => {
  const { result, store } = mount();
  act(() => store.set(lastAgentIdAtomFamily(null), "a2"));
  act(() =>
    result.current.rawNavigate("/agents/a1?project=", {
      state: { dispatchProjectSwitch: true },
    })
  );
  expect(result.current.selected).toBe("a1");
  expect(store.get(lastAgentIdAtomFamily(null))).toBe("a2");
  act(() => result.current.section("settings"));
  act(() => store.set(selectedProjectIdAtom, null));
  act(() => result.current.section("agents"));
  await waitFor(() => expect(result.current.selected).toBe("a2"));
});

it.each(["later section", "history/scope navigation"])(
  "pending restoration cannot override %s",
  async (action) => {
    const { result, store, client } = mount("/tasks?project=pa");
    act(() => store.set(lastAgentIdAtomFamily("pa"), "a1"));
    let release!: (agents: Agent[]) => void;
    vi.spyOn(client, "ensureQueryData").mockImplementationOnce(
      () =>
        new Promise<Agent[]>((resolve) => {
          release = resolve;
        }) as never
    );
    act(() => result.current.section("agents"));
    act(() => {
      if (action === "later section") result.current.section("settings");
      else result.current.rawNavigate("/tasks?project=pb");
    });
    await act(async () => {
      release(agents);
    });
    expect(result.current.location.pathname).toBe(
      action === "later section" ? "/settings" : "/tasks"
    );
    expect(result.current.selected).toBeNull();
  }
);

it("an explicit selection after a scope switch records normally", () => {
  const { result, store } = mount();
  act(() =>
    result.current.rawNavigate("/agents/a1?project=", {
      state: { dispatchProjectSwitch: true },
    })
  );
  expect(store.get(lastAgentIdAtomFamily(null))).toBeNull();
  act(() => result.current.rawNavigate("/agents/b1?project="));
  expect(store.get(lastAgentIdAtomFamily(null))).toBe("b1");
});
