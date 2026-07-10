import { describe, it, expect } from "vitest";

import { simplifyElements } from "../src/shared/whiteboard.js";

describe("simplifyElements", () => {
  it("extracts basic fields from shape records", () => {
    const records = [
      {
        id: "shape:abc",
        typeName: "shape",
        type: "geo",
        x: 10,
        y: 20,
        props: { w: 100, h: 50, color: "blue", fill: "solid" },
      },
    ];
    const result = simplifyElements(records);
    expect(result).toEqual([
      {
        id: "shape:abc",
        type: "geo",
        x: 10,
        y: 20,
        w: 100,
        h: 50,
        color: "blue",
        fill: "solid",
      },
    ]);
  });

  it("filters out non-shape records", () => {
    const records = [
      { id: "page:page", typeName: "page", type: "page", x: 0, y: 0 },
      {
        id: "shape:s1",
        typeName: "shape",
        type: "text",
        x: 0,
        y: 0,
        props: { w: 100, h: 50 },
      },
    ];
    const result = simplifyElements(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("shape:s1");
  });

  it("defaults coordinates and dimensions to 0 when missing", () => {
    const records = [
      {
        id: "shape:missing",
        typeName: "shape",
        type: "geo",
        props: {},
      },
    ];
    const result = simplifyElements(records);
    expect(result[0].x).toBe(0);
    expect(result[0].y).toBe(0);
    expect(result[0].w).toBe(0);
    expect(result[0].h).toBe(0);
  });

  it("omits label when not present", () => {
    const records = [
      {
        id: "shape:nolabel",
        typeName: "shape",
        type: "geo",
        x: 0,
        y: 0,
        props: { w: 100, h: 100 },
      },
    ];
    const result = simplifyElements(records);
    expect(result[0].label).toBeUndefined();
  });

  it("includes text label when present in props", () => {
    const records = [
      {
        id: "shape:withlabel",
        typeName: "shape",
        type: "text",
        x: 0,
        y: 0,
        props: { w: 100, h: 50, text: "Hello" },
      },
    ];
    const result = simplifyElements(records);
    expect(result[0].label).toBe("Hello");
  });

  it("returns empty array for empty input", () => {
    expect(simplifyElements([])).toEqual([]);
  });
});
