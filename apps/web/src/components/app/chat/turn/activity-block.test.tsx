// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { describe, expect, it } from "vitest";

import { ActivityBlock } from "./activity-block";
import type { Trace } from "./contracts";

const at = Date.parse("2026-09-07T10:00:00Z");
const open: Trace = {
  startedAt: at,
  steps: [
    {
      id: "s",
      kind: "read",
      label: "Read",
      status: "ok",
      startedAt: at,
      endedAt: at + 500,
      durMs: 500,
    },
  ],
};
const done: Trace = { ...open, endedAt: at + 1000, finalResult: "ok" };

describe("ActivityBlock settle", () => {
  it("renders the open rail while running and the collapsed summary once settled, both inside one layout group", async () => {
    const { rerender } = render(
      <MotionConfig reducedMotion="always">
        <ActivityBlock trace={open} />
      </MotionConfig>
    );
    expect(screen.getByTestId("harness-activity")).toBeTruthy();
    rerender(
      <MotionConfig reducedMotion="always">
        <ActivityBlock trace={done} label="read a.ts" />
      </MotionConfig>
    );
    // The fold cross-fades on opacity, which framer-motion does not
    // fast-forward under reducedMotion (only positional keys like x/y/
    // width/height are exempt from AnimatePresence's exit wait), so the
    // summary settles in on the next tick rather than synchronously.
    await waitFor(() => {
      expect(
        screen.getByTestId("harness-activity-summary").textContent
      ).toContain("read a.ts");
    });
    expect(screen.getByTestId("harness-activity-fold")).toBeTruthy();
  });
});
