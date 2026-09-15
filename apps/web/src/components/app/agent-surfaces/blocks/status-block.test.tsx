// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StatusBlock } from "@/components/app/agent-surfaces/types";
import { formatSurfaceTime } from "@/components/app/agent-surfaces/format";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";
import { StatusBlockView } from "./status-block";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function block(overrides: Partial<StatusBlock> = {}): StatusBlock {
  return {
    id: "s1",
    type: "status",
    status: "Running",
    ...overrides,
  } as StatusBlock;
}

describe("StatusBlockView", () => {
  it("defaults to neutral tone when none is authored", () => {
    const { container } = render(<StatusBlockView block={block()} />);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toContain(TONE_CLASSES.neutral.dot);
    expect(screen.getByText("Running").className).toContain(
      TONE_CLASSES.neutral.text
    );
  });

  it("applies the authored tone's dot and text classes", () => {
    const { container } = render(
      <StatusBlockView block={block({ tone: "danger" })} />
    );
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toContain(TONE_CLASSES.danger.dot);
    expect(screen.getByText("Running").className).toContain(
      TONE_CLASSES.danger.text
    );
  });

  it("renders no <time> element when the block has no timestamp", () => {
    const { container } = render(<StatusBlockView block={block()} />);
    expect(container.querySelector("time")).toBeNull();
  });

  it("renders the relative time with the absolute on the title attribute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));
    const iso = "2026-09-02T11:15:00Z";
    const expected = formatSurfaceTime(iso);

    render(<StatusBlockView block={block({ timestamp: iso })} />);

    const time = screen.getByText(`· ${expected.text}`);
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("dateTime")).toBe(iso);
    expect(time.getAttribute("title")).toBe(expected.absolute);
  });

  it("renders the detail markdown only when provided", () => {
    const { container, rerender } = render(
      <StatusBlockView block={block({ detail: "Retrying in 30s." })} />
    );
    expect(screen.getByText("Retrying in 30s.")).toBeTruthy();

    rerender(<StatusBlockView block={block({})} />);
    expect(screen.queryByText("Retrying in 30s.")).toBeNull();
    // The detail Markdown wrapper carries "mt-0.5" — confirm it is gone
    // entirely, not just emptied of text.
    expect(container.querySelector(".mt-0\\.5")).toBeNull();
  });

  it("passes title/description through to the shared BlockHeader", () => {
    render(
      <StatusBlockView
        block={block({ title: "Deploy", description: "prod-east-1" })}
      />
    );
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.getByText("prod-east-1")).toBeTruthy();
  });
});
