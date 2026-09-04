// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "./markdown";

vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

afterEach(cleanup);

describe("MarkdownDefault overflow", () => {
  it("keeps prose unclipped and gives tables their own horizontal scroller", () => {
    const { container } = render(
      <Markdown>{`| First | Second | Third |
| --- | --- | --- |
| alpha | beta | gamma |`}</Markdown>
    );

    const prose = container.firstElementChild as HTMLElement;
    const scroller = screen.getByTestId("markdown-table-scroll");
    expect(prose.className).not.toContain("overflow-x-hidden");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.querySelector("table")).not.toBeNull();
  });
});
