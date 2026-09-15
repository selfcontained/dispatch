// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { TextBlock } from "@/components/app/agent-surfaces/types";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";
import { TextBlockView } from "./text-block";

afterEach(() => {
  cleanup();
});

function block(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: "t1",
    type: "text",
    text: "Ready to ship.",
    ...overrides,
  } as TextBlock;
}

describe("TextBlockView", () => {
  it("renders plain prose with no callout wrapper when tone is absent", () => {
    const { container } = render(<TextBlockView block={block()} />);
    expect(screen.getByText("Ready to ship.")).toBeTruthy();
    expect(container.querySelector("[data-tone]")).toBeNull();
  });

  it("renders plain prose when tone is explicitly neutral", () => {
    const { container } = render(
      <TextBlockView block={block({ tone: "neutral" })} />
    );
    expect(container.querySelector("[data-tone]")).toBeNull();
  });

  it("renders a toned callout with the tone's border and background classes", () => {
    const { container } = render(
      <TextBlockView block={block({ tone: "warning" })} />
    );
    const wrapper = container.querySelector('[data-tone="warning"]');
    expect(wrapper).toBeTruthy();
    const callout = wrapper?.firstElementChild;
    const classes = callout?.className.split(" ") ?? [];
    for (const cls of TONE_CLASSES.warning.callout.split(" ")) {
      expect(classes).toContain(cls);
    }
  });

  it("renders the toned title in the tone's text color only when authored", () => {
    const { container, rerender } = render(
      <TextBlockView block={block({ tone: "danger", title: "Blocked" })} />
    );
    const heading = screen.getByText("Blocked");
    expect(heading.tagName).toBe("H3");
    expect(heading.className).toContain(TONE_CLASSES.danger.text);

    rerender(<TextBlockView block={block({ tone: "danger" })} />);
    expect(screen.queryByText("Blocked")).toBeNull();
    // Confirm the <h3> itself is gone, not just left empty of text.
    expect(container.querySelector("h3")).toBeNull();
  });

  it("renders the toned description only when authored", () => {
    const { container, rerender } = render(
      <TextBlockView
        block={block({ tone: "info", description: "Applies to prod only." })}
      />
    );
    expect(screen.getByText("Applies to prod only.")).toBeTruthy();

    rerender(<TextBlockView block={block({ tone: "info" })} />);
    expect(screen.queryByText("Applies to prod only.")).toBeNull();
    // The description Markdown wrapper carries "mb-1" — confirm it is gone
    // entirely, not just emptied of text.
    expect(container.querySelector(".mb-1")).toBeNull();
  });

  it("always renders the body text inside the toned callout", () => {
    render(
      <TextBlockView block={block({ tone: "success", text: "All good." })} />
    );
    expect(screen.getByText("All good.")).toBeTruthy();
  });
});
