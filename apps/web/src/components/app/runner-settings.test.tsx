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

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerSettings />
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
    if (path === "/api/runners/build") {
      revoked = true;
      return {};
    }
    throw new Error(`Unexpected endpoint ${path}`);
  });

  renderSettings();
  const selectBuild = await screen.findByTestId("runner-select-build");
  expect(screen.queryByTestId("runner-detail")).toBeNull();

  fireEvent.click(screen.getByTestId("runner-select-spare"));
  expect(screen.getByText("GitHub for Spare machine")).toBeTruthy();
  expect(screen.queryByText("GitHub for Build machine")).toBeNull();
  expect(screen.queryByRole("button", { name: "Manage engines" })).toBeNull();

  fireEvent.click(selectBuild);
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Build machine" })
  );
  expect(screen.getByRole("button", { name: "Manage engines" })).toBeTruthy();
  const revoke = screen.getByTestId("runner-revoke-build");
  fireEvent.click(revoke);
  const confirmation = screen.getByRole("alertdialog", {
    name: "Revoke access for Build machine?",
  });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(api).not.toHaveBeenCalledWith("/api/runners/build", expect.anything());

  fireEvent.click(revoke);
  fireEvent.click(screen.getByTestId("runner-revoke-confirm-build"));
  await screen.findByText("Access revoked for Build machine.");
  expect(screen.queryByTestId("runner-detail")).toBeNull();
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
  const approval = await screen.findByTestId("runner-approval");
  const submit = within(approval).getByRole("button", {
    name: "Approve runner",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Add runner" }));
  const dialog = screen.getByRole("dialog", { name: "Add runner" });
  await within(dialog).findByTestId("runner-connect-command");
  expect(
    within(dialog).getByText(/signed runner installer is not available/)
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();

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
