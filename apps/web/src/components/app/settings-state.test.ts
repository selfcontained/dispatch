// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSettingsState } from "./settings-state";

// The hook talks to the server through the shared fetch wrapper and nothing
// else, so the HTTP seam is the only thing mocked.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

/** Resolve the admin check with a caller-controlled verdict. */
function adminCheck(isAdmin: boolean) {
  apiMock.mockResolvedValue({ isAdmin } as never);
}

/** Ids of the nav entries, in render order. */
function sectionIds(sections: Array<{ id: string }>): string[] {
  return sections.map((s) => s.id);
}

const NON_ADMIN_SECTIONS = [
  "general",
  "agents",
  "connections",
  "notifications",
  "resources",
  "updates",
  "help",
];

beforeEach(() => {
  apiMock.mockReset();
  adminCheck(false);
});

afterEach(() => {
  cleanup();
});

describe("useSettingsState", () => {
  it("falls back to General when the route names no section", () => {
    const { result } = renderHook(() => useSettingsState(true));

    expect(result.current.activeSection).toBe("general");
  });

  it("falls back to General when the route names an unknown section", () => {
    const { result } = renderHook(() => useSettingsState(true, "not-a-tab"));

    expect(result.current.activeSection).toBe("general");
  });

  it("opens on the section the route names", () => {
    const { result } = renderHook(() =>
      useSettingsState(true, "notifications")
    );

    expect(result.current.activeSection).toBe("notifications");
  });

  it("follows the route when it moves to another section", async () => {
    const { result, rerender } = renderHook(
      ({ section }: { section: string }) => useSettingsState(true, section),
      { initialProps: { section: "agents" } }
    );
    expect(result.current.activeSection).toBe("agents");

    rerender({ section: "resources" });

    await waitFor(() => expect(result.current.activeSection).toBe("resources"));
  });

  it("keeps the current section when the route moves to an unknown one", async () => {
    const { result, rerender } = renderHook(
      ({ section }: { section: string }) => useSettingsState(true, section),
      { initialProps: { section: "agents" } }
    );

    rerender({ section: "bogus" });

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(result.current.activeSection).toBe("agents");
  });

  it("omits Releases from the nav until the admin check says otherwise", async () => {
    const { result } = renderHook(() => useSettingsState(true));

    expect(sectionIds(result.current.sections)).toEqual(NON_ADMIN_SECTIONS);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(result.current.isAdmin).toBe(false);
    expect(sectionIds(result.current.sections)).toEqual(NON_ADMIN_SECTIONS);
  });

  it("checks admin rights against the release endpoint", async () => {
    renderHook(() => useSettingsState(true));

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledWith("/api/v1/release/admin-check");
  });

  it("slots Releases in ahead of Help once the check comes back admin", async () => {
    adminCheck(true);
    const { result } = renderHook(() => useSettingsState(true));

    await waitFor(() => expect(result.current.isAdmin).toBe(true));
    expect(sectionIds(result.current.sections)).toEqual([
      "general",
      "agents",
      "connections",
      "notifications",
      "resources",
      "updates",
      "releases",
      "help",
    ]);
  });

  it("survives a failed admin check and picks the verdict up on the next one", async () => {
    apiMock.mockRejectedValue(new Error("offline"));
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useSettingsState(open),
      { initialProps: { open: true } }
    );

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(sectionIds(result.current.sections)).toEqual(NON_ADMIN_SECTIONS);

    // Reopening re-runs the check. A rejection that was left to escape would
    // have torn the hook down instead of leaving it ready for this verdict.
    adminCheck(true);
    rerender({ open: false });
    rerender({ open: true });

    await waitFor(() => expect(result.current.isAdmin).toBe(true));
  });

  it("bounces a non-admin off the Releases route", async () => {
    const { result } = renderHook(() => useSettingsState(true, "releases"));

    await waitFor(() => expect(result.current.activeSection).toBe("general"));
    expect(result.current.isAdmin).toBe(false);
  });

  it("restores the Releases route once the admin check confirms access", async () => {
    let resolveCheck: (value: { isAdmin: boolean }) => void = () => {};
    apiMock.mockReturnValue(
      new Promise<{ isAdmin: boolean }>((resolve) => {
        resolveCheck = resolve;
      }) as never
    );
    const { result } = renderHook(() => useSettingsState(true, "releases"));

    // While the verdict is outstanding the deep link is parked on General...
    await waitFor(() => expect(result.current.activeSection).toBe("general"));

    resolveCheck({ isAdmin: true });

    // ...and only the confirmed verdict lands them back on Releases.
    await waitFor(() => expect(result.current.activeSection).toBe("releases"));
  });

  it("does not check admin rights while the pane is closed", () => {
    // The check fires from a mount effect, which `renderHook` has already
    // flushed by the time it returns — so a missing guard shows up here.
    renderHook(() => useSettingsState(false));

    expect(apiMock).not.toHaveBeenCalled();
  });

  it("does not follow route changes while the pane is closed", async () => {
    const { result, rerender } = renderHook(
      ({ open, section }: { open: boolean; section: string }) =>
        useSettingsState(open, section),
      { initialProps: { open: false, section: "notifications" } }
    );
    // The opening section still comes from the route even when closed — only
    // the *sync* effect is gated on `open`, which the route change exercises.
    expect(result.current.activeSection).toBe("notifications");

    rerender({ open: false, section: "agents" });

    await waitFor(() =>
      expect(result.current.activeSection).toBe("notifications")
    );

    rerender({ open: true, section: "agents" });

    await waitFor(() => expect(result.current.activeSection).toBe("agents"));
  });
});
