// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CenterPaneTabBar, centerTabs } from "./center-pane-tab-bar";

const singleState = {
  mode: "single" as const,
  left: "terminal" as const,
  right: "changes" as const,
  sizes: [50, 50] as [number, number],
};

afterEach(() => {
  cleanup();
});

describe("CenterPaneTabBar", () => {
  it("offers no chat tab and keeps the Terminal label with the flag off", () => {
    render(
      <MemoryRouter>
        <CenterPaneTabBar
          activeTab="terminal"
          onTabChange={vi.fn()}
          isSplit={false}
          splitState={singleState}
          isMobile={false}
          chatEnabled={false}
          chatUnreadCount={3}
        />
      </MemoryRouter>
    );
    expect(screen.queryByRole("tab", { name: /chat/i })).toBeNull();
    expect(screen.getByRole("tab", { name: /^terminal$/i })).toBeTruthy();
    expect(screen.queryByTestId("chat-unread-count")).toBeNull();
  });

  it("puts Chat first and relabels the terminal Console with the flag on", () => {
    render(
      <MemoryRouter>
        <CenterPaneTabBar
          activeTab="terminal"
          onTabChange={vi.fn()}
          isSplit={false}
          splitState={singleState}
          isMobile={false}
          chatEnabled={true}
          chatUnreadCount={3}
        />
      </MemoryRouter>
    );
    const tabs = screen.getAllByRole("tab").map((el) => el.textContent);
    expect(tabs[0]).toMatch(/^Chat/);
    expect(tabs[1]).toBe("Console");
    expect(screen.queryByRole("tab", { name: /^terminal$/i })).toBeNull();
    expect(screen.getByTestId("chat-unread-count").textContent).toBe("3");
  });

  it("hides the unread badge while the chat tab is active", () => {
    render(
      <MemoryRouter>
        <CenterPaneTabBar
          activeTab="chat"
          onTabChange={vi.fn()}
          isSplit={false}
          splitState={singleState}
          isMobile={false}
          chatEnabled={true}
          chatUnreadCount={3}
        />
      </MemoryRouter>
    );
    expect(screen.queryByTestId("chat-unread-count")).toBeNull();
  });

  it("orders the tabs Chat, Console, Changes, Whiteboard", () => {
    expect(centerTabs(true).map((t) => t.id)).toEqual([
      "chat",
      "terminal",
      "changes",
      "whiteboard",
    ]);
    expect(centerTabs(false).map((t) => t.id)).toEqual([
      "terminal",
      "changes",
      "whiteboard",
    ]);
  });

  it("renders all three tabs with consistent spacing", () => {
    render(
      <MemoryRouter>
        <CenterPaneTabBar
          activeTab="terminal"
          onTabChange={vi.fn()}
          isSplit={false}
          splitState={{
            mode: "single",
            left: "terminal",
            right: "changes",
            sizes: [50, 50],
          }}
          isMobile={false}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("tab", { name: /terminal/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /changes/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /whiteboard/i })).toBeTruthy();
  });
});
