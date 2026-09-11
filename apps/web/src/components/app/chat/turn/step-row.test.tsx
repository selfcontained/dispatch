// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Step } from "./contracts";
import { StepRow } from "./step-row";

afterEach(cleanup);

const T0 = 1_700_000_000_000;

const running: Step = {
  id: "s1",
  kind: "execute",
  label: "bash",
  status: "running",
  startedAt: T0,
  detail: { input: { command: "pnpm test" }, terminalOutput: null },
};

const settled: Step = {
  ...running,
  status: "ok",
  endedAt: T0 + 800,
  durMs: 800,
  detail: { input: { command: "pnpm test" }, terminalOutput: "42 passed\n" },
};

describe("StepRow fold", () => {
  it("expands a settled command even when the tool returned no output", () => {
    const command = "git status --short --branch";
    const noOutput: Step = {
      ...running,
      status: "ok",
      detail: { input: { command }, terminalOutput: null },
    };
    render(<StepRow step={noOutput} open onToggle={() => {}} maskClass="" />);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true"
    );
    expect(screen.getByText(command)).toBeTruthy();
  });

  it("removes closed details immediately without a height transition", () => {
    const { rerender } = render(
      <StepRow step={running} open onToggle={() => {}} maskClass="" />
    );
    expect(screen.getAllByText(/pnpm test/).length).toBeGreaterThan(0);
    rerender(
      <StepRow step={settled} open={false} onToggle={() => {}} maskClass="" />
    );
    expect(screen.getAllByText(/pnpm test/).length).toBe(1);
    expect(screen.queryByText(/42 passed/)).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false"
    );
  });
});

describe("StepRow with children", () => {
  const at = Date.parse("2026-09-07T10:00:00Z");
  const parent: Step = {
    id: "p",
    kind: "other",
    label: "Task",
    status: "ok",
    startedAt: at,
    endedAt: at + 5000,
    durMs: 5000,
    detail: { input: { description: "look around" } },
    children: [
      {
        id: "c1",
        kind: "read",
        label: "Read",
        status: "ok",
        startedAt: at + 1000,
        endedAt: at + 2000,
        durMs: 1000,
        detail: { locations: [{ path: "a.ts" }] },
      },
      {
        id: "c2",
        kind: "execute",
        label: "bash",
        status: "ok",
        startedAt: at + 2000,
        endedAt: at + 3000,
        durMs: 1000,
        detail: { input: { command: "ls" }, terminalOutput: "a.ts" },
      },
    ],
  };

  it("is expandable and lists the children as a nested rail when open", () => {
    render(
      <StepRow step={parent} open onToggle={() => {}} maskClass="bg-muted" />
    );
    const nested = screen.getByTestId("harness-nested-steps");
    expect(nested.getAttribute("role")).toBe("list");
    expect(within(nested).getAllByTestId("harness-step")).toHaveLength(2);
    expect(
      within(nested)
        .getAllByTestId("harness-step")[0]
        .getAttribute("data-depth")
    ).toBe("1");
  });

  it("puts the nested guide line under the child rows, at the parent's indent", () => {
    // The guide line used to sit in the outer container, which put it
    // exactly on top of the top-level rail while the child glyphs, 12px to
    // the right, had no line behind them at all. And the branch skipped the
    // pl-[21px] every other expanded body uses, so the Task step's own
    // arguments sat under the glyph rather than under the label.
    render(
      <StepRow step={parent} open onToggle={() => {}} maskClass="bg-muted" />
    );
    const nested = screen.getByTestId("harness-nested-steps");
    expect(nested.className).toContain("relative");
    const guide = nested.querySelector("span[aria-hidden='true']");
    expect(guide?.className).toContain("left-[5.5px]");
    expect(screen.getByTestId("harness-step-children").className).toContain(
      "pl-[21px]"
    );
  });

  it("shows no nested rail when closed", () => {
    render(
      <StepRow
        step={parent}
        open={false}
        onToggle={() => {}}
        maskClass="bg-muted"
      />
    );
    expect(screen.queryByTestId("harness-nested-steps")).toBeNull();
  });
});
