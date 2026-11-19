import { describe, expect, it } from "vitest";
import { prominentLogoColors } from "./project-logo-color";

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
  return prominentLogoColors({
    data: new Uint8ClampedArray(colors.flat()),
    width,
    height,
    colorSpace: "srgb",
  });
}

describe("prominentLogoColors", () => {
  it("returns the dominant saturated brand color and ignores transparent pixels", () => {
    expect(
      sample(6, 6, (x, y) => {
        if (y < 4) return transparent;
        return x < 4 ? pink : teal;
      })
    ).toEqual(["#ec3b80", "#00918c"]);
  });

  it("ignores grayscale, near-white and near-black pixels", () => {
    const colors = [
      gray,
      [255, 255, 255, 255],
      [0, 0, 0, 255],
      [40, 0, 0, 255],
    ];
    expect(sample(4, 4, (x) => colors[x]!)).toEqual([]);
  });

  it("ignores a saturated flat background around artwork", () => {
    expect(sample(5, 5, (x, y) => (x === 2 && y === 2 ? pink : teal))).toEqual([
      "#ec3b80",
    ]);
    expect(sample(5, 5, (x, y) => (x === 2 && y === 2 ? gray : teal))).toEqual(
      []
    );
  });

  it("returns up to three distinct colors in prominence order", () => {
    const bands = [
      ...Array(5).fill(pink),
      ...Array(4).fill(teal),
      ...Array(3).fill([200, 60, 88, 255]), // Adjacent to the pink hue.
      ...Array(2).fill([210, 110, 20, 255]),
      [50, 80, 190, 255],
    ];
    const palette = sample(15, 4, (x, y) =>
      y === 0 || y === 3 ? transparent : bands[x]
    );
    expect(palette).toEqual(["#ec3b80", "#00918c", "#d26e14"]);
  });

  it("preserves bright colors and gives a small distinct accent room beside a gradient", () => {
    const cyan = [20, 238, 245, 255];
    const purple = [208, 84, 255, 255];
    const yellow = [235, 235, 10, 255];
    const bands = [
      ...Array(12).fill(cyan),
      ...Array(8).fill([44, 148, 245, 255]),
      ...Array(5).fill(purple),
      yellow,
    ];
    expect(
      sample(bands.length, 4, (x, y) =>
        y === 0 || y === 3 ? transparent : bands[x]
      )
    ).toEqual(["#14eef5", "#d054ff", "#ebeb0a"]);
  });

  it("lightens a saturated blue with poor visibility on dark surfaces", () => {
    const color = sample(4, 4, () => [0, 0, 255, 255]);
    expect(color[0]).toMatch(/^#([1-9a-f][0-9a-f])\1ff$/);
  });
});
