// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { CHAT_UNREAD_QUERY_KEY } from "@/hooks/use-chat-unread-summary";

import { ChatUnreadBadge } from "./chat-unread-badge";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

afterEach(cleanup);

function renderIndicator(unread: number, pendingQuestions: number) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const update = (unread: number, pendingQuestions: number) =>
    client.setQueryData(CHAT_UNREAD_QUERY_KEY, {
      agents: { agt_1: { unread, pendingQuestions } },
    });
  update(unread, pendingQuestions);
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <ChatUnreadBadge agentId="agt_1" />
      </TooltipProvider>
    </QueryClientProvider>
  );
  return update;
}

describe("ChatUnreadBadge input indicator", () => {
  it.each([0, 3])(
    "renders nothing for %i unread replies without pending input",
    (unread) => {
      renderIndicator(unread, 0);
      expect(screen.queryByTestId("agent-chat-unread")).toBeNull();
    }
  );

  it.each([
    [0, 1],
    [5, 3],
  ])("shows one unboxed icon for unread=%i, pending=%i", (unread, pending) => {
    renderIndicator(unread, pending);
    const indicator = screen.getByRole("img", { name: "Needs your input" });
    expect(indicator.tagName).toBe("SPAN");
    expect(indicator.textContent).toBe("");
    expect(indicator.querySelectorAll("svg")).toHaveLength(1);
    expect(indicator.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
    expect(indicator.className).toContain("text-status-waiting");
    expect(indicator.className).not.toMatch(/\b(bg-|border|px-|py-)/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the concise tooltip on keyboard focus", async () => {
    renderIndicator(0, 1);
    const indicator = screen.getByRole("img", { name: "Needs your input" });
    expect(indicator.tabIndex).toBe(0);
    fireEvent.focus(indicator);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Needs your input"
    );
  });

  it("survives mark-read and disappears after the final input is answered or canceled", async () => {
    const update = renderIndicator(5, 2);
    await act(async () => {
      update(0, 2);
    });
    expect(screen.getByRole("img", { name: "Needs your input" })).toBeTruthy();
    await act(async () => {
      update(0, 1);
    });
    expect(
      screen.getAllByRole("img", { name: "Needs your input" })
    ).toHaveLength(1);
    await act(async () => {
      update(3, 0);
    });
    await waitFor(() =>
      expect(screen.queryByTestId("agent-chat-unread")).toBeNull()
    );
  });
});
