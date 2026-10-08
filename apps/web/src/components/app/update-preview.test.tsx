// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadApp } from "@/lib/pwa-update";
import UpdatePreview from "./update-preview";

vi.mock("@/lib/pwa-update", () => ({ reloadApp: vi.fn() }));
vi.mock("@/lib/version", () => ({ noteServerVersion: vi.fn() }));
vi.mock("@/lib/energy-metrics", () => ({
  recordReleaseManagerPollFire: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("finishing a simulation", () => {
  it.each([0, 3000, 8000])(
    "finishes after %ims without pending stages undoing it",
    async (elapsed) => {
      vi.useFakeTimers();
      render(<UpdatePreview />);
      fireEvent.click(
        screen.getByRole("button", { name: "Simulate long wait" })
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(elapsed);
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Finish simulation" })
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByText("Update complete")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(reloadApp).toHaveBeenCalledTimes(1);
      // The original offline/trial callbacks must not overwrite completion,
      // even if navigation is delayed or prevented by the browser.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12000);
      });
      expect(screen.getByText("Update complete")).toBeTruthy();
      expect(reloadApp).toHaveBeenCalledTimes(1);
    }
  );
  it("keeps dismissal inside the simulation without live release controls or requests", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<UpdatePreview />);
    fireEvent.click(screen.getByRole("button", { name: "Simulate long wait" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish simulation" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(
      screen.getByText("Simulation dismissed. Reloading the preview…")
    ).toBeTruthy();
    expect(screen.queryByText("Current version")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Check for updates" })
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(reloadApp).toHaveBeenCalledTimes(1);
  });
});
