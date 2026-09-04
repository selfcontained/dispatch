// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { centerTabs } from "@/lib/center-tabs";

import { CenterPaneTabBar } from "./center-pane-tab-bar";

const H = vi.hoisted(() => ({ chatEnabled: false }));

vi.mock("@/hooks/use-chat-surface-enabled", () => ({
  useChatSurfaceEnabled: () => ({ enabled: H.chatEnabled, loaded: true }),
}));

const singleState = {
  mode: "single" as const,
  left: "terminal" as const,
  right: "changes" as const,
  sizes: [50, 50] as [number, number],
};

afterEach(() => {
  cleanup();
  H.chatEnabled = false;
});

describe("CenterPaneTabBar", () => {
  it("offers no Agent tab and keeps the Terminal label with the flag off", () => {
    render(
      <MemoryRouter>
        <CenterPaneTabBar
          chatEnabled={H.chatEnabled}
          activeTab="terminal"
          onTabChange={vi.fn()}
          isSplit={false}
          splitState={singleState}
          isMobile={false}
          chatUnreadCount={3}
        />
      </MemoryRouter>
    );
    expect(screen.queryByRole("tab", { name: /agent/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /chat/i })).toBeNull();
    expect(screen.getByRole("tab", { name: /^terminal$/i })).toBeTruthy();
    expect(screen.queryByTestId("center-tab-agent")).toBeNull();
    expect(screen.queryByTestId("chat-unread-count")).toBeNull();
  });

  it("puts the Agent tab first, in place of Terminal, with the flag on", () => {
    H.chatEnabled = true;
    render(
      <MemoryRouter>
        <CenterPaneTabBar
          chatEnabled={H.chatEnabled}
          activeTab="changes"
          onTabChange={vi.fn()}
          isSplit={false}
          splitState={singleState}
          isMobile={false}
          chatUnreadCount={3}
        />
      </MemoryRouter>
    );
    const tabs = screen.getAllByRole("tab").map((el) => el.textContent);
    expect(tabs[0]).toMatch(/^Agent/);
    expect(tabs).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: /^terminal$/i })).toBeNull();
    expect(screen.queryByTestId("center-tab-terminal")).toBeNull();
    expect(screen.queryByRole("tab", { name: /^chat$/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /^console$/i })).toBeNull();
    // Unread chat replies land on the Agent tab while another tab is up.
    const agentTab = screen.getByTestId("center-tab-agent");
    expect(
      agentTab.querySelector("[data-testid='chat-unread-count']")
    ).not.toBeNull();
    expect(screen.getByTestId("chat-unread-count").textContent).toBe("3");
  });

  it("hides the unread badge while the Agent tab is active", () => {
    H.chatEnabled = true;
    render(
      <MemoryRouter>
        <CenterPaneTabBar
          chatEnabled={H.chatEnabled}
          activeTab="agent"
          onTabChange={vi.fn()}
          isSplit={false}
          splitState={singleState}
          isMobile={false}
          chatUnreadCount={3}
        />
      </MemoryRouter>
    );
    expect(screen.queryByTestId("chat-unread-count")).toBeNull();
  });

  it("orders the tabs Agent, Changes, Whiteboard", () => {
    expect(centerTabs(true).map((t) => t.id)).toEqual([
      "agent",
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
          chatEnabled={H.chatEnabled}
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
