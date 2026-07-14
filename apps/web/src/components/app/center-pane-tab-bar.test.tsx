// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CenterPaneTabBar } from "./center-pane-tab-bar";

describe("CenterPaneTabBar", () => {
  it("compacts large diff counts while exposing the exact values", () => {
    render(
      <CenterPaneTabBar
        activeTab="changes"
        onTabChange={vi.fn()}
        diffStats={{
          added: 12_345,
          deleted: 98_765,
          files: 42,
          computedAt: 1,
        }}
        isSplit={false}
        splitState={{
          mode: "single",
          left: "terminal",
          right: "changes",
          sizes: [50, 50],
        }}
        isMobile={false}
      />
    );

    const badge = screen.getByTitle("12,345 additions, 98,765 deletions");
    expect(badge.textContent).toBe("+12k−99k");
    expect(badge.getAttribute("aria-label")).toBe(
      "12,345 additions, 98,765 deletions"
    );
    expect(badge.className).toContain("hidden");
    expect(badge.className).toContain("sm:inline-flex");
    expect(screen.getByRole("tab", { name: /changes/i }).className).toContain(
      "sm:w-36"
    );
  });
});
