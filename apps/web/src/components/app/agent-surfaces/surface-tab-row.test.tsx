// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { edgeFadeMask, SurfaceTabRow } from "./surface-tab-row";
import type { Surface } from "@/components/app/agent-surfaces/types";
import type { MediaSidebarTab } from "@/lib/store";

const FIXTURE_SURFACES: Surface[] = [
  {
    schemaVersion: 1,
    id: "surface-a",
    ownerAgentId: "agt_test",
    title: "Flagged items",
    icon: "flag",
    revision: 1,
    lifecycle: "active",
    sortOrder: 0,
    blocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    unresolvedInteractionCount: 0,
    latestInteractions: [],
  },
  {
    schemaVersion: 1,
    id: "surface-b",
    ownerAgentId: "agt_test",
    title: "Untitled tab",
    revision: 1,
    lifecycle: "active",
    sortOrder: 1,
    blocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    unresolvedInteractionCount: 2,
    latestInteractions: [],
  },
];

// jsdom has no layout engine, so Element.scrollIntoView and ResizeObserver
// (used to keep the active tab in view) aren't implemented — stub both for
// the effect that calls them.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function Harness({
  agentId,
  initialTab,
}: {
  agentId: string;
  initialTab: MediaSidebarTab;
}) {
  const [activeTab, setActiveTab] = useState<MediaSidebarTab>(initialTab);
  return (
    <SurfaceTabRow
      agentId={agentId}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      surfaces={FIXTURE_SURFACES}
    />
  );
}

function renderRow(agentId: string, initialTab: MediaSidebarTab = "pins") {
  return render(
    <Provider>
      <Harness agentId={agentId} initialTab={initialTab} />
    </Provider>
  );
}

describe("SurfaceTabRow", () => {
  it("renders a fixed Agent provenance marker ahead of the scrolling tab strip", () => {
    renderRow("agt_marker");

    const marker = screen.getByTestId("surface-provenance-marker");
    expect(marker.textContent).toContain("Agent");

    const scroll = screen.getByTestId("surface-tab-scroll");
    // The marker is a sibling that precedes the scroll strip, not inside it,
    // so it never scrolls away with the tabs.
    expect(scroll.contains(marker)).toBe(false);
    expect(
      marker.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders each surface's authored icon, and none when unset", () => {
    renderRow("agt_icons");
    const buttons = screen.getAllByTestId("surface-tab-button");

    expect(buttons[0]!.querySelector("svg")).not.toBeNull(); // surface-a has icon: "flag"
    expect(buttons[1]!.querySelector("svg")).toBeNull(); // surface-b has no icon
  });

  it("marks the active tab current and shows a bottom accent", () => {
    renderRow("agt_active", "surface-a");
    const buttons = screen.getAllByTestId("surface-tab-button");

    expect(buttons[0]!.getAttribute("aria-current")).toBe("true");
    expect(buttons[1]!.getAttribute("aria-current")).toBeNull();
  });

  it("flags never-viewed surfaces as new, then clears the flag once opened", () => {
    renderRow("agt_new");
    const [tabA, tabB] = screen.getAllByTestId("surface-tab-button");

    expect(tabA!.getAttribute("data-new")).toBe("true");
    expect(tabB!.getAttribute("data-new")).toBe("true");

    fireEvent.click(tabA!);

    expect(tabA!.getAttribute("data-new")).toBe("false");
    expect(tabB!.getAttribute("data-new")).toBe("true");
    expect(
      JSON.parse(
        window.localStorage.getItem("dispatch:seenSurfaceIds:agt_new") ?? "[]"
      )
    ).toContain("surface-a");
  });

  it("does not re-flag a surface already recorded as seen", () => {
    window.localStorage.setItem(
      "dispatch:seenSurfaceIds:agt_seen",
      JSON.stringify(["surface-a", "surface-b"])
    );

    renderRow("agt_seen");
    const buttons = screen.getAllByTestId("surface-tab-button");

    expect(buttons[0]!.getAttribute("data-new")).toBe("false");
    expect(buttons[1]!.getAttribute("data-new")).toBe("false");
  });

  it("shows no edge fade when the strip has nothing off-canvas", () => {
    renderRow("agt_no_overflow");
    const strip = screen.getByTestId("surface-tab-scroll");

    // jsdom has no layout, so scrollWidth/clientWidth default to 0 — the
    // same "nothing overflowing" state as a strip that genuinely fits.
    expect(strip.getAttribute("data-overflow-left")).toBe("false");
    expect(strip.getAttribute("data-overflow-right")).toBe("false");
  });

  it("fades the edge with more tabs off-canvas, and clears it once scrolled all the way there", () => {
    renderRow("agt_overflow");
    const strip = screen.getByTestId("surface-tab-scroll");

    Object.defineProperty(strip, "scrollWidth", {
      value: 500,
      configurable: true,
    });
    Object.defineProperty(strip, "clientWidth", {
      value: 200,
      configurable: true,
    });
    Object.defineProperty(strip, "scrollLeft", {
      value: 0,
      configurable: true,
    });
    fireEvent.scroll(strip);

    // At the left edge already — no left fade, but more sits to the right.
    expect(strip.getAttribute("data-overflow-left")).toBe("false");
    expect(strip.getAttribute("data-overflow-right")).toBe("true");

    Object.defineProperty(strip, "scrollLeft", {
      value: 300,
      configurable: true,
    });
    fireEvent.scroll(strip);

    // Scrolled all the way to the end — the right fade clears, the left
    // fade appears since content now sits off-canvas behind the scroll.
    expect(strip.getAttribute("data-overflow-left")).toBe("true");
    expect(strip.getAttribute("data-overflow-right")).toBe("false");
  });
});

describe("edgeFadeMask", () => {
  it("returns no mask when neither edge overflows", () => {
    expect(edgeFadeMask(false, false)).toBeUndefined();
  });

  it("fades only the left edge", () => {
    expect(edgeFadeMask(true, false)).toBe(
      "linear-gradient(to right, transparent 0, black 24px, black 100%)"
    );
  });

  it("fades only the right edge", () => {
    expect(edgeFadeMask(false, true)).toBe(
      "linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)"
    );
  });

  it("fades both edges", () => {
    expect(edgeFadeMask(true, true)).toBe(
      "linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%)"
    );
  });
});
