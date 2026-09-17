// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CenterPaneTabBar } from "./center-pane-tab-bar";

const singleState = {
  mode: "single" as const,
  left: "agent" as const,
  right: "changes" as const,
  sizes: [50, 50] as [number, number],
};

afterEach(() => {
  cleanup();
});

describe("CenterPaneTabBar", () => {
  it("puts the Agent tab first and offers no Terminal, Chat or Console tab", () => {
    render(
      <MemoryRouter>
        <CenterPaneTabBar
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
    render(
      <MemoryRouter>
        <CenterPaneTabBar
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

  it("renders all three tabs", () => {
    render(
      <MemoryRouter>
        <CenterPaneTabBar
          activeTab="agent"
          onTabChange={vi.fn()}
          isSplit={false}
          splitState={singleState}
          isMobile={false}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("tab", { name: /agent/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /changes/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /whiteboard/i })).toBeTruthy();
  });
});
