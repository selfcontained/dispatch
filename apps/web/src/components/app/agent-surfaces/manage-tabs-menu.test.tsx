// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManageTabsMenu } from "./manage-tabs-menu";
import type { ManagedSurfaceTab } from "./use-surface-tab-prefs";
import type { Surface } from "@/components/app/agent-surfaces/types";

afterEach(() => cleanup());

function makeSurface(overrides: Partial<Surface>): Surface {
  return {
    schemaVersion: 1,
    id: "surface-a",
    ownerAgentId: "agt_test",
    title: "Surface A",
    revision: 1,
    lifecycle: "active",
    sortOrder: 0,
    blocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    unresolvedInteractionCount: 0,
    latestInteractions: [],
    ...overrides,
  };
}

function noop() {
  /* no-op */
}

describe("ManageTabsMenu", () => {
  it("shows an unresolved-interaction badge on a row, including a hidden tab", () => {
    const managedTabs: ManagedSurfaceTab[] = [
      {
        surface: makeSurface({
          id: "visible",
          title: "Visible tab",
          unresolvedInteractionCount: 2,
        }),
        hidden: false,
      },
      {
        surface: makeSurface({
          id: "hidden",
          title: "Hidden tab",
          unresolvedInteractionCount: 3,
        }),
        hidden: true,
      },
    ];

    render(
      <ManageTabsMenu
        managedTabs={managedTabs}
        activeTabId={null}
        onSelectTab={noop}
        hiddenCount={1}
        moveTabEarlier={noop}
        moveTabLater={noop}
        toggleHidden={noop}
        resetOrder={noop}
      />
    );
    fireEvent.click(screen.getByTestId("surface-tabs-more"));

    const rows = screen.getAllByTestId("manage-tab-row");
    const visible = rows.find((row) =>
      row.textContent?.includes("Visible tab")
    )!;
    const hidden = rows.find((row) => row.textContent?.includes("Hidden tab"))!;

    expect(
      visible.querySelector('[data-testid="manage-tab-unresolved-count"]')
        ?.textContent
    ).toBe("2");
    // A hidden tab still surfaces its pending count — it has no button in
    // the strip itself to show it on.
    expect(
      hidden.querySelector('[data-testid="manage-tab-unresolved-count"]')
        ?.textContent
    ).toBe("3");
  });

  it("omits the badge when a row has nothing unresolved", () => {
    const managedTabs: ManagedSurfaceTab[] = [
      {
        surface: makeSurface({
          id: "quiet",
          title: "Quiet tab",
          unresolvedInteractionCount: 0,
        }),
        hidden: false,
      },
    ];

    render(
      <ManageTabsMenu
        managedTabs={managedTabs}
        activeTabId={null}
        onSelectTab={noop}
        hiddenCount={0}
        moveTabEarlier={noop}
        moveTabLater={noop}
        toggleHidden={noop}
        resetOrder={noop}
      />
    );
    fireEvent.click(screen.getByTestId("surface-tabs-more"));

    expect(screen.queryByTestId("manage-tab-unresolved-count")).toBeNull();
  });

  it("flags an unseen surface with a dot, including one that's hidden", () => {
    const managedTabs: ManagedSurfaceTab[] = [
      {
        surface: makeSurface({ id: "unseen-visible", title: "Unseen visible" }),
        hidden: false,
      },
      {
        surface: makeSurface({ id: "unseen-hidden", title: "Unseen hidden" }),
        hidden: true,
      },
      {
        surface: makeSurface({ id: "seen", title: "Seen tab" }),
        hidden: false,
      },
    ];
    const isNew = vi.fn((id: string) => id !== "seen");

    render(
      <ManageTabsMenu
        managedTabs={managedTabs}
        activeTabId={null}
        onSelectTab={noop}
        hiddenCount={1}
        moveTabEarlier={noop}
        moveTabLater={noop}
        toggleHidden={noop}
        resetOrder={noop}
        isNew={isNew}
      />
    );
    fireEvent.click(screen.getByTestId("surface-tabs-more"));

    const rows = screen.getAllByTestId("manage-tab-row");
    const unseenVisible = rows.find((row) =>
      row.textContent?.includes("Unseen visible")
    )!;
    const unseenHidden = rows.find((row) =>
      row.textContent?.includes("Unseen hidden")
    )!;
    const seen = rows.find((row) => row.textContent?.includes("Seen tab"))!;

    expect(
      unseenVisible.querySelector('[data-testid="manage-tab-new-dot"]')
    ).not.toBeNull();
    expect(
      unseenHidden.querySelector('[data-testid="manage-tab-new-dot"]')
    ).not.toBeNull();
    expect(seen.querySelector('[data-testid="manage-tab-new-dot"]')).toBeNull();
  });

  it("omits the new-dot entirely when isNew is not supplied", () => {
    const managedTabs: ManagedSurfaceTab[] = [
      { surface: makeSurface({ id: "a", title: "Tab A" }), hidden: false },
    ];

    render(
      <ManageTabsMenu
        managedTabs={managedTabs}
        activeTabId={null}
        onSelectTab={noop}
        hiddenCount={0}
        moveTabEarlier={noop}
        moveTabLater={noop}
        toggleHidden={noop}
        resetOrder={noop}
      />
    );
    fireEvent.click(screen.getByTestId("surface-tabs-more"));

    expect(screen.queryByTestId("manage-tab-new-dot")).toBeNull();
  });
});
