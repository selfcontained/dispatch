// @vitest-environment jsdom
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { engineScopeKey } from "@dispatch/runner-protocol/engine-management";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Runner } from "@/hooks/use-runners";
import { api } from "@/lib/api";
import { noteServerVersion } from "@/lib/version";
import { PageChromeContext } from "@/components/ui/page-header";
import { RunnerSettings } from "./runner-settings";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  ApiError: class extends Error {},
}));
vi.mock("./runner-github-account", () => ({
  RunnerGitHubAccount: ({ runner }: { runner: Runner }) => (
    <p>GitHub for {runner.name}</p>
  ),
}));

const online: Runner = {
  id: "build",
  name: "Build machine",
  status: "online",

  engineManagement: true,
};
const offline: Runner = {
  ...online,
  id: "spare",
  name: "Spare machine",
  status: "offline",
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function SearchValue() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderSettings(
  entry = "/settings/runners",
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <RunnerSettings />
        <SearchValue />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

it("keeps the shell's way back to the settings menu on the list and a runner", async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/runners") return { runners: [online] };
    if (path === "/api/v1/runners/connect") return { requests: [] };
    if (path.startsWith("/api/v1/engine-management/inventory"))
      return { entries: [] };
    throw new Error(`Unexpected endpoint ${path}`);
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PageChromeContext.Provider
        value={{ leading: <button type="button">Open sidebar</button> }}
      >
        <MemoryRouter initialEntries={["/settings/runners"]}>
          <RunnerSettings />
        </MemoryRouter>
      </PageChromeContext.Provider>
    </QueryClientProvider>
  );
  expect(
    screen.getByRole("heading", { level: 1, name: "Runners" })
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open sidebar" })).toBeTruthy();
  fireEvent.click(await screen.findByTestId("runner-select-build"));
  await screen.findByRole("heading", { name: "Build machine" });
  expect(screen.getByRole("button", { name: "Open sidebar" })).toBeTruthy();
});

it("scopes details and confirmation to the selected runner and records a revocation", async () => {
  let revoked = false;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/runners") {
      return {
        runners: [revoked ? { ...online, status: "revoked" } : online, offline],
      };
    }
    if (path === "/api/v1/runners/connect") return { requests: [] };
    if (path.startsWith("/api/v1/engine-management/inventory"))
      return { entries: [] };
    if (path === "/api/runners/build") {
      revoked = true;
      return {};
    }
    throw new Error(`Unexpected endpoint ${path}`);
  });

  renderSettings("/settings/runners?source=test");
  await screen.findByTestId("runner-select-build");
  expect(screen.queryByTestId("runner-detail")).toBeNull();

  fireEvent.click(screen.getByTestId("runner-select-spare"));
  expect(await screen.findByText("GitHub for Spare machine")).toBeTruthy();
  expect(screen.queryByTestId("runner-list")).toBeNull();
  expect(screen.queryByText("GitHub for Build machine")).toBeNull();
  expect(screen.queryByTestId("runner-engines")).toBeNull();
  expect(screen.getByTestId("search").textContent).toBe(
    "?source=test&runner=spare"
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to runners" }));
  const selectBuild = await screen.findByTestId("runner-select-build");
  expect(document.activeElement).toBe(
    screen.getByTestId("runner-select-spare")
  );
  expect(screen.getByTestId("search").textContent).toBe("?source=test");

  fireEvent.click(selectBuild);
  const title = await screen.findByRole("heading", { name: "Build machine" });
  expect(document.activeElement).toBe(title);
  expect(await screen.findByTestId("runner-engines")).toBeTruthy();
  const actions = screen.getByTestId("runner-actions-build");

  async function openRevoke() {
    fireEvent.keyDown(actions, { key: "Enter" });
    fireEvent.click(await screen.findByTestId("runner-revoke-build"));
    return screen.findByRole("alertdialog", {
      name: "Revoke access for Build machine?",
    });
  }

  const confirmation = await openRevoke();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(api).not.toHaveBeenCalledWith("/api/runners/build", expect.anything());
  await waitFor(() => expect(document.activeElement).toBe(actions));

  await openRevoke();
  fireEvent.click(screen.getByTestId("runner-revoke-confirm-build"));
  await screen.findByText("Access revoked for Build machine.");
  expect(screen.queryByTestId("runner-detail")).toBeNull();
  expect(screen.getByTestId("search").textContent).toBe("?source=test");
  expect(screen.queryByTestId("runner-select-build")).toBeNull();
  expect(api).toHaveBeenCalledWith("/api/runners/build", { method: "DELETE" });
  const history = screen.getByText("Revoked runners (1)").closest("details");
  expect(history?.open).toBe(false);
  expect(within(history!).getByTestId("runner-build").textContent).toContain(
    "Revoked"
  );
});

it("leaves pairing approvals actionable after closing the Add runner dialog", async () => {
  let approved = false;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/runners") return { runners: approved ? [online] : [] };
    if (path === "/api/v1/runners/connect") {
      return { requests: approved ? [] : [{ id: "request-deadbeef" }] };
    }
    if (path === "/api/v1/runners/installer")
      return { command: null, revision: null, version: "1.2.3", source: null };
    if (path === "/api/v1/runners/connect-command") {
      return {
        command: "sudo dispatch-runner connect https://dispatch.example",
      };
    }
    if (path === "/api/v1/runners/connect/request-deadbeef/approve") {
      approved = true;
      return {};
    }
    throw new Error(`Unexpected endpoint ${path}`);
  });

  renderSettings();
  const review = await screen.findByRole("button", {
    name: "Review request deadbeef",
  });
  expect(screen.queryByTestId("runner-approval")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Add runner" }));
  const dialog = screen.getByRole("dialog", { name: "Add runner" });
  await within(dialog).findByTestId("runner-connect-command");
  expect(
    within(dialog).getByText(/does not serve a runner installer/)
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(review);
  const request = screen.getByRole("dialog", {
    name: "Review request deadbeef",
  });
  const approval = within(request).getByTestId("runner-approval");
  const submit = within(approval).getByRole("button", {
    name: "Approve runner",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(within(approval).getByLabelText("Runner name"), {
    target: { value: " Build machine " },
  });
  fireEvent.change(within(approval).getByLabelText("Pairing code"), {
    target: { value: " CODE " },
  });
  fireEvent.click(submit);
  await screen.findByTestId("runner-select-build");
  await waitFor(() =>
    expect(screen.queryByTestId("runner-approval")).toBeNull()
  );
  expect(api).toHaveBeenCalledWith(
    "/api/v1/runners/connect/request-deadbeef/approve",
    {
      method: "POST",
      body: JSON.stringify({ name: "Build machine", code: "CODE" }),
    }
  );
});

it("copies the exact install and connect commands and closes from the footer", async () => {
  const install =
    "curl -fsSk --pinnedpubkey 'sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' https://dispatch.example:7443/install | sudo bash";
  const connect = "sudo dispatch-runner connect https://dispatch.example";
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/runners") return { runners: [] };
    if (path === "/api/v1/runners/connect") return { requests: [] };
    if (path === "/api/v1/runners/installer")
      return {
        command: install,
        revision: "abc1234def56",
        version: "1.2.3",
        source: "release",
      };
    if (path === "/api/v1/runners/connect-command") return { command: connect };
    throw new Error(`Unexpected endpoint ${path}`);
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  try {
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Add runner" }));
    const dialog = screen.getByRole("dialog", { name: "Add runner" });
    expect(
      (await within(dialog).findByTestId("runner-install-command")).textContent
    ).toBe(install);
    await within(dialog).findByTestId("runner-connect-command");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy install command" })
    );
    await within(dialog).findByRole("button", {
      name: "Copied install command",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy connect command" })
    );
    await within(dialog).findByRole("button", {
      name: "Copied connect command",
    });
    expect(writeText.mock.calls).toEqual([[install], [connect]]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

it("shows reported activity only for online runners with fresh health", async () => {
  const freshTime = new Date().toISOString();
  const staleTime = new Date(Date.now() - 91_000).toISOString();
  const health = {
    version: "1.2.3",
    sessions: 3,
    working: 2,
    cpuPercent: 10,
    memoryUsed: 256,
    memoryTotal: 1024,
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/v1/runners/connect") return { requests: [] };
    if (path !== "/api/runners") throw new Error(`Unexpected endpoint ${path}`);
    return {
      runners: [
        { ...online, health, healthReceivedAt: freshTime },
        { ...offline, health, healthReceivedAt: freshTime },
        { ...online, id: "stale", health, healthReceivedAt: staleTime },
        { ...online, id: "legacy" },
        {
          ...online,
          id: "idle",
          health: { ...health, sessions: 0, working: 0 },
          healthReceivedAt: freshTime,
        },
      ],
    };
  });

  renderSettings();
  const roster = await screen.findByTestId("runner-list");
  expect(
    within(roster).getByTestId("runner-select-build").textContent
  ).toContain("Online · 2 working");
  expect(
    within(roster).getByTestId("runner-select-idle").textContent
  ).toContain("Online · 0 sessions");
  for (const id of ["spare", "stale", "legacy"]) {
    expect(
      within(roster).getByTestId(`runner-select-${id}`).textContent
    ).not.toContain(" · ");
  }
});

it("refreshes the update attempt and reported build on a visible runner detail and on refocus", async () => {
  const at = new Date().toISOString();
  let health: Runner["health"] = {
    version: "1.2.3",
    revision: "1234567",
    sessions: 1,
    working: 1,
    cpuPercent: 10,
    memoryUsed: 256,
    memoryTotal: 1024,
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path !== "/api/runners") throw new Error(`Unexpected endpoint ${path}`);
    return {
      runners: [
        { ...online, engineManagement: false, health, healthReceivedAt: at },
      ],
    };
  });

  vi.useFakeTimers();
  try {
    renderSettings("/settings/runners?runner=build");
    await act(() => vi.advanceTimersByTimeAsync(10));
    const panel = within(screen.getByTestId("runner-health"));
    expect(panel.getByText("1234567")).toBeTruthy();

    health = {
      ...health,
      maintenanceFailure: { exitCode: 75, step: "stop", at },
    };
    await act(() => vi.advanceTimersByTimeAsync(5_010));
    expect(panel.getByText(/Deferred while an agent was working/)).toBeTruthy();

    health = { ...health, revision: "7654321", maintenanceFailure: undefined };
    await act(() => vi.advanceTimersByTimeAsync(5_010));
    expect(panel.getByText("7654321")).toBeTruthy();
    expect(panel.queryByText("Last update attempt")).toBeNull();

    act(() => focusManager.setFocused(false));
    health = { ...health, revision: "abcdef0" };
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(panel.getByText("7654321")).toBeTruthy();

    act(() => focusManager.setFocused(true));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(panel.getByText("abcdef0")).toBeTruthy();
  } finally {
    cleanup();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  }
});

it("opens an opaque runner ID from a deep link and preserves unrelated query values", async () => {
  const id = "runner/?opaque&remote";
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/runners") return { runners: [{ ...offline, id }] };
    if (path === "/api/v1/runners/connect") return { requests: [] };
    throw new Error(`Unexpected endpoint ${path}`);
  });

  renderSettings(
    `/settings/runners?runner=${encodeURIComponent(id)}&source=notice&source=pairing`
  );
  expect(await screen.findByText("GitHub for Spare machine")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to runners" }));
  expect(await screen.findByTestId(`runner-select-${id}`)).toBeTruthy();
  expect(screen.getByTestId("search").textContent).toBe(
    "?source=notice&source=pairing"
  );
});

it("clears the displayed revoked runners and shows the empty roster", async () => {
  let cleared = false;
  const history = [
    { ...online, status: "revoked" },
    { ...offline, status: "revoked" },
  ];
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/runners") return { runners: cleared ? [] : history };
    if (path === "/api/v1/runners/connect") return { requests: [] };
    if (path === "/api/runners/revoked/clear") {
      cleared = true;
      return { cleared: 2 };
    }
    throw new Error(`Unexpected endpoint ${path}`);
  });

  renderSettings();
  const summary = await screen.findByText("Revoked runners (2)");
  const details = summary.closest("details")!;
  details.open = true;
  fireEvent.click(
    within(details).getByRole("button", { name: "Clear revoked runners" })
  );
  await screen.findByText("Revoked runners cleared.");
  expect(api).toHaveBeenCalledWith("/api/runners/revoked/clear", {
    method: "POST",
    body: JSON.stringify({ ids: ["build", "spare"] }),
  });
  expect(screen.getByText("No connected runners.")).toBeTruthy();
  expect(screen.queryByText("Revoked runners (2)")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Clear revoked runners" })
  ).toBeNull();
});

it("polls faster while a selected runner updates and offers the action in its detail", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let reads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path !== "/api/runners") return {} as never;
      reads++;
      return {
        runners: [
          reads === 1
            ? {
                ...online,
                engineManagement: false,
                update: { attempt: { id: "a", phase: "staging" } },
              }
            : {
                ...online,
                engineManagement: false,
                update: { available: { version: "1.8.0", action: "update" } },
              },
        ],
      } as never;
    });
    renderSettings("/settings/runners?runner=build");
    expect(await screen.findByText("Runner update in progress")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(await screen.findByTestId("runner-update-build")).toBeTruthy();
    const readsAfterUpdate = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(reads).toBe(readsAfterUpdate);
  } finally {
    vi.useRealTimers();
  }
});

describe("the wanted build in Health", () => {
  const health = {
    version: "1.7.28",
    revision: "aaaaaaa",
    sessions: 0,
    working: 0,
    cpuPercent: 1,
    memoryUsed: 1,
    memoryTotal: 2,
  };
  const shown: Runner = {
    ...online,
    engineManagement: undefined,
    health,
    healthReceivedAt: "2026-01-15T08:42:17.123Z",
  };
  const old = { version: "1.7.28", revision: "aaaaaaa", command: null };
  const next = { version: "1.7.29", revision: "bbbbbbb", command: null };

  async function openHealth() {
    const world = { runner: shown, installer: old };
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/runners") return { runners: [world.runner] } as never;
      if (path === "/api/v1/runners/installer") return world.installer as never;
      return {} as never;
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderSettings("/settings/runners?runner=build", client);
    const details =
      await screen.findByTestId<HTMLDetailsElement>("runner-health");
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await within(details).findByText("Wanted build");
    world.installer = next;
    const changes = (runner: Partial<Runner>) =>
      act(async () => {
        world.runner = { ...shown, ...runner };
        await client.refetchQueries({ queryKey: ["runners"] });
      });
    const showsNext = () =>
      waitFor(() => expect(details.textContent).toContain("bbbbbbb"));
    return { world, details, changes, showsNext };
  }

  it.each<[string, Partial<Runner>]>([
    [
      "an update becomes available",
      { update: { available: { version: "1.7.29", action: "update" } } },
    ],
    [
      "an update starts",
      { update: { attempt: { id: "a", phase: "staging" } } },
    ],
    ["an update ends", { update: { result: { state: "rolled_back" } } }],
    [
      "the runner reports another version",
      { health: { ...health, version: "1.7.29" } },
    ],
    [
      "the runner reports another revision",
      { health: { ...health, revision: "ccccccc" } },
    ],
  ])("is read again when %s", async (_case, runner) => {
    const { changes, showsNext } = await openHealth();
    await changes(runner);
    await showsNext();
  });

  it("agrees with the update that just finished", async () => {
    const { changes, details, showsNext } = await openHealth();
    await changes({
      health: { ...health, version: "1.7.29", revision: "bbbbbbb" },
      update: { result: { state: "updated", version: "1.7.29" } },
    });
    await showsNext();
    await waitFor(() =>
      expect(details.textContent).toContain("Wanted build1.7.29")
    );
    expect(details.textContent).toContain("Up to date");
    expect(details.textContent).not.toContain("Runner is newer");
  });

  it("is read again each time Dispatch's version changes", async () => {
    const { world, details, showsNext } = await openHealth();
    act(() => noteServerVersion("1.7.29"));
    await showsNext();
    world.installer = { ...next, version: "1.7.30", revision: "ddddddd" };
    act(() => noteServerVersion("1.7.30"));
    await waitFor(() => expect(details.textContent).toContain("ddddddd"));
    // Every response repeats the header; only a change is a signal.
    const reads = vi.mocked(api).mock.calls.length;
    await act(async () => noteServerVersion("1.7.30"));
    expect(vi.mocked(api).mock.calls).toHaveLength(reads);
  });

  it("is read again when a detail opens on a cached build", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["runner-installer"], old);
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/runners") return { runners: [shown] } as never;
      if (path === "/api/v1/runners/installer") return next as never;
      return {} as never;
    });
    renderSettings("/settings/runners?runner=build", client);
    const details =
      await screen.findByTestId<HTMLDetailsElement>("runner-health");
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(details.textContent).toContain("bbbbbbb"));
  });
});

it("reads engines, plugins and usage again when an update ends", async () => {
  let runner: Runner = { ...online, engineManagement: undefined };
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/api/runners" ? { runners: [runner] } : ({} as never)
  );
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  renderSettings("/settings/runners?runner=build", client);
  await screen.findByTestId("runner-detail");
  runner = { ...runner, update: { attempt: { id: "a", phase: "confirming" } } };
  await act(() => client.refetchQueries({ queryKey: ["runners"] }));
  await screen.findByText("Runner update in progress");
  const keys = [
    ["runner-engines", engineScopeKey({ kind: "runner", runnerId: "build" })],
    ["runner-plugin", "build"],
    ["runner-provider-usage", "build"],
  ];
  for (const queryKey of keys)
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey });
  runner = { ...runner, update: { result: { state: "updated" } } };
  await act(() => client.refetchQueries({ queryKey: ["runners"] }));
  await waitFor(() => {
    for (const queryKey of keys)
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
  });
});
