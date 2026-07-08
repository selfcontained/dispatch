import { describe, expect, it } from "vitest";

import { simplifyElements } from "../src/shared/whiteboard.js";
import { isValidScene } from "../src/shared/whiteboard-store.js";

describe("simplifyElements", () => {
  it("keeps geometry, text, and bindings while stripping style noise", () => {
    const raw = [
      {
        id: "rect1",
        type: "rectangle",
        x: 10.7,
        y: 20.2,
        width: 200,
        height: 90,
        angle: 0,
        strokeColor: "#846358",
        backgroundColor: "transparent",
        seed: 12345,
        versionNonce: 99999,
        isDeleted: false,
      },
      {
        id: "label1",
        type: "text",
        x: 50,
        y: 40,
        width: 70,
        height: 25,
        text: "Web UI",
        containerId: "rect1",
        strokeColor: "#846358",
      },
      {
        id: "arrow1",
        type: "arrow",
        x: 0,
        y: 0,
        width: 100,
        height: 0,
        startBinding: { elementId: "rect1", focus: 0, gap: 5 },
        endBinding: { elementId: "rect2", focus: 0, gap: 5 },
      },
    ];

    const out = simplifyElements(raw);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      id: "rect1",
      type: "rectangle",
      x: 11,
      y: 20,
      width: 200,
      height: 90,
      strokeColor: "#846358",
    });
    expect(out[1].text).toBe("Web UI");
    expect(out[1].containerId).toBe("rect1");
    expect(out[2].from).toBe("rect1");
    expect(out[2].to).toBe("rect2");
    expect(out[0]).not.toHaveProperty("seed");
    expect(out[0]).not.toHaveProperty("versionNonce");
    expect(out[0]).not.toHaveProperty("backgroundColor");
  });

  it("drops deleted elements and tolerates malformed entries", () => {
    const out = simplifyElements([
      { id: "gone", type: "rectangle", isDeleted: true },
      null,
      "junk",
      { id: "ok", type: "ellipse", x: 1, y: 2, width: 3, height: 4 },
    ]);
    expect(out.map((e) => e.id)).toEqual(["ok"]);
  });
});

describe("isValidScene", () => {
  it("accepts an object with an elements array", () => {
    expect(isValidScene({ elements: [] })).toBe(true);
    expect(isValidScene({ elements: [{ type: "rectangle" }] })).toBe(true);
  });

  it("rejects non-objects and missing/oversized element lists", () => {
    expect(isValidScene(null)).toBe(false);
    expect(isValidScene("nope")).toBe(false);
    expect(isValidScene({})).toBe(false);
    expect(isValidScene({ elements: "x" })).toBe(false);
    expect(isValidScene({ elements: new Array(20_001).fill({}) })).toBe(false);
  });
});
