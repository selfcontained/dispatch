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
    expect(blocks[0]?.querySelector(".hljs")).not.toBeNull();
    const button = screen.getByTestId("markdown-copy-code");
    button.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("pnpm test"));
  });

  it("keeps large fenced blocks highlighted and copyable", async () => {
    const code = "const value = 1;\n".repeat(1_100);
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<Markdown>{`\`\`\`ts\n${code}\`\`\``}</Markdown>);

    const block = screen.getByTestId("markdown-code-block");
    expect(block.querySelector("pre")?.textContent).toContain(
      "const value = 1;"
    );
    expect(block.querySelector("pre")?.textContent?.length).toBeGreaterThan(
      16_000
    );
    expect(block.querySelector(".hljs")).not.toBeNull();
    screen.getByTestId("markdown-copy-code").click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(code.trimEnd())
    );
  });
});

describe("Markdown prose decoration", () => {
  it("decorates formatted prose while preserving links and literal code", () => {
    const renderText = vi.fn((text: string) => <mark>{text}</mark>);
    const { container } = render(
      <Markdown renderText={renderText}>
        {
          "**@Agent**\n\n- *Mention*\n\n[Docs](https://example.com)\n\n`@Agent`\n\n```text\n@Agent\n```"
        }
      </Markdown>
    );
    expect(container.querySelector("strong mark")?.textContent).toBe("@Agent");
    expect(container.querySelector("li em mark")?.textContent).toBe("Mention");
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://example.com"
    );
    expect(container.querySelector("code mark")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("@Agent");
  });
});
