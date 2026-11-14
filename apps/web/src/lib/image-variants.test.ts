import { describe, expect, it } from "vitest";

import { imageVariantSrcSet, imageVariantUrl } from "./image-variants";

describe("imageVariantUrl", () => {
  it("adds w to a bare URL or to an existing query", () => {
    expect(imageVariantUrl("/f/a.png", 320)).toBe("/f/a.png?w=320");
    expect(imageVariantUrl("/f/a.png?t=1", 640)).toBe("/f/a.png?t=1&w=640");
  });
});

describe("imageVariantSrcSet", () => {
  it("lists every copy when the width is unknown", () => {
    expect(imageVariantSrcSet("/f/a.png")).toBe(
      "/f/a.png?w=320 320w, /f/a.png?w=640 640w, /f/a.png?w=1280 1280w"
    );
  });

  it("lists only copies narrower than the image, then the original at its width", () => {
    expect(imageVariantSrcSet("/f/a.png", 1000)).toBe(
      "/f/a.png?w=320 320w, /f/a.png?w=640 640w, /f/a.png 1000w"
    );
    expect(imageVariantSrcSet("/f/a.png", 3840)).toBe(
      "/f/a.png?w=320 320w, /f/a.png?w=640 640w, /f/a.png?w=1280 1280w, /f/a.png 3840w"
    );
  });

  it("offers only the original for an image no wider than the smallest copy", () => {
    expect(imageVariantSrcSet("/f/a.png", 320)).toBe("/f/a.png 320w");
  });
});
