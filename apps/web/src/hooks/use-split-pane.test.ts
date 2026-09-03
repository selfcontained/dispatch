// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX,
  SPLIT_PANE_STATE_STORAGE_PREFIX,
  type SplitPaneState,
} from "@/lib/store";

import { normalizeSplitPaneState, useSplitPane } from "./use-split-pane";

describe("normalizeSplitPaneState", () => {
  it("leaves state alone while the chat surface is on", () => {
    const state = {
      mode: "split" as const,
      left: "chat" as const,
      right: "terminal" as const,
      sizes: [50, 50] as [number, number],
    };
    expect(normalizeSplitPaneState(state, true)).toBe(state);
  });

  it("swaps a persisted chat pane for the terminal when the flag is off", () => {
    expect(
      normalizeSplitPaneState(
        {
          mode: "split",
          left: "chat",
          right: "changes",
          sizes: [30, 70],
        },
        false
      )
    ).toEqual({
      mode: "split",
      left: "terminal",
      right: "changes",
      sizes: [30, 70],
    });
  });

  it("collapses a chat/terminal split to a single terminal pane", () => {
    expect(
      normalizeSplitPaneState(
        {
          mode: "split",
          left: "chat",
          right: "terminal",
          sizes: [50, 50],
        },
        false
      )
    ).toEqual({
      mode: "single",
      left: "terminal",
      right: "terminal",
      sizes: [50, 50],
    });
  });

  it("does not touch a state with no chat pane", () => {
    const state = {
      mode: "split" as const,
      left: "terminal" as const,
      right: "changes" as const,
      sizes: [50, 50] as [number, number],
    };
    expect(normalizeSplitPaneState(state, false)).toBe(state);
  });
});

describe("useSplitPane persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    // No globals/setupFiles in this config, so RTL never auto-cleans.
    cleanup();
    window.localStorage.clear();
  });

  const legacySplit: SplitPaneState = {
    mode: "split",
    left: "terminal",
    right: "changes",
    sizes: [30, 70],
  };

  function renderPane(agentId: string, chatEnabled = true) {
    const store = createStore();
    return renderHook(() => useSplitPane(agentId, false, chatEnabled), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(Provider, { store }, children),
    });
  }

  const v2Key = (agentId: string) =>
    `${SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`;
  const legacyKey = (agentId: string) =>
    `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`;

  it("reads a pre-chat client's split state from the legacy key", () => {
    // Each test uses its own agent id: the atom family caches the first read.
    window.localStorage.setItem(
      legacyKey("agt_read"),
      JSON.stringify(legacySplit)
    );
    const { result } = renderPane("agt_read");
    expect(result.current.splitState).toEqual(legacySplit);
    expect(result.current.isSplit).toBe(true);
  });

  it("writes only the versioned key, never the legacy one", () => {
    window.localStorage.setItem(
      legacyKey("agt_write"),
      JSON.stringify(legacySplit)
    );
    const { result } = renderPane("agt_write");

    act(() => result.current.handleTabDrop("chat", "left", "terminal"));

    expect(result.current.splitState).toEqual({
      ...legacySplit,
      left: "chat",
    });
    expect(
      JSON.parse(window.localStorage.getItem(v2Key("agt_write"))!)
    ).toEqual({ ...legacySplit, left: "chat" });
    // A client rolled back to v0.37.10 reads this key and must never find
    // "chat" in it.
    expect(window.localStorage.getItem(legacyKey("agt_write"))).toBe(
      JSON.stringify(legacySplit)
    );
  });

  it("prefers the versioned key over the legacy one", () => {
    window.localStorage.setItem(
      legacyKey("agt_both"),
      JSON.stringify(legacySplit)
    );
    const v2: SplitPaneState = {
      mode: "split",
      left: "chat",
      right: "whiteboard",
      sizes: [50, 50],
    };
    window.localStorage.setItem(v2Key("agt_both"), JSON.stringify(v2));
    const { result } = renderPane("agt_both");
    expect(result.current.splitState).toEqual(v2);
  });

  it("still normalises a persisted chat pane away while the flag is off", () => {
    window.localStorage.setItem(
      v2Key("agt_flag_off"),
      JSON.stringify({
        mode: "split",
        left: "chat",
        right: "terminal",
        sizes: [50, 50],
      })
    );
    const { result } = renderPane("agt_flag_off", false);
    expect(result.current.splitState).toEqual({
      mode: "single",
      left: "terminal",
      right: "terminal",
      sizes: [50, 50],
    });
    expect(result.current.isSplit).toBe(false);
  });
});
