// @vitest-environment jsdom
import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSidebarPinPreference,
  pinnedFirst,
  reorderSidebarPinGroup,
  toggleSidebarPin,
} from "./agent-sidebar-pins";
import { reconcileAgentSidebarOrder } from "./store";

const ids = (order: string[], pins: string[]) =>
  pinnedFirst(
    order.map((id) => ({ id })),
    new Set(pins)
  ).map((card) => card.id);
afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe("sidebar session pins", () => {
  it("stably partitions manual order and restores it after unpinning, regardless of pin sequence", () => {
    const normal = reconcileAgentSidebarOrder(["c", "a", "b"], ["a", "b", "c"]);
    let pins = toggleSidebarPin([], "b");
    pins = toggleSidebarPin(pins, "c");
    expect(ids(normal, pins)).toEqual(["c", "b", "a"]);
    pins = toggleSidebarPin(pins, "b");
    pins = toggleSidebarPin(pins, "c");
    expect(ids(normal, pins)).toEqual(["c", "a", "b"]);
    expect(normal).toEqual(["c", "a", "b"]);
  });

  it("does not add hidden, nested, stale or empty references to the projected cards", () => {
    const pins = ["hidden", "child", "stale", "", "a", "a"];
    expect(ids(["b", "a"], pins)).toEqual(["a", "b"]);
    expect(ids(["hidden", "b", "a"], pins)).toEqual(["hidden", "a", "b"]);
    expect(toggleSidebarPin(pins, "a")).toEqual(["hidden", "child", "stale"]);
    expect(pins).toContain("hidden");
    expect(ids([], pins)).toEqual([]);
  });

  it("reorders only the same group's visible slots without corrupting other groups or hidden projects", () => {
    const normal = ["a", "hidden", "b", "c", "d"];
    const pins = new Set(["b", "d"]);
    expect(
      reorderSidebarPinGroup(
        normal,
        ["a", "b", "c", "d"],
        pins,
        "d",
        "b",
        "before"
      )
    ).toEqual(["a", "hidden", "d", "c", "b"]);
    expect(
      reorderSidebarPinGroup(
        normal,
        ["a", "b", "c", "d"],
        pins,
        "c",
        "a",
        "before"
      )
    ).toEqual(["c", "hidden", "b", "a", "d"]);
    expect(
      reorderSidebarPinGroup(
        normal,
        ["a", "b", "c", "d"],
        pins,
        "b",
        "a",
        "before"
      )
    ).toEqual(normal);
    expect(
      reorderSidebarPinGroup(normal, ["a", "b"], pins, "a", "hidden", "after")
    ).toEqual(normal);
  });

  it.each([null, {}, "a", [1], ["a", null]])(
    "rejects malformed stored preference %j",
    (value) => {
      expect(isSidebarPinPreference(value)).toBe(false);
    }
  );

  it("persists stable IDs through fresh module/store loads and keeps hidden pins on updates", async () => {
    localStorage.setItem(
      "dispatch:agentSidebarPins",
      JSON.stringify(["hidden", "b", "b", ""])
    );
    vi.resetModules();
    const first = await import("./store");
    const store = createStore();
    expect(ids(["a", "b"], store.get(first.agentSidebarPinsAtom))).toEqual([
      "b",
      "a",
    ]);
    store.set(first.agentSidebarPinsAtom, (pins) =>
      toggleSidebarPin(pins, "a")
    );
    expect(
      JSON.parse(localStorage.getItem("dispatch:agentSidebarPins")!)
    ).toEqual(["hidden", "b", "a"]);
    vi.resetModules();
    const fresh = await import("./store");
    expect(createStore().get(fresh.agentSidebarPinsAtom)).toEqual([
      "hidden",
      "b",
      "a",
    ]);
  });

  it.each(["{", '{"id":"a"}', '["a",12]'])(
    "safely loads invalid storage %s",
    async (raw) => {
      localStorage.setItem("dispatch:agentSidebarPins", raw);
      vi.resetModules();
      const fresh = await import("./store");
      expect(createStore().get(fresh.agentSidebarPinsAtom)).toEqual([]);
    }
  );
});
