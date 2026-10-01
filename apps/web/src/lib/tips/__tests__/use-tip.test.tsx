// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dismissedTipsAtom,
  lastSeenVersionAtom,
  tipsEnabledAtom,
} from "../tips-state";
import { useTip } from "../use-tip";

vi.mock("@/lib/version", () => ({ BUILD_VERSION: "0.29.0" }));

function renderUseTip(id: string, store: ReturnType<typeof createStore>) {
  return renderHook(() => useTip(id), {
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
}

describe("useTip", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    window.localStorage.clear();
    store = createStore();
  });

  it("returns null tip for unknown ID", () => {
    const { result } = renderUseTip("nonexistent", store);
    expect(result.current.tip).toBeNull();
    expect(result.current.shouldShowInline).toBe(false);
  });

  it("shouldShowInline is true when tip version is newer than lastSeenVersion", () => {
    store.set(lastSeenVersionAtom, "0.22.0");
    const { result } = renderUseTip("quick-phrases", store); // since: "0.23.0"
    expect(result.current.shouldShowInline).toBe(true);
  });

  it("shouldShowInline is false when tip version is older than lastSeenVersion", () => {
    store.set(lastSeenVersionAtom, "0.24.0");
    const { result } = renderUseTip("quick-phrases", store); // since: "0.23.0"
    expect(result.current.shouldShowInline).toBe(false);
  });

  it("shouldShowInline is false when lastSeenVersion is null (first-time user)", () => {
    const { result } = renderUseTip("quick-phrases", store);
    expect(result.current.shouldShowInline).toBe(false);
  });

  it("shows a tip added at the user's version on any newer build", () => {
    store.set(lastSeenVersionAtom, "0.28.2");
    const { result } = renderUseTip("uncommitted-diff", store);
    expect(result.current.shouldShowInline).toBe(true);
  });

  it("dismiss marks the tip as dismissed", () => {
    store.set(lastSeenVersionAtom, "0.22.0");
    const { result } = renderUseTip("quick-phrases", store);
    expect(result.current.shouldShowInline).toBe(true);

    act(() => result.current.dismiss());

    expect(result.current.shouldShowInline).toBe(false);
    expect(store.get(dismissedTipsAtom)).toContain("quick-phrases");
  });

  it("disableAll sets tipsEnabled to false", () => {
    const { result } = renderUseTip("quick-phrases", store);
    act(() => result.current.disableAll());
    expect(store.get(tipsEnabledAtom)).toBe(false);
  });
});
