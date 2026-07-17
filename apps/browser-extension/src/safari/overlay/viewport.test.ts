import { describe, expect, it } from "vitest";

import {
  bottomAnchoredTop,
  centeredLeft,
  clampToViewport,
  type VisualViewportMetrics,
} from "./viewport";

const unscrolled: VisualViewportMetrics = {
  offsetTop: 0,
  offsetLeft: 0,
  width: 800,
  height: 600,
};

// Pinch-zoomed / keyboard-open: the visual viewport sits inside the layout one.
const shifted: VisualViewportMetrics = {
  offsetTop: 120,
  offsetLeft: 40,
  width: 400,
  height: 300,
};

describe("viewport", () => {
  it("anchors to the bottom of the unshifted viewport", () => {
    expect(bottomAnchoredTop(unscrolled, 50, 16)).toBe(600 - 50 - 16);
  });

  it("follows the visual viewport when zoomed or the keyboard is open", () => {
    expect(bottomAnchoredTop(shifted, 50, 16)).toBe(120 + 300 - 50 - 16);
  });

  it("centers within the visual viewport, not the layout viewport", () => {
    expect(centeredLeft(shifted, 200)).toBe(40 + (400 - 200) / 2);
    expect(centeredLeft(shifted, 500)).toBe(40);
  });

  it("clamps positions into the visible area", () => {
    expect(clampToViewport(shifted, 0, 100, "x")).toBe(48);
    expect(clampToViewport(shifted, 1000, 100, "x")).toBe(40 + 400 - 100 - 8);
    expect(clampToViewport(shifted, 200, 100, "y")).toBe(200);
  });
});
