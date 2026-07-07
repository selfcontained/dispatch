import { describe, expect, it } from "vitest";

import {
  applyWhiteboardOps,
  type WhiteboardOp,
} from "../src/shared/whiteboard-builder.js";

type El = Record<string, any>;

function apply(existing: unknown[], ops: WhiteboardOp[]) {
  return applyWhiteboardOps(existing, ops);
}

function byId(elements: unknown[], id: string): El {
  const el = (elements as El[]).find((e) => e.id === id);
  expect(el, `element ${id}`).toBeDefined();
  return el as El;
}

// Field shape mirrors convertToExcalidrawElements output (captured from the
// real editor during Spike A); these tests pin the contract.
const BASE_FIELDS = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "frameId",
  "index",
  "roundness",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "boundElements",
  "updated",
  "link",
  "locked",
];

describe("applyWhiteboardOps: add", () => {
  it("creates a rectangle with every base field and the agent author stamp", () => {
    const { elements, created, errors } = apply(
      [],
      [{ op: "add", type: "rect", id: "r1", x: 10, y: 20, w: 160, h: 70 }]
    );
    expect(errors).toEqual([]);
    expect(created).toEqual([{ id: "r1", type: "rect" }]);
    const rect = byId(elements, "r1");
    for (const field of BASE_FIELDS) {
      expect(rect, field).toHaveProperty(field);
    }
    expect(rect.type).toBe("rectangle");
    expect(rect.customData).toEqual({ author: "agent" });
    expect(rect.strokeColor).toBe("#6741d9"); // signature ink default
    expect(rect.index).toBeNull(); // editor assigns fractional indices
    expect(rect.isDeleted).toBe(false);
  });

  it("creates a bound, centered label text element for labelled shapes", () => {
    const { elements } = apply(
      [],
      [
        {
          op: "add",
          type: "rect",
          id: "r1",
          x: 0,
          y: 0,
          w: 200,
          h: 100,
          label: "api",
        },
      ]
    );
    expect(elements).toHaveLength(2);
    const rect = byId(elements, "r1");
    const labelRef = rect.boundElements?.[0];
    expect(labelRef?.type).toBe("text");
    const label = byId(elements, labelRef.id);
    expect(label.containerId).toBe("r1");
    expect(label.originalText).toBe("api");
    expect(label.fontFamily).toBe(5);
    expect(label.textAlign).toBe("center");
    expect(label.verticalAlign).toBe("middle");
    // Centered on the container.
    expect(label.x + label.width / 2).toBeCloseTo(100, 0);
    expect(label.y + label.height / 2).toBeCloseTo(50, 0);
  });

  it("binds arrows to from/to elements and back-references them", () => {
    const { elements, errors } = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 300, y: 0, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
      ]
    );
    expect(errors).toEqual([]);
    const arrow = byId(elements, "ab");
    expect(arrow.startBinding).toMatchObject({ elementId: "a" });
    expect(arrow.endBinding).toMatchObject({ elementId: "b" });
    expect(arrow.elbowed).toBe(false);
    expect(arrow.endArrowhead).toBe("arrow");
    expect(arrow.points).toHaveLength(2);
    // The arrow spans the gap between the shapes' facing edges.
    expect(arrow.x).toBeGreaterThanOrEqual(100);
    expect(arrow.x + arrow.points[1][0]).toBeLessThanOrEqual(300);
    for (const shapeId of ["a", "b"]) {
      const refs = byId(elements, shapeId).boundElements as El[];
      expect(refs.some((r) => r.id === "ab" && r.type === "arrow")).toBe(true);
    }
  });

  it("supports named colors, hex colors, and rejects junk", () => {
    const { elements, errors } = apply(
      [],
      [
        { op: "add", type: "rect", id: "g", color: "green" },
        { op: "add", type: "rect", id: "h", color: "#123abc" },
        { op: "add", type: "rect", id: "bad", color: "chartreuse-ish" },
      ]
    );
    expect(byId(elements, "g").strokeColor).toBe("#2f9e44");
    expect(byId(elements, "h").strokeColor).toBe("#123abc");
    expect(errors).toHaveLength(1);
    expect((elements as El[]).some((e) => e.id === "bad")).toBe(false);
  });

  it("rejects duplicate and malformed ids", () => {
    const { errors } = apply(
      [],
      [
        { op: "add", type: "rect", id: "dup" },
        { op: "add", type: "rect", id: "dup" },
        { op: "add", type: "rect", id: "bad id!" },
      ]
    );
    expect(errors).toHaveLength(2);
  });

  it("errors on arrows pointing at unknown elements", () => {
    const { errors, created } = apply(
      [],
      [{ op: "add", type: "arrow", id: "a1", from: "ghost", to: "spirit" }]
    );
    expect(errors).toHaveLength(1);
    expect(created).toEqual([]);
  });

  it("creates standalone text and frames", () => {
    const { elements, errors } = apply(
      [],
      [
        { op: "add", type: "text", id: "t1", x: 5, y: 5, label: "hi\nthere" },
        {
          op: "add",
          type: "frame",
          id: "f1",
          x: 0,
          y: 0,
          w: 300,
          h: 200,
          label: "proposal",
        },
        { op: "add", type: "text", id: "t2", x: 5, y: 5 },
      ]
    );
    const text = byId(elements, "t1");
    expect(text.text).toBe("hi\nthere");
    expect(text.height).toBeGreaterThan(25); // two lines
    expect(byId(elements, "f1").name).toBe("proposal");
    expect(errors).toHaveLength(1); // text without label
  });
});

describe("applyWhiteboardOps: update", () => {
  it("moves geometry, bumps version, and re-centers the bound label", () => {
    const first = apply(
      [],
      [
        {
          op: "add",
          type: "rect",
          id: "r1",
          x: 0,
          y: 0,
          w: 100,
          h: 60,
          label: "hey",
        },
      ]
    );
    const before = byId(first.elements, "r1");
    const { elements, errors } = apply(first.elements, [
      { op: "update", id: "r1", x: 500, y: 500 },
    ]);
    expect(errors).toEqual([]);
    const rect = byId(elements, "r1");
    expect(rect.x).toBe(500);
    expect(rect.version).toBe(before.version + 1);
    expect(rect.versionNonce).not.toBe(before.versionNonce);
    const label = byId(elements, rect.boundElements[0].id);
    expect(label.x + label.width / 2).toBeCloseTo(550, 0);
    expect(label.y + label.height / 2).toBeCloseTo(530, 0);
  });

  it("updates label text in place and adds one when missing", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", label: "old" },
        { op: "add", type: "rect", id: "b" },
      ]
    );
    const { elements, errors } = apply(first.elements, [
      { op: "update", id: "a", label: "new" },
      { op: "update", id: "b", label: "fresh" },
    ]);
    expect(errors).toEqual([]);
    const aLabel = byId(elements, byId(elements, "a").boundElements[0].id);
    expect(aLabel.text).toBe("new");
    const bLabel = byId(elements, byId(elements, "b").boundElements[0].id);
    expect(bLabel.text).toBe("fresh");
    // No duplicate label was created for `a`.
    expect(
      (elements as El[]).filter((e) => e.containerId === "a" && !e.isDeleted)
    ).toHaveLength(1);
  });

  it("errors on unknown target", () => {
    const { errors } = apply([], [{ op: "update", id: "nope", x: 1 }]);
    expect(errors).toHaveLength(1);
  });

  it("re-routes bound arrows when a shape moves", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 300, y: 0, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
      ]
    );
    const { elements, errors } = apply(first.elements, [
      { op: "update", id: "b", x: 600, y: 400 },
    ]);
    expect(errors).toEqual([]);
    const arrow = byId(elements, "ab");
    const endX = arrow.x + arrow.points[1][0];
    const endY = arrow.y + arrow.points[1][1];
    // Arrow now terminates at the moved shape's bounding box, not the old spot.
    expect(endX).toBeGreaterThanOrEqual(590);
    expect(endX).toBeLessThanOrEqual(710);
    expect(endY).toBeGreaterThanOrEqual(390);
    expect(endY).toBeLessThanOrEqual(470);
    expect(arrow.startBinding).toMatchObject({ elementId: "a" });
    expect(arrow.endBinding).toMatchObject({ elementId: "b" });
  });
});

describe("applyWhiteboardOps: delete", () => {
  it("soft-deletes the shape, its label, and unbinds attached arrows", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, label: "a" },
        { op: "add", type: "rect", id: "b", x: 300, y: 0 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
      ]
    );
    const { elements, errors } = apply(first.elements, [
      { op: "delete", id: "a" },
    ]);
    expect(errors).toEqual([]);
    expect(byId(elements, "a").isDeleted).toBe(true);
    const label = (elements as El[]).find((e) => e.containerId === "a");
    expect(label?.isDeleted).toBe(true);
    const arrow = byId(elements, "ab");
    expect(arrow.isDeleted).toBe(false);
    expect(arrow.startBinding).toBeNull();
    expect(arrow.endBinding).toMatchObject({ elementId: "b" });
  });

  it("deleting an arrow scrubs back-references from bound shapes", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a" },
        { op: "add", type: "rect", id: "b", x: 300 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
      ]
    );
    const { elements } = apply(first.elements, [{ op: "delete", id: "ab" }]);
    expect(byId(elements, "ab").isDeleted).toBe(true);
    for (const id of ["a", "b"]) {
      const refs = (byId(elements, id).boundElements ?? []) as El[];
      expect(refs.some((r) => r.id === "ab")).toBe(false);
    }
  });

  it("deleting a frame frees its children", () => {
    const first = apply(
      [],
      [{ op: "add", type: "frame", id: "f", x: 0, y: 0, w: 400, h: 300 }]
    );
    // Simulate an element the editor put inside the frame.
    const child = {
      ...(first.elements[0] as El),
      id: "kid",
      type: "rectangle",
      frameId: "f",
      name: undefined,
    };
    const { elements } = apply(
      [...first.elements, child],
      [{ op: "delete", id: "f" }]
    );
    expect(byId(elements, "f").isDeleted).toBe(true);
    expect(byId(elements, "kid").frameId).toBeNull();
    expect(byId(elements, "kid").isDeleted).toBe(false);
  });
});

describe("applyWhiteboardOps: existing scene preservation", () => {
  it("leaves untouched user elements exactly as they were", () => {
    const userElement = {
      id: "user1",
      type: "freedraw",
      x: 1,
      y: 2,
      width: 30,
      height: 40,
      version: 7,
      versionNonce: 42,
      isDeleted: false,
      points: [
        [0, 0],
        [1, 1],
      ],
    };
    const { elements } = apply(
      [userElement],
      [{ op: "add", type: "rect", id: "r1" }]
    );
    expect(elements[0]).toEqual(userElement);
    expect(elements).toHaveLength(2);
  });
});
