// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ProgressBlock } from "@/components/app/agent-surfaces/types";
import { ProgressBlockView } from "./progress-block";

afterEach(() => {
  cleanup();
});

function block(overrides: Partial<ProgressBlock> = {}): ProgressBlock {
  return {
    id: "p1",
    type: "progress",
    value: 3,
    max: 10,
    ...overrides,
  } as ProgressBlock;
}

describe("ProgressBlockView percent and clamping", () => {
  it("computes percent from value/max and mirrors it on the ARIA range", () => {
    render(<ProgressBlockView block={block({ value: 3, max: 10 })} />);

    expect(screen.getByText("30%")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuemax")).toBe("10");
  });

  it("clamps a negative value to 0 instead of going negative", () => {
    render(<ProgressBlockView block={block({ value: -5, max: 10 })} />);

    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "0"
    );
  });

  it("clamps a value above max down to max instead of overshooting 100%", () => {
    render(<ProgressBlockView block={block({ value: 25, max: 10 })} />);

    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "10"
    );
  });

  it("treats a non-positive max as 1 rather than dividing by zero", () => {
    render(<ProgressBlockView block={block({ value: 0, max: 0 })} />);

    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe(
      "1"
    );
  });

  it("rounds a fractional percent to the nearest whole number", () => {
    render(<ProgressBlockView block={block({ value: 2, max: 3 })} />);

    // 2/3 = 66.66...% — rounds up to 67, where floor would give 66.
    expect(screen.getByText("67%")).toBeTruthy();
  });
});

describe("ProgressBlockView tone", () => {
  it("gives a toned bar a different fill class than the neutral default", () => {
    const { container: neutralContainer } = render(
      <ProgressBlockView block={block({})} />
    );
    const neutralBar = neutralContainer.querySelector(
      '[role="progressbar"] > div'
    )!;
    cleanup();

    const { container: warningContainer } = render(
      <ProgressBlockView block={block({ tone: "warning" })} />
    );
    const warningBar = warningContainer.querySelector(
      '[role="progressbar"] > div'
    )!;

    expect(warningBar.className).not.toBe(neutralBar.className);
  });
});

describe("ProgressBlockView label/title precedence", () => {
  it("puts the title in the heading and the label on the progress line when both are set", () => {
    render(
      <ProgressBlockView
        block={block({ title: "Deploy", label: "3 of 10 steps" })}
      />
    );

    expect(screen.getByRole("heading", { name: "Deploy" })).toBeTruthy();
    expect(screen.getByText("3 of 10 steps")).toBeTruthy();
  });

  it("falls back to the title on the progress line and renders no heading when there is no label", () => {
    render(<ProgressBlockView block={block({ title: "Deploy" })} />);

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Deploy")).toBeTruthy();
  });

  it("falls back the ARIA label from label to title to a generic default", () => {
    const { rerender } = render(
      <ProgressBlockView
        block={block({ title: "Deploy", label: "3 of 10 steps" })}
      />
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "3 of 10 steps"
    );

    rerender(<ProgressBlockView block={block({ title: "Deploy" })} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Deploy"
    );

    rerender(<ProgressBlockView block={block({})} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Progress"
    );
  });

  it("renders the detail markdown only when provided", () => {
    const { rerender } = render(
      <ProgressBlockView block={block({ detail: "Extra context." })} />
    );
    expect(screen.getByText("Extra context.")).toBeTruthy();

    rerender(<ProgressBlockView block={block({})} />);
    expect(screen.queryByText("Extra context.")).toBeNull();
  });
});
