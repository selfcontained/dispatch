import { describe, expect, it } from "vitest";

import { feedImageBoxStyle } from "@/components/app/chat/feed-image";

/**
 * The contract this whole feature rests on: the box is computed from the stored
 * numbers alone, so it is the same before the bytes arrive as after. A live
 * browser proves that for the shapes someone thought to upload; these lock the
 * arithmetic for the ones nobody will.
 */
describe("feedImageBoxStyle", () => {
  it("gives a landscape image its own ratio, capped by max height", () => {
    // 1280/720 at 224px tall is 398.2px wide, which is under the natural width,
    // so the height cap is what binds.
    const style = feedImageBoxStyle(1280, 720, 224);
    expect(style.aspectRatio).toBe("1280 / 720");
    expect(style.width).toBe(`${224 * (1280 / 720)}px`);
    expect(style.maxWidth).toBe("100%");
  });

  it("caps a tall image by width, so the frame stays flush around it", () => {
    // A max-height would clamp the frame and leave the image floating in it.
    const style = feedImageBoxStyle(400, 900, 224);
    expect(style.width).toBe(`${224 * (400 / 900)}px`);
    expect(style.aspectRatio).toBe("400 / 900");
  });

  it("never upscales a thumbnail past its natural width", () => {
    // 160/120 at 224px tall would be 298px wide — wider than the file is.
    expect(feedImageBoxStyle(160, 120, 224).width).toBe("160px");
  });

  it("floors both axes so a degenerate shape stays visible and clickable", () => {
    // A 2000x20 crop reserves ~3px of height at feed width, and a 16x16 icon
    // reserves 16px square. Both are unreadable and below any touch target,
    // and both were a 224px-tall frame before ratio boxes existed.
    for (const [w, h] of [
      [2000, 20],
      [1200, 6],
      [16, 16],
      [1, 1],
    ]) {
      const style = feedImageBoxStyle(w, h, 224);
      expect(style.minWidth).toBe("2.75rem");
      expect(style.minHeight).toBe("2.75rem");
    }
  });

  it("does not round a sliver away to nothing", () => {
    // Rounding a width under half a pixel would give a 0px box.
    const style = feedImageBoxStyle(1, 100_000, 224);
    expect(style.width).not.toBe("0px");
    expect(Number.parseFloat(String(style.width))).toBeGreaterThan(0);
  });

  it("folds a container max into the width so an inline value cannot ignore it", () => {
    const style = feedImageBoxStyle(1280, 720, 256, "20rem");
    expect(style.width).toBe(`min(20rem, ${256 * (1280 / 720)}px)`);
  });

  it("falls back to a fixed height when either dimension is missing", () => {
    // Same height the feed used before dimensions were stored: it letterboxes,
    // but it does not move. No aspect ratio and no floor — the height is the
    // reservation.
    for (const [w, h] of [
      [undefined, undefined],
      [1280, undefined],
      [undefined, 720],
      [0, 0],
    ] as Array<[number | undefined, number | undefined]>) {
      const style = feedImageBoxStyle(w, h, 224);
      expect(style).toEqual({ width: "100%", height: "224px" });
    }
  });

  it("keeps the caller's container max on the fallback too", () => {
    expect(feedImageBoxStyle(undefined, undefined, 256, "20rem")).toEqual({
      width: "100%",
      height: "256px",
      maxWidth: "20rem",
    });
  });

  it("reserves the same box whichever max height the caller passes", () => {
    // The two call sites differ only by this number; nothing else should.
    const attachment = feedImageBoxStyle(1600, 400, 224);
    const media = feedImageBoxStyle(1600, 400, 256);
    expect(attachment.aspectRatio).toBe(media.aspectRatio);
    expect(attachment.width).toBe(`${224 * 4}px`);
    expect(media.width).toBe(`${256 * 4}px`);
  });
});
