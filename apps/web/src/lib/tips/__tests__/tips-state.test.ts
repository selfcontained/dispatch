import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import {
  dismissedTipsAtom,
  lastSeenVersionAtom,
  tipsEnabledAtom,
} from "../tips-state";

// @vitest-environment jsdom

describe("tips state atoms", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    window.localStorage.clear();
    store = createStore();
  });

  it("tipsEnabledAtom defaults to true", () => {
    expect(store.get(tipsEnabledAtom)).toBe(true);
  });

  it("dismissedTipsAtom defaults to empty array", () => {
    expect(store.get(dismissedTipsAtom)).toEqual([]);
  });

  it("lastSeenVersionAtom defaults to null", () => {
    expect(store.get(lastSeenVersionAtom)).toBeNull();
  });

  it("tipsEnabledAtom persists to localStorage", () => {
    store.set(tipsEnabledAtom, false);
    expect(JSON.parse(localStorage.getItem("dispatch:tipsEnabled")!)).toBe(
      false
    );
  });

  it("dismissedTipsAtom persists to localStorage", () => {
    store.set(dismissedTipsAtom, ["quick-phrases", "personas"]);
    expect(JSON.parse(localStorage.getItem("dispatch:dismissedTips")!)).toEqual(
      ["quick-phrases", "personas"]
    );
  });
});
