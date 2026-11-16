// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttentionCard, type AttentionToastEvent } from "./attention-toast";

afterEach(cleanup);

const event = (message: string): AttentionToastEvent => ({
  type: "attention.toast",
  toastId: "t1",
  agentId: "agt_b",
  agentName: "Builder",
  kind: "question",
  message,
  target: { streamId: "agt_b", threadId: null, blockId: "blk_1" },
});

function Location() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}

function renderCard(
  message: string,
  props: Partial<Parameters<typeof AttentionCard>[0]> = {}
) {
  const onOpen = vi.fn();
  const utils = render(
    <MemoryRouter>
      <AttentionCard event={event(message)} onOpen={onOpen} {...props} />
      <Location />
    </MemoryRouter>
  );
  return { ...utils, onOpen };
}

const MARKDOWN =
  "Ship **the fix** with `pnpm check`? See [PR 12](https://github.com/o/r/pull/12).";

describe("AttentionCard markdown", () => {
  it("renders bold, code and links inline", () => {
    const { container } = renderCard(MARKDOWN);
    const message = screen.getByTestId("markdown-compact");
    expect(message.querySelector("strong")?.textContent).toBe("the fix");
    expect(message.querySelector("code")?.textContent).toBe("pnpm check");
    const link = screen.getByRole("link", { name: "PR 12" });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/12");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    // One flowing run: no paragraphs or other blocks.
    expect(message.querySelector("p, div")).toBeNull();
    expect(container.textContent).not.toMatch(/\*\*|`|\]\(/);
  });

  it("flattens headings, lists and fences into the clamped run", () => {
    renderCard(
      "# Heading\n\n- first item\n- second item\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\n![diagram](https://x.test/a.png)"
    );
    const message = screen.getByTestId("markdown-compact");
    expect(message.className).toContain("line-clamp-2");
    expect(
      message.querySelector("h1, h2, ul, ol, li, pre, blockquote, img, p")
    ).toBeNull();
    // The fence's text stays plain text, not a code chip.
    expect(message.querySelector("code")).toBeNull();
    const text = message.textContent!.replace(/\s+/g, " ").trim();
    expect(text).toBe(
      "Heading first item second item const x = 1; quoted diagram"
    );
  });

  it("truncates to one line in the drawer", () => {
    renderCard("# Big\n\n- a\n- b", {
      createdAt: new Date().toISOString(),
      link: true,
    });
    const message = screen.getByTestId("markdown-compact");
    expect(message.className).toContain("truncate");
    expect(message.querySelector("h1, ul, li")).toBeNull();
  });

  it("opens the link without opening the toast", () => {
    const { onOpen } = renderCard(MARKDOWN, { onDismiss: () => {} });
    const link = screen.getByRole("link", { name: "PR 12" });
    // Not nested inside the card's action.
    expect(link.closest("button")).toBeNull();
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Builder Question/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens the link without navigating from a drawer card", () => {
    const { onOpen } = renderCard(MARKDOWN, {
      createdAt: new Date().toISOString(),
      link: true,
    });
    const link = screen.getByRole("link", { name: "PR 12" });
    const card = screen.getByRole("link", { name: /Builder Question/ });
    expect(card.contains(link)).toBe(false);
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("/");
  });

  it("names the action and tooltip with plain text", () => {
    renderCard(`# Ready\n\n${MARKDOWN}`, { settled: true });
    const action = screen.getByRole("button", { name: /Builder/ });
    const name = action
      .getAttribute("aria-labelledby")!
      .split(" ")
      .map((id) => document.getElementById(id)!.textContent)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(name).toBe(
      "Builder Question Ready Ship the fix with pnpm check? See PR 12. Settled"
    );
    expect(name).not.toMatch(/[*`#[\]]/);
    const title = screen.getByTestId("markdown-compact").parentElement!.title;
    expect(title).toBe("Ready Ship the fix with pnpm check? See PR 12.");
  });
});
