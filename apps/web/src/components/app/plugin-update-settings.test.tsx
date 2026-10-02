// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginStatus } from "@/hooks/use-plugin-status";
import { PluginUpdateSettings } from "./plugin-update-settings";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);
afterEach(() => {
  cleanup();
  apiMock.mockReset();
});
function fixture(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    agentType: "claude",
    installed: true,
    enabled: true,
    currentVersion: "0.5.0",
    latestVersion: "0.5.0",
    updateAvailable: false,
    ...overrides,
  };
}
function setup() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <PluginUpdateSettings />
    </QueryClientProvider>
  );
}
describe("PluginUpdateSettings", () => {
  it("keeps installed versions visible when current or disabled", async () => {
    apiMock.mockResolvedValueOnce({
      statuses: [fixture(), fixture({ agentType: "codex", enabled: false })],
    });
    setup();
    expect(await screen.findByText("Up to date")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getAllByText("Installed v0.5.0")).toHaveLength(2);
  });
  it("updates a plugin and keeps the installed row", async () => {
    apiMock.mockResolvedValueOnce({
      statuses: [fixture({ currentVersion: "0.4.0", updateAvailable: true })],
    });
    apiMock.mockResolvedValueOnce({ status: fixture() });
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Update Claude Code plugin" })
    );
    expect(await screen.findByText("Installed v0.5.0")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/plugin/update",
      expect.objectContaining({ body: JSON.stringify({ agentType: "claude" }) })
    );
  });
  it("installs a missing plugin and shows the installed version", async () => {
    apiMock.mockResolvedValueOnce({
      statuses: [
        fixture({
          installed: false,
          enabled: false,
          currentVersion: null,
          latestVersion: null,
        }),
      ],
    });
    apiMock.mockResolvedValueOnce({ status: fixture() });
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Install Claude Code plugin" })
    );
    expect(await screen.findByText("Installed v0.5.0")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/plugin/install",
      expect.objectContaining({ body: JSON.stringify({ agentType: "claude" }) })
    );
  });
  it("does not offer installation when detection failed and allows a fresh check", async () => {
    apiMock.mockResolvedValueOnce({
      statuses: [
        fixture({ installed: false, detectionError: "CLI unavailable" }),
      ],
    });
    apiMock.mockResolvedValueOnce({ statuses: [fixture()] });
    setup();
    expect(await screen.findByText("Status unavailable")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Install Claude Code plugin" })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Up to date")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith("/api/v1/plugin/status?refresh=true");
  });
  it("shows installation failures in the row", async () => {
    apiMock.mockResolvedValueOnce({
      statuses: [fixture({ installed: false })],
    });
    apiMock.mockRejectedValueOnce(
      new Error("Failed to register the Dispatch marketplace.")
    );
    apiMock.mockResolvedValue({ statuses: [fixture({ installed: false })] });
    setup();
    fireEvent.click(
      await screen.findByRole("button", { name: "Install Claude Code plugin" })
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Failed to register"
      )
    );
  });
});
