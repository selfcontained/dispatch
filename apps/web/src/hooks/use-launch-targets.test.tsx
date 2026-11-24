// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import {
  useLaunchTargets,
  useLaunchTargetData,
  type LaunchTarget,
  type TargetData,
} from "./use-launch-targets";
import { useAgentModelCatalog } from "./use-agent-model-catalog";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const targets: LaunchTarget[] = [
  {
    key: "opaque-a",
    name: "First fixture",
    status: "online",
    launchFields: {},
    dataUrl: "/fixture/first",
    location: { kind: "folder" },
    selectionFields: { runner: "controller-fixture" },
  },
  {
    key: "opaque-b",
    name: "Second fixture",
    launchFields: { runner: "runner-fixture" },
    dataUrl: "/fixture/second",
    status: "offline",
    location: { kind: "project", projects: [] },
    selectionFields: { runner: "runner-fixture" },
  },
];
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  request.mockReset();
});
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return {
    client,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
it("keeps targets opaque and permits selecting an offline target", async () => {
  request.mockImplementation(async (url) => {
    if (url === "/api/v1/launch-targets") return { targets };
    if (url.startsWith("/fixture/"))
      return { catalog: { models: {} }, agentTypes: ["codex"] };
    throw Error(url);
  });
  const { Wrapper } = wrapper();
  const { result } = renderHook(
    () => {
      const selection = useLaunchTargets();
      const data = useLaunchTargetData(selection.target, {
        directory: "/repo",
        agentType: "codex",
      });
      return { selection, data };
    },
    { wrapper: Wrapper }
  );
  await waitFor(() => expect(result.current.data.isSuccess).toBe(true));
  expect(result.current.selection.fields).toEqual({});
  act(() => result.current.selection.choose("opaque-b"));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "/fixture/second?directory=%2Frepo&agentType=codex"
    )
  );
  expect(result.current.selection.fields).toEqual({ runner: "runner-fixture" });
  expect(result.current.selection.selectionReady).toBe(true);
});
it("does not turn an inherited saved target into an explicit target on save", async () => {
  request.mockImplementation(async (url) =>
    url === "/api/v1/launch-targets"
      ? { targets }
      : { targetKey: "opaque-b", inherited: true }
  );
  const { Wrapper } = wrapper();
  const { result } = renderHook(
    () => useLaunchTargets({ kind: "trigger", id: "column" }),
    { wrapper: Wrapper }
  );
  await waitFor(() => expect(result.current.target?.key).toBe("opaque-b"));
  expect(result.current.changed).toBe(false);
  expect(result.current.fields).toEqual({});
  act(() => result.current.choose("opaque-a"));
  expect(result.current.fields).toEqual({ runner: "controller-fixture" });
});
it("uses provided catalog fields without leaking a cached controller catalog", () => {
  const { client, Wrapper } = wrapper();
  client.setQueryData(["agent-models"], {
    models: { codex: [{ id: "controller", label: "Controller" }] },
  });
  const { result } = renderHook(
    () =>
      useAgentModelCatalog("codex", true, {
        data: { models: { codex: [{ id: "target", label: "Target" }] } },
        loading: false,
      }),
    { wrapper: Wrapper }
  );
  expect(result.current.options.map((o) => o.id)).toEqual(["target"]);
  expect(request).not.toHaveBeenCalled();
});
it("retains a saved model while the target catalog has not loaded", () => {
  const { Wrapper } = wrapper();
  const { result } = renderHook(
    () => useAgentModelCatalog("codex", true, { loading: true }),
    { wrapper: Wrapper }
  );
  expect(result.current.loaded).toBe(false);
  expect(result.current.normalizeModel("saved")).toBe("saved");
  expect(request).not.toHaveBeenCalled();
});

it("does not carry personas or preferences from the previous folder while the next read loads", async () => {
  const next = Promise.withResolvers<TargetData>();
  request.mockImplementation(async (url) =>
    url.includes("directory=%2Fnext")
      ? next.promise
      : {
          catalog: { models: { claude: [{ id: "m", label: "Model" }] } },
          directory: "/first",
          personasUrl: "/first-personas",
          defaults: { preferenceKey: "/first", baseBranch: "main" },
        }
  );
  const { Wrapper } = wrapper();
  const { result, rerender } = renderHook(
    ({ directory }) =>
      useLaunchTargetData(targets[0]!, {
        directory,
        agentType: "claude",
      }),
    { wrapper: Wrapper, initialProps: { directory: "/first" } }
  );
  await waitFor(() =>
    expect(result.current.data?.personasUrl).toBe("/first-personas")
  );
  rerender({ directory: "/next" });
  expect(result.current.data).toBeUndefined();
  await act(async () =>
    next.resolve({
      agentTypes: ["claude"],
      engineOptions: [],
      branchesUrl: "/branches",
      catalog: { models: {} },
      directory: "/next",
      personasUrl: "/next-personas",
      defaults: {
        preferenceKey: "/next",
        baseBranch: "main",
        launchFields: {},
      },
    })
  );
  await waitFor(() =>
    expect(result.current.data?.personasUrl).toBe("/next-personas")
  );
});
