// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { afterEach, describe, expect, it } from "vitest";

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
afterEach(cleanup);

describe("ActivityBlock settle", () => {
  it("does not toggle step details as the stream progresses", () => {
    const step = {
      ...open.steps[0],
      kind: "execute" as const,
      status: "running" as const,
      detail: { input: { command: "pnpm test" } },
    };
    const { rerender } = render(
      <ActivityBlock trace={{ ...open, steps: [step] }} />
    );
    const button = screen.getByRole("button", { name: /running/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    rerender(
      <ActivityBlock
        trace={{
          ...open,
          steps: [
            {
              ...step,
              status: "ok",
              detail: { ...step.detail, terminalOutput: "Passed" },
            },
          ],
        }}
      />
    );
    expect(
      screen
        .getByRole("button", { name: /completed/ })
        .getAttribute("aria-expanded")
    ).toBe("true");
    expect(screen.getByText("Passed")).toBeTruthy();
  });
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
