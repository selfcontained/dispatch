// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { selectedProjectIdAtom } from "@/lib/store";
import {
  useProjectNavigate,
  useProjectScope,
  useProjectSelection,
  type Project,
} from "./use-projects";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const projects = [
  { id: "one", name: "One" },
  { id: "two", name: "Two" },
] as Project[];
const clients: QueryClient[] = [];

function renderProject(
  path = "/agents",
  savedId: string | null = null,
  loaded = true
) {
  const store = createStore();
  store.set(selectedProjectIdAtom, savedId);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  if (loaded) client.setQueryData(["projects"], projects);

  // The switcher owns synchronization and is absent on settings/activity.
  function SwitcherOwner() {
    useProjectSelection();
    return null;
  }
  function Layout({ children }: { children: React.ReactNode }) {
    const { pathname } = useLocation();
    return (
      <>
        {/^\/(agents|automations)(\/|$)/.test(pathname) && <SwitcherOwner />}
        {children}
      </>
    );
  }
  const view = renderHook(
    () => ({
      ...useProjectScope(),
      navigate: useProjectNavigate(),
      rawNavigate: useNavigate(),
      location: useLocation(),
    }),
    {
      wrapper: ({ children }) => (
        <Provider store={store}>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[path]}>
              <Layout>{children}</Layout>
            </MemoryRouter>
          </QueryClientProvider>
        </Provider>
      ),
    }
  );
  return { ...view, client, store };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue(projects);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

it("restores a bare dashboard URL and keeps its query, hash, and navigation state", () => {
  const { result } = renderProject("/agents?thread=abc#message", "one");
  expect(result.current.projectId).toBe("one");
  expect(result.current.location.search).toBe("?thread=abc&project=one");
  expect(result.current.location.hash).toBe("#message");
  act(() =>
    result.current.navigate(
      { pathname: "/automations/jobs", search: "?tab=active", hash: "#job" },
      { state: { source: "sidebar" } }
    )
  );
  expect(result.current.location.search).toBe("?tab=active&project=one");
  expect(result.current.location.hash).toBe("#job");
  expect(result.current.location.state).toEqual({ source: "sidebar" });
});

it.each(["/settings/appearance", "/activity/metrics", "/automations/brains"])(
  "remembers selection through %s and back to a bare dashboard",
  (detour) => {
    const { result, store } = renderProject("/agents?project=one");
    act(() => result.current.navigate(detour));
    expect(result.current.location.search).toBe("");
    expect(store.get(selectedProjectIdAtom)).toBe("one");
    act(() => result.current.navigate("/automations"));
    expect(result.current.location.search).toBe("?project=one");
    expect(result.current.projectId).toBe("one");
  }
);

it("lets explicit links override persistence, including explicit All projects", () => {
  const { result, store } = renderProject("/agents?project=two", "one");
  expect(result.current.projectId).toBe("two");
  expect(store.get(selectedProjectIdAtom)).toBe("two");
  act(() => result.current.navigate("/automations?project="));
  expect(result.current.projectId).toBeNull();
  expect(store.get(selectedProjectIdAtom)).toBeNull();
  expect(localStorage.getItem("dispatch:selectedProjectId")).toBe("null");
  act(() => result.current.rawNavigate("/agents"));
  expect(result.current.projectId).toBeNull();
});

it("preserves project and All projects choices through back/forward, including an initially bare All entry", () => {
  const { result, store } = renderProject();
  expect(result.current.location.search).toBe("");
  act(() => result.current.rawNavigate("/agents?project=one"));
  act(() => result.current.rawNavigate("/agents?project=two"));
  act(() => result.current.rawNavigate("/agents?project="));
  act(() => result.current.rawNavigate(-1));
  expect(result.current.projectId).toBe("two");
  act(() => result.current.rawNavigate(-1));
  expect(result.current.projectId).toBe("one");
  act(() => result.current.rawNavigate(-1));
  expect(result.current.projectId).toBeNull();
  expect(store.get(selectedProjectIdAtom)).toBeNull();
  act(() => result.current.rawNavigate(1));
  expect(result.current.projectId).toBe("one");
});

it("does not clear a saved ID while the projects request is pending or failed", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((_resolve, rejectRequest) => {
        reject = rejectRequest;
      })
  );
  const { result, store } = renderProject("/agents", "one", false);
  expect(result.current.projectId).toBe("one");
  expect(store.get(selectedProjectIdAtom)).toBe("one");
  await act(async () => reject(new Error("offline")));
  expect(result.current.projectId).toBe("one");
  expect(store.get(selectedProjectIdAtom)).toBe("one");
  expect(localStorage.getItem("dispatch:selectedProjectId")).toBe('"one"');
});

it.each(["/agents", "/agents?project=deleted"])(
  "recovers from an invalid or deleted ID at %s",
  (path) => {
    const { result, store } = renderProject(path, "deleted");
    expect(result.current.projectId).toBeNull();
    expect(store.get(selectedProjectIdAtom)).toBeNull();
    expect(
      new URLSearchParams(result.current.location.search).get("project")
    ).toBe(path.includes("project=") ? "" : null);
    act(() => result.current.navigate("/automations"));
    expect(result.current.projectId).toBeNull();
  }
);

it("waits for a successful refetch before clearing a deleted selection", async () => {
  let resolve!: (data: Project[]) => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const { result, client, store } = renderProject("/agents?project=one", "one");
  act(() => {
    void client.invalidateQueries({ queryKey: ["projects"] });
  });
  expect(result.current.projectId).toBe("one");
  expect(store.get(selectedProjectIdAtom)).toBe("one");
  await act(async () => resolve([projects[1]!]));
  await waitFor(() => expect(result.current.projectId).toBeNull());
  expect(store.get(selectedProjectIdAtom)).toBeNull();
  expect(result.current.location.search).toBe("?project=");
});

it("restores a persisted project or All choice in a fresh module", async () => {
  const { result, unmount } = renderProject("/agents?project=two");
  expect(localStorage.getItem("dispatch:selectedProjectId")).toBe('"two"');
  vi.resetModules();
  const reloaded = await import("@/lib/store");
  expect(createStore().get(reloaded.selectedProjectIdAtom)).toBe("two");
  act(() => result.current.rawNavigate("/agents?project="));
  unmount();
  vi.resetModules();
  const reloadedAll = await import("@/lib/store");
  expect(createStore().get(reloadedAll.selectedProjectIdAtom)).toBeNull();
});
