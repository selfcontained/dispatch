// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import type { Runner } from "@/hooks/use-runners";
import { api } from "@/lib/api";
import { RunnerSettings } from "./runner-settings";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("./runner-github-account", () => ({
  RunnerGitHubAccount: ({ runner }: { runner: Runner }) => (
    <p>GitHub for {runner.name}</p>
  ),
}));

const online: Runner = {
  id: "build",
  name: "Build machine",
  status: "online",
  workspaces: [],
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

function renderSettings(entry = "/settings/runners") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <RunnerSettings />
        <SearchValue />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

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
      return { command: null, tag: null };
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
    within(dialog).getByText(/signed runner installer is not available/)
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
    "curl -fsSL https://example.test/install.sh -o /tmp/install.sh \\\n  && sudo bash /tmp/install.sh install";
  const connect = "sudo dispatch-runner connect https://dispatch.example";
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/runners") return { runners: [] };
    if (path === "/api/v1/runners/connect") return { requests: [] };
    if (path === "/api/v1/runners/installer")
      return { command: install, tag: "v1.2.3" };
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
