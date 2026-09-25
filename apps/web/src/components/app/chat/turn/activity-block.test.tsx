// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";

const useTurnDetailMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-stream", () => ({ useTurnDetail: useTurnDetailMock }));

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
afterEach(() => {
  cleanup();
  useTurnDetailMock.mockReset();
});

describe("ActivityBlock step list", () => {
  const ran: Trace = {
    ...open,
    steps: [
      {
        ...open.steps[0],
        kind: "execute",
        detail: { input: { command: "pnpm test" }, terminalOutput: "Passed" },
      },
    ],
  };

  // Queried from the DOM, not by role: a closed fold is aria-hidden, so a
  // role query would miss rows that are rendered but hidden.
  const stepList = () =>
    document.querySelector('[aria-label="activity steps"]');

  it("renders no step rows while the fold is closed", async () => {
    render(<ActivityBlock trace={ran} />);
    expect(stepList()).toBeNull();

    fireEvent.click(screen.getByTestId("harness-activity-summary"));
    expect(screen.getByRole("button", { name: /completed/ })).toBeTruthy();

    fireEvent.click(screen.getByTestId("harness-activity-summary"));
    await waitFor(() => expect(stepList()).toBeNull());
  });

  it("keeps a step's detail open across closing and reopening the fold", async () => {
    render(<ActivityBlock trace={ran} />);
    fireEvent.click(screen.getByTestId("harness-activity-summary"));
    fireEvent.click(screen.getByRole("button", { name: /completed/ }));
    expect(screen.getByText("Passed")).toBeTruthy();

    fireEvent.click(screen.getByTestId("harness-activity-summary"));
    await waitFor(() => expect(stepList()).toBeNull());

    fireEvent.click(screen.getByTestId("harness-activity-summary"));
    expect(
      screen
        .getByRole("button", { name: /completed/ })
        .getAttribute("aria-expanded")
    ).toBe("true");
    expect(screen.getByText("Passed")).toBeTruthy();
  });

  it("loads a settled turn's omitted diff only when activity opens", () => {
    useTurnDetailMock.mockReturnValue({
      turn: {
        trace: {
          startedAt: "2026-09-07T10:00:00Z",
          endedAt: "2026-09-07T10:00:01Z",
          steps: [
            {
              id: "edit-1",
              kind: "edit",
              label: "edit example.ts",
              status: "ok",
              startedAt: "2026-09-07T10:00:00Z",
              detail: {
                diff: {
                  path: "example.ts",
                  oldText: "before",
                  newText: "after",
                },
              },
            },
          ],
        },
      },
      isLoading: false,
      error: null,
    });
    render(
      <ActivityBlock
        trace={done}
        details={{ rootId: "agt_1", blockId: "block-1" }}
      />
    );
    expect(useTurnDetailMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("harness-activity-summary"));
    expect(useTurnDetailMock).toHaveBeenCalledWith("agt_1", "block-1");
    fireEvent.click(
      screen.getByRole("button", { name: /edit example.ts, completed/ })
    );
    expect(screen.getByText("before")).toBeTruthy();
    expect(screen.getByText("after")).toBeTruthy();
  });

  it.each([
    ["loading", { turn: null, isLoading: true, error: null }],
    ["failed", { turn: null, isLoading: false, error: new Error("offline") }],
  ])(
    "keeps compact steps visible while full details are %s",
    (_state, result) => {
      useTurnDetailMock.mockReturnValue(result);
      render(
        <ActivityBlock
          trace={{
            ...done,
            steps: [
              {
                id: "edit-1",
                kind: "edit",
                label: "edit example.ts",
                status: "ok",
                startedAt: at,
                endedAt: at + 500,
                detail: { locations: [{ path: "example.ts" }] },
              },
            ],
          }}
          details={{ rootId: "agt_1", blockId: "block-1" }}
        />
      );
      fireEvent.click(screen.getByTestId("harness-activity-summary"));
      expect(screen.getByRole("status").textContent).toMatch(/details/i);
      expect(
        screen.getByRole("button", { name: /edit example.ts, completed/ })
      ).toBeTruthy();
    }
  );
});

describe("ActivityBlock settle", () => {
  it("updates the closed summary as live steps arrive", () => {
    const { rerender } = render(
      <ActivityBlock trace={{ ...open, steps: [] }} />
    );
    const summary = screen.getByTestId("harness-activity-summary");
    expect(summary.textContent).toContain("thinking");
    expect(summary.getAttribute("aria-expanded")).toBe("false");

    rerender(
      <ActivityBlock
        trace={{
          ...open,
          steps: [
            {
              id: "live-command",
              kind: "execute",
              label: "run pnpm test",
              status: "running",
              startedAt: at + 500,
              detail: { input: { command: "pnpm test" } },
            },
          ],
        }}
      />
    );
    expect(summary.textContent).toContain("pnpm test");
    expect(summary.textContent).toContain("1 step");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[aria-label="activity steps"]')).toBeNull();
  });

  it("keeps the turn summary between reported running steps", () => {
    render(<ActivityBlock trace={open} label="read a.ts" />);
    expect(
      screen.getByTestId("harness-activity-summary").textContent
    ).toContain("read a.ts");
  });

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
    // The fold is closed until the reader opens it, even while running.
    fireEvent.click(screen.getByTestId("harness-activity-summary"));
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
  it("renders the open step list while running and the collapsed summary once settled, both inside one layout group", async () => {
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
