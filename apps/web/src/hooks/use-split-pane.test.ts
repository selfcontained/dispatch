import { describe, expect, it } from "vitest";

import { normalizeSplitPaneState } from "./use-split-pane";

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
