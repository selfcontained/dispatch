import { describe, expect, it } from "vitest";

import { computeCropRegion, stripDataUrlPrefix } from "./screenshot";

const rect = (
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } => ({
  x,
  y,
  width,
  height,
});

describe("computeCropRegion", () => {
  it("scales the rect by the device pixel ratio", () => {
    const region = computeCropRegion(rect(10, 20, 100, 50), 2, 1000, 1000);
    expect(region).toEqual({
      sx: 20,
      sy: 40,
      sw: 200,
      sh: 100,
      dw: 200,
      dh: 100,
    });
  });

  it("treats a non-positive ratio as 1", () => {
    const region = computeCropRegion(rect(0, 0, 100, 100), 0, 1000, 1000);
    expect(region).toMatchObject({ sx: 0, sy: 0, sw: 100, sh: 100 });
  });

  it("clamps a rect that extends past the captured image", () => {
    const region = computeCropRegion(rect(900, 900, 400, 400), 1, 1000, 1000);
    expect(region).toEqual({
      sx: 900,
      sy: 900,
      sw: 100,
      sh: 100,
      dw: 100,
      dh: 100,
    });
  });

  it("clamps negative offsets to the image origin", () => {
    const region = computeCropRegion(rect(-50, -30, 200, 100), 1, 1000, 1000);
    expect(region).toMatchObject({ sx: 0, sy: 0, sw: 150, sh: 70 });
  });

  it("returns null when the element has no visible area", () => {
    expect(
      computeCropRegion(rect(2000, 2000, 100, 100), 1, 1000, 1000)
    ).toBeNull();
    expect(computeCropRegion(rect(0, 0, 0, 100), 1, 1000, 1000)).toBeNull();
  });

  it("downscales crops larger than the max dimension", () => {
    const region = computeCropRegion(
      rect(0, 0, 3200, 1600),
      1,
      4000,
      4000,
      1600
    );
    expect(region).toMatchObject({ sw: 3200, sh: 1600, dw: 1600, dh: 800 });
  });

  it("never enlarges crops smaller than the max dimension", () => {
    const region = computeCropRegion(rect(0, 0, 100, 50), 1, 1000, 1000, 1600);
    expect(region).toMatchObject({ dw: 100, dh: 50 });
  });
});

describe("stripDataUrlPrefix", () => {
  it("removes the data-url prefix", () => {
    expect(stripDataUrlPrefix("data:image/png;base64,AAAB")).toBe("AAAB");
  });

  it("returns an empty string when there is no comma", () => {
    expect(stripDataUrlPrefix("not-a-data-url")).toBe("");
  });
});
