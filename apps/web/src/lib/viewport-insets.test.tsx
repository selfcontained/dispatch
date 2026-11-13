// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  OVERLAY_EDGE_GAP,
  safeCollisionPadding,
  visualViewportVars,
} from "./viewport-insets";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const INSETS = { top: 24, right: 0, bottom: 20, left: 0 };

describe("safeCollisionPadding", () => {
  it("adds the default gap beyond each safe-area inset", () => {
    expect(safeCollisionPadding(INSETS)).toEqual({
      top: 24 + OVERLAY_EDGE_GAP,
      right: OVERLAY_EDGE_GAP,
      bottom: 20 + OVERLAY_EDGE_GAP,
      left: OVERLAY_EDGE_GAP,
    });
  });

  it("keeps a caller's numeric padding as the gap past the inset", () => {
    expect(safeCollisionPadding(INSETS, 12)).toEqual({
      top: 36,
      right: 12,
      bottom: 32,
      left: 12,
    });
  });

  it("keeps per-side padding and defaults the sides it leaves out", () => {
    expect(safeCollisionPadding(INSETS, { top: 0, left: 16 })).toEqual({
      top: 24,
      right: OVERLAY_EDGE_GAP,
      bottom: 20 + OVERLAY_EDGE_GAP,
      left: 16,
    });
  });
});

describe("visualViewportVars", () => {
  it("leaves the CSS fallbacks in place without visualViewport support", () => {
    expect(visualViewportVars("")).toEqual({});
  });

  it("exposes the visible height and its offset", () => {
    expect(visualViewportVars("412:180")).toEqual({
      "--vv-height": "412px",
      "--vv-top": "180px",
    });
  });
});

describe("overlay primitives", () => {
  it("caps a popover to Radix's available height and scrolls inside", () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent data-testid="content">Body</PopoverContent>
      </Popover>
    );
    const content = screen.getByTestId("content");
    expect(content.className).toContain(
      "max-h-[var(--radix-popover-content-available-height)]"
    );
    expect(content.className).toContain("overflow-y-auto");
  });

  it("lets a caller's own height cap win over the default", () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent data-testid="content" className="max-h-40">
          Body
        </PopoverContent>
      </Popover>
    );
    const { className } = screen.getByTestId("content");
    expect(className).toContain("max-h-40");
    expect(className).not.toContain("available-height");
  });

  it("fits a dialog to the visual viewport as the keyboard opens", () => {
    const listeners = new Set<() => void>();
    const vv = {
      height: 1024,
      offsetTop: 0,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal("visualViewport", vv);
    render(
      <Dialog open>
        <DialogContent data-testid="dialog" aria-describedby={undefined}>
          <DialogTitle>Create Agent</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    const dialog = screen.getByTestId("dialog");
    expect(dialog.className).toContain("dialog-viewport-fit");
    expect(dialog.className).not.toContain("top-1/2");
    expect(dialog.style.getPropertyValue("--vv-height")).toBe("1024px");

    act(() => {
      vv.height = 600;
      vv.offsetTop = 120;
      for (const fn of listeners) fn();
    });
    expect(dialog.style.getPropertyValue("--vv-height")).toBe("600px");
    expect(dialog.style.getPropertyValue("--vv-top")).toBe("120px");
  });
});
