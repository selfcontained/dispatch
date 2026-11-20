// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

import { createElement, type ReactNode } from "react";

import { ChatRowStateContext } from "../chat-row-state";
import type { Step } from "./contracts";
import { progressSummary, useActivitySum } from "./activity-summary";

let n = 0;
const step = (over: Partial<Step>): Step => ({
  id: `s${++n}`,
  kind: "read",
  label: "Read a.ts",
  status: "ok",
  startedAt: n,
  ...over,
});

describe("activity summary", () => {
  it("counts every step by kind and counts failures", () => {
    const steps = [
      step({}),
      step({}),
      step({ kind: "edit", label: "Edit b.ts" }),
      step({ kind: "edit", label: "Edit c.ts", status: "error" }),
    ];
    const { result } = renderHook(() => useActivitySum(steps));
    expect(result.current).toBe("2 reads · 2 edits · 1 failed");
  });

  it("never goes down when a step is reclassified or drops out of the feed", () => {
    const run = step({
      kind: "execute",
      label: "Terminal",
      status: "pending",
    });
    const { result, rerender } = renderHook(
      ({ steps }: { steps: Step[] }) => useActivitySum(steps),
      { initialProps: { steps: [run] } }
    );
    expect(result.current).toBeUndefined();
    const resolved: Step = {
      ...run,
      status: "running",
      detail: { input: { command: "node a.js" } },
    };
    rerender({ steps: [resolved] });
    expect(result.current).toBe("1 edit");
    // The same call now reads as a check, and an older step vanishes.
    rerender({
      steps: [
        {
          ...resolved,
          status: "ok",
          detail: { input: { command: "pnpm test" } },
        },
      ],
    });
    expect(result.current).toBe("1 edit");
    rerender({ steps: [] });
    expect(result.current).toBe("1 edit");
  });

  it("keeps its counts when the placeholder remounts in the same row", () => {
    const row = new Map<string, unknown>();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatRowStateContext.Provider, { value: row }, children);
    const steps = [step({}), step({ kind: "edit", label: "Edit b.ts" })];
    const first = renderHook(() => useActivitySum(steps), { wrapper });
    expect(first.result.current).toBe("1 read · 1 edit");
    first.unmount();
    // Back after "Show less" or a scroll, with the read gone from the feed.
    const again = renderHook(() => useActivitySum([steps[1]!]), { wrapper });
    expect(again.result.current).toBe("1 read · 1 edit");
  });

  it("shows the newest complete sentence, never a half-written one", () => {
    // Still in its first sentence: nothing to show yet.
    expect(progressSummary("I'll check the", true)).toBeUndefined();
    // The sentence ended while the paragraph streams on.
    expect(progressSummary("I'll check the logs. Then retr", true)).toBe(
      "I'll check the logs"
    );
    // Each finished sentence replaces the last.
    expect(
      progressSummary("I'll check the logs. Then retry the build. Th", true)
    ).toBe("Then retry the build");
    // A new paragraph's half sentence does not replace the last complete one.
    expect(progressSummary("First.\n\nNext, the tes", true)).toBe("First");
    expect(progressSummary("First.\n\nNext, the tests.", true)).toBe(
      "Next, the tests"
    );
    // A finished paragraph without a period still counts, and file names
    // do not end a sentence.
    expect(progressSummary("Running fib.js now", false)).toBe(
      "Running fib.js now"
    );
  });
});
