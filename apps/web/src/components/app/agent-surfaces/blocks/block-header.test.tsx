// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BlockHeader } from "./block-header";

afterEach(() => {
  cleanup();
});

describe("BlockHeader", () => {
  it("renders nothing when title, description, and count are all absent", () => {
    const { container } = render(<BlockHeader />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the title alone as an h3, with no description markup", () => {
    const { container } = render(<BlockHeader title="Deploy status" />);
    expect(screen.getByText("Deploy status").tagName).toBe("H3");
    // The description markdown is gated on `description` being present —
    // the title row should be the header's only child when it is absent.
    expect(container.querySelector(".mb-1\\.5")?.children.length).toBe(1);
  });

  it("renders a count of 0 on its own, proving the check is `!== undefined` not truthiness", () => {
    const { container } = render(<BlockHeader count={0} />);
    expect(screen.getByText("(0)")).toBeTruthy();
    expect(container.querySelector("h3")).toBeNull();
  });

  it("renders the count parenthesized next to the title", () => {
    render(<BlockHeader title="Items" count={5} />);
    expect(screen.getByText("(5)")).toBeTruthy();
  });

  it("renders description as markdown when title and count are both absent", () => {
    const { container } = render(<BlockHeader description="Extra context." />);
    expect(screen.getByText("Extra context.")).toBeTruthy();
    expect(container.querySelector("h3")).toBeNull();
  });
});
