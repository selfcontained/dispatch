// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { imageRasterSize, renderAnnotatedImage } from "./image-feedback";

afterEach(() => vi.restoreAllMocks());

it.each([
  ['width="640" height="320"', 640, 320],
  ['viewBox="0 0 800 400"', 1024, 512],
  ['viewBox="0 0 80000 40000"', 2560, 1280],
  ["", 1024, 512],
  ['viewBox="0 0 24 24"', 1024, 1024],
])(
  "exports a nonzero PNG with zero intrinsic SVG size: %s",
  async (attrs, width, height) => {
    const image = new Image();
    image.src = "/diagram.svg";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}/>`)
      )
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["png"], { type: "image/png" }))
    );
    const size = await imageRasterSize(image);
    expect(size).toEqual({ width, height });
    const copy = await renderAnnotatedImage(image, size, []);
    expect(copy.width).toBe(width);
    expect(copy.height).toBe(height);
    expect(copy.blob.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, width, height);
    vi.unstubAllGlobals();
  }
);
