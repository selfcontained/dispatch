// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginStatus } from "@/hooks/use-plugin-status";
import { PluginUpdateSettings } from "./plugin-update-settings";

vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  api: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);
const { toast } = await import("sonner");
const toastSuccess = vi.mocked(toast.success);
const toastWarning = vi.mocked(toast.warning);

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  toastSuccess.mockReset();
  toastWarning.mockReset();
  window.localStorage.clear();
});

function statusFixture(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    agentType: "claude",
    installed: true,
    enabled: true,
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    updateAvailable: true,
    ...overrides,
  };
}

function renderWithProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const jotaiStore = createStore();
  return render(
    <QueryClientProvider client={queryClient}>
      <Provider store={jotaiStore}>
        <PluginUpdateSettings />
      </Provider>
    </QueryClientProvider>
  );
}

describe("PluginUpdateSettings", () => {
  it("renders no visible section when nothing needs an update", async () => {
    apiMock.mockResolvedValueOnce({
      statuses: [
        statusFixture({ updateAvailable: false, currentVersion: "0.2.0" }),
      ],
    });
    renderWithProviders();

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(screen.queryByText("Plugin update")).toBeNull();
  });

  it("shows the available update with both versions", async () => {
    apiMock.mockResolvedValueOnce({ statuses: [statusFixture()] });
    renderWithProviders();

    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("v0.1.0 → v0.2.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("posts the update request, clears the row, and shows a success toast", async () => {
    apiMock.mockResolvedValueOnce({ statuses: [statusFixture()] });
    apiMock.mockResolvedValueOnce({
      status: statusFixture({
        currentVersion: "0.2.0",
        updateAvailable: false,
      }),
    });
    renderWithProviders();

    fireEvent.click(await screen.findByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/plugin/update",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ agentType: "claude" }),
        })
      )
    );
    // Row disappears once the mutation resolves with updateAvailable: false.
    await waitFor(() =>
      expect(screen.queryByText("v0.1.0 → v0.2.0")).toBeNull()
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      "Dispatch plugin updated for Claude Code."
    );
  });

  it("warns instead of celebrating when the update ran but is still available", async () => {
    apiMock.mockResolvedValueOnce({ statuses: [statusFixture()] });
    apiMock.mockResolvedValueOnce({
      status: statusFixture(), // still updateAvailable: true, same versions
    });
    renderWithProviders();

    fireEvent.click(await screen.findByRole("button", { name: "Update" }));

    await waitFor(() => expect(toastWarning).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    // The row is still there — this isn't a silent no-op from the user's
    // point of view even though the click did trigger real commands.
    expect(screen.getByText("v0.1.0 → v0.2.0")).toBeTruthy();
  });

  it("dismisses the row, announces it, without clearing it for a future version", async () => {
    apiMock.mockResolvedValueOnce({ statuses: [statusFixture()] });
    renderWithProviders();

    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss Claude Code update" })
    );

    expect(screen.queryByText("v0.1.0 → v0.2.0")).toBeNull();
    expect(
      window.localStorage.getItem("dispatch:dismissedPluginUpdate:claude:0.2.0")
    ).toBe("true");
    // Announced via the persistent live region rather than left silent —
    // the row itself is gone, so nothing else confirms the click landed.
    expect(screen.getByText("Claude Code update dismissed.")).toBeTruthy();
  });

  it("hides the section header once its only actionable row is dismissed", async () => {
    apiMock.mockResolvedValueOnce({ statuses: [statusFixture()] });
    renderWithProviders();

    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss Claude Code update" })
    );

    // Regression check: the section header/description must not be left
    // standing over zero rows.
    expect(screen.queryByText("Plugin update")).toBeNull();
  });

  it("shows the row again once the update key changes even if an older version was dismissed", async () => {
    window.localStorage.setItem(
      "dispatch:dismissedPluginUpdate:claude:0.2.0",
      "true"
    );
    apiMock.mockResolvedValueOnce({
      statuses: [
        statusFixture({ currentVersion: "0.2.0", latestVersion: "0.3.0" }),
      ],
    });
    renderWithProviders();

    expect(await screen.findByText("v0.2.0 → v0.3.0")).toBeTruthy();
  });
});
