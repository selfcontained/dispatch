// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "./markdown";

vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: ({ code }: { code: string }) => (
    <div data-testid="mermaid-renderer">{code}</div>
  ),
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

describe("Markdown inline variant", () => {
  it("keeps links and marks but unwraps headings, fences and paragraphs", () => {
    const { container } = render(
      <Markdown variant="inline">{`Fix [SWE-1](https://x.test/1): \`reason\` **hidden**

# Second line

\`\`\`sh
pnpm run check
\`\`\``}</Markdown>
    );
    const root = screen.getByTestId("markdown-inline");
    expect(root.tagName).toBe("DIV");
    expect(container.querySelector("h1, pre, p")).toBeNull();
    expect(root.querySelector("a")?.getAttribute("href")).toBe(
      "https://x.test/1"
    );
    expect(root.querySelector("strong")?.textContent).toBe("hidden");
    // A paragraph still gets its own line, as a block span, not a <p>; the
    // heading and the fence drop to their inline content at the item's size.
    const lines = root.querySelectorAll(":scope > span.block");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe("Fix SWE-1: reason hidden");
    expect(root.textContent).toContain("Second line");
    expect(root.querySelector(":scope > code")?.textContent).toBe(
      "pnpm run check\n"
    );
  });

  it("keeps nested lists inside a valid block container", () => {
    render(<Markdown variant="inline">{"- nested item"}</Markdown>);
    const root = screen.getByTestId("markdown-inline");
    expect(root.tagName).toBe("DIV");
    expect(root.querySelector(":scope > ul > li")?.textContent).toBe(
      "nested item"
    );
  });
});

describe("Markdown code blocks", () => {
  it.each(["```", "~~~~"])(
    "defers an open %s Mermaid fence until it closes",
    (fence) => {
      const source = `${fence}mermaid\ngraph TD\n A[`;
      const { rerender } = render(<Markdown streaming>{source}</Markdown>);
      expect(screen.queryByTestId("mermaid-renderer")).toBeNull();
      expect(screen.getByTestId("markdown-code-block").textContent).toContain(
        "A["
      );
      rerender(<Markdown streaming>{`${source}Ready]\n${fence}\n`}</Markdown>);
      expect(screen.getByTestId("mermaid-renderer").textContent).toContain(
        "A[Ready]"
      );
      expect(screen.queryByTestId("markdown-code-block")).toBeNull();
    }
  );

  it("renders completed invalid diagrams and settled unclosed fences", () => {
    const source = "```mermaid\ngraph TD\n A[";
    const { rerender } = render(
      <Markdown streaming>{`${source}\n\`\`\``}</Markdown>
    );
    expect(screen.getByTestId("mermaid-renderer").textContent).toContain("A[");
    rerender(<Markdown>{source}</Markdown>);
    expect(screen.getByTestId("mermaid-renderer").textContent).toContain("A[");
  });

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
