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

describe("Markdown code blocks", () => {
  it("gives a fenced block a copy button and leaves inline code alone", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <Markdown>{"Run `pnpm test`.\n\n```sh\npnpm test\n```\n"}</Markdown>
    );
    const blocks = screen.getAllByTestId("markdown-code-block");
    expect(blocks).toHaveLength(1);
    const button = screen.getByTestId("markdown-copy-code");
    button.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("pnpm test"));
  });
});
