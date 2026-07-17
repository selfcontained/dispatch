/**
 * Fixed-position elements are laid out in the layout viewport, but on iPad the
 * visual viewport moves independently (pinch zoom, on-screen keyboard). These
 * helpers convert "bottom of what the user can currently see" into layout
 * coordinates so the toolbar and card stay on screen.
 */

export interface VisualViewportMetrics {
  offsetTop: number;
  offsetLeft: number;
  width: number;
  height: number;
}

export function readViewportMetrics(win: Window): VisualViewportMetrics {
  const vv = win.visualViewport;
  if (vv) {
    return {
      offsetTop: vv.offsetTop,
      offsetLeft: vv.offsetLeft,
      width: vv.width,
      height: vv.height,
    };
  }
  return {
    offsetTop: 0,
    offsetLeft: 0,
    width: win.innerWidth,
    height: win.innerHeight,
  };
}

/** Layout-coordinate `top` that pins an element's bottom edge to the visual viewport bottom. */
export function bottomAnchoredTop(
  metrics: VisualViewportMetrics,
  elementHeight: number,
  margin: number
): number {
  return metrics.offsetTop + metrics.height - elementHeight - margin;
}

/** Layout-coordinate `left` that horizontally centers an element in the visual viewport. */
export function centeredLeft(
  metrics: VisualViewportMetrics,
  elementWidth: number
): number {
  return metrics.offsetLeft + Math.max(0, (metrics.width - elementWidth) / 2);
}

/** Clamp a badge/tooltip position into the visible viewport. */
export function clampToViewport(
  metrics: VisualViewportMetrics,
  value: number,
  size: number,
  axis: "x" | "y",
  margin = 8
): number {
  const start =
    (axis === "x" ? metrics.offsetLeft : metrics.offsetTop) + margin;
  const end =
    (axis === "x"
      ? metrics.offsetLeft + metrics.width
      : metrics.offsetTop + metrics.height) -
    size -
    margin;
  return Math.max(start, Math.min(value, Math.max(start, end)));
}

export function onViewportChange(win: Window, handler: () => void): () => void {
  win.addEventListener("scroll", handler, true);
  win.addEventListener("resize", handler);
  win.visualViewport?.addEventListener("resize", handler);
  win.visualViewport?.addEventListener("scroll", handler);
  return () => {
    win.removeEventListener("scroll", handler, true);
    win.removeEventListener("resize", handler);
    win.visualViewport?.removeEventListener("resize", handler);
    win.visualViewport?.removeEventListener("scroll", handler);
  };
}
