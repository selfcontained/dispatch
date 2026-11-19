import { describe, expect, it } from "vitest";
import { prominentLogoColor } from "./project-logo-color";

const pink = [236, 59, 128, 255];
const teal = [0, 145, 140, 255];
const gray = [128, 128, 128, 255];
const transparent = [0, 255, 0, 0];

function sample(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[]
) {
  const colors = Array.from({ length: width * height }, (_, index) =>
    pixel(index % width, Math.floor(index / width))
  );
  return prominentLogoColor({
    data: new Uint8ClampedArray(colors.flat()),
    width,
    height,
    colorSpace: "srgb",
  });
}

describe("prominentLogoColor", () => {
  it("returns the dominant saturated brand color and ignores transparent pixels", () => {
    expect(
      sample(6, 6, (x, y) => {
        if (y < 4) return transparent;
        return x < 4 ? pink : teal;
      })
    ).toBe("#ec3b80");
  });

  it("ignores grayscale, near-white and near-black pixels", () => {
    const colors = [
      gray,
      [255, 255, 255, 255],
      [0, 0, 0, 255],
      [40, 0, 0, 255],
    ];
    expect(sample(4, 4, (x) => colors[x]!)).toBeNull();
  });

  it("ignores a saturated flat background around artwork", () => {
    expect(sample(5, 5, (x, y) => (x === 2 && y === 2 ? pink : teal))).toBe(
      "#ec3b80"
    );
    expect(
      sample(5, 5, (x, y) => (x === 2 && y === 2 ? gray : teal))
    ).toBeNull();
  });

  it("lightens a saturated blue with poor visibility on dark surfaces", () => {
    const color = sample(4, 4, () => [0, 0, 255, 255]);
    expect(color).toMatch(/^#([1-9a-f][0-9a-f])\1ff$/);
  });
});
