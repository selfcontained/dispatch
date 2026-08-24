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

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

afterEach(() => {
  cleanup();
  apiMock.mockReset();
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
  it("renders nothing when nothing needs an update", async () => {
    apiMock.mockResolvedValueOnce({
      statuses: [
        statusFixture({ updateAvailable: false, currentVersion: "0.2.0" }),
      ],
    });
    const { container } = renderWithProviders();

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("shows the available update with both versions", async () => {
    apiMock.mockResolvedValueOnce({ statuses: [statusFixture()] });
    renderWithProviders();

    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("v0.1.0 → v0.2.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("posts the update request and clears the row on success", async () => {
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
  });

  it("dismisses the row without clearing it for a future version", async () => {
    apiMock.mockResolvedValueOnce({ statuses: [statusFixture()] });
    renderWithProviders();

    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss Claude Code update" })
    );

    expect(screen.queryByText("v0.1.0 → v0.2.0")).toBeNull();
    expect(
      window.localStorage.getItem("dispatch:dismissedPluginUpdate:claude:0.2.0")
    ).toBe("true");
  });

  it("hides the whole section once its only actionable row is dismissed", async () => {
    apiMock.mockResolvedValueOnce({ statuses: [statusFixture()] });
    const { container } = renderWithProviders();

    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss Claude Code update" })
    );

    // Regression check: the section header/description must not be left
    // standing over zero rows.
    expect(screen.queryByText("Plugin update")).toBeNull();
    expect(container.firstChild).toBeNull();
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
