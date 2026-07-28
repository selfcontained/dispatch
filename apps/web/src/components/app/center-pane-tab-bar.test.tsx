// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { CenterPaneTabBar } from "./center-pane-tab-bar";

describe("CenterPaneTabBar", () => {
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
