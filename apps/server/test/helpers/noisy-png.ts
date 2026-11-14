import { PNG } from "pngjs";

/** A PNG with noisy pixels, so a JPEG copy is reliably smaller than it. */
export function noisyPng(
  width: number,
  height: number,
  alpha: (x: number, y: number) => number = () => 255
): Buffer {
  const png = new PNG({ width, height });
  let seed = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      png.data[i] = (x * 7 + (seed & 0x3f)) & 0xff;
      png.data[i + 1] = (y * 5 + ((seed >> 6) & 0x3f)) & 0xff;
      png.data[i + 2] = ((x + y) * 3 + ((seed >> 12) & 0x3f)) & 0xff;
      png.data[i + 3] = alpha(x, y);
    }
  }
  return PNG.sync.write(png);
}
