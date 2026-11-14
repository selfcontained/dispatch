import { describe, expect, it } from "vitest";

import { feedImageBoxWidth, galleryTileSizes } from "./chat-attachment-views";

describe("feedImageBoxWidth", () => {
  it("is the max-w-xs width when the size is unknown", () => {
    expect(feedImageBoxWidth()).toBe(320);
  });

  it("caps a wide image at the 320px button", () => {
    expect(feedImageBoxWidth(3200, 2000)).toBe(320);
  });

  it("narrows a tall image to the width that fits 224px of height", () => {
    // 224 * (1000 / 2000) = 112
    expect(feedImageBoxWidth(1000, 2000)).toBe(112);
  });

  it("never exceeds the image's own width", () => {
    expect(feedImageBoxWidth(100, 50)).toBe(100);
  });
});

describe("galleryTileSizes", () => {
  it("uses the tile width for square and portrait images", () => {
    expect(galleryTileSizes(1000, 1000)).toBe(
      "(min-width: 640px) 160px, calc(50vw * 1.000)"
    );
    expect(galleryTileSizes(1000, 3000)).toBe(
      "(min-width: 640px) 160px, calc(50vw * 1.000)"
    );
    expect(galleryTileSizes()).toBe(
      "(min-width: 640px) 160px, calc(50vw * 1.000)"
    );
  });

  it("widens by the aspect ratio for a landscape image under object-cover", () => {
    expect(galleryTileSizes(3200, 2000)).toBe(
      "(min-width: 640px) 256px, calc(50vw * 1.600)"
    );
  });
});
