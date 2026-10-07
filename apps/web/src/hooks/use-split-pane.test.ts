// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SPLIT_PANE_STATE_STORAGE_PREFIX,
  type SplitPaneState,
} from "@/lib/store";

import { useSplitPane } from "./use-split-pane";

describe("useSplitPane persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    // No globals/setupFiles in this config, so RTL never auto-cleans.
    cleanup();
    window.localStorage.clear();
  });

  const storedSplit: SplitPaneState = {
    mode: "split",
    left: "agent",
    right: "changes",
    sizes: [30, 70],
  };

  function renderPane(agentId: string) {
    const store = createStore();
    return renderHook(() => useSplitPane(agentId, false), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(Provider, { store }, children),
    });
  }

  const key = (agentId: string) =>
    `${SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`;

  it("reads a stored split state", () => {
    // Each test uses its own agent id: the atom family caches the first read.
    window.localStorage.setItem(key("agt_read"), JSON.stringify(storedSplit));
    const { result } = renderPane("agt_read");
    expect(result.current.splitState).toEqual(storedSplit);
    expect(result.current.isSplit).toBe(true);
  });

  it("writes changes back under the same key", () => {
    window.localStorage.setItem(key("agt_write"), JSON.stringify(storedSplit));
    const { result } = renderPane("agt_write");

    act(() => result.current.updateSizes([40, 60]));

    expect(result.current.splitState).toEqual({
      ...storedSplit,
      sizes: [40, 60],
    });
    expect(JSON.parse(window.localStorage.getItem(key("agt_write"))!)).toEqual({
      ...storedSplit,
      sizes: [40, 60],
    });
  });

  it("reads a stored value with an unknown pane id as the default", () => {
    window.localStorage.setItem(
      key("agt_stale"),
      JSON.stringify({
        mode: "split",
        left: "chat",
        right: "changes",
        sizes: [50, 50],
      })
    );
    const { result } = renderPane("agt_stale");
    expect(result.current.splitState).toEqual({
      mode: "single",
      left: "agent",
      right: "changes",
      sizes: [50, 50],
    });
  });
});
