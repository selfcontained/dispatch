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
    expect(rect.strokeColor).toBe("#1e1e1e"); // default ink
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

describe("applyWhiteboardOps: label auto-fit", () => {
  const CHAR_W = 11; // FONT_SIZE 20 * 0.55, mirrors the builder

  it("wraps a long label to the rect width and grows the height to fit", () => {
    const { elements, warnings, errors } = apply(
      [],
      [
        {
          op: "add",
          type: "rect",
          id: "r1",
          x: 0,
          y: 0,
          w: 160,
          h: 70,
          label: "streaming and heartbeat tool-layer reconcile plus tiering",
        },
      ]
    );
    expect(errors).toEqual([]);
    const rect = byId(elements, "r1");
    const label = byId(elements, rect.boundElements[0].id);
    expect(label.text).toContain("\n");
    expect(label.originalText).toBe(
      "streaming and heartbeat tool-layer reconcile plus tiering"
    );
    // Every wrapped line fits inside the rect's usable width (w - padding).
    expect(label.width).toBeLessThanOrEqual(160 - 10);
    // The rect grew tall enough that the text block fits vertically.
    expect(rect.width).toBe(160);
    expect(rect.height).toBeGreaterThan(70);
    expect(label.height).toBeLessThanOrEqual(rect.height - 10);
    // Label stays centered on the grown rect.
    expect(label.x + label.width / 2).toBeCloseTo(80, 0);
    expect(label.y + label.height / 2).toBeCloseTo(rect.height / 2, 0);
    expect(warnings.some((w) => w.includes('"r1" grew'))).toBe(true);
  });

  it("wraps ellipse labels at the narrower inscribed width", () => {
    const { elements } = apply(
      [],
      [
        {
          op: "add",
          type: "ellipse",
          id: "e1",
          w: 200,
          h: 100,
          label: "milestone gate review",
        },
      ]
    );
    const ellipse = byId(elements, "e1");
    const label = byId(elements, ellipse.boundElements[0].id);
    // Usable width for an ellipse is w/sqrt(2) - padding, not w - padding.
    expect(label.width).toBeLessThanOrEqual(Math.round(200 / Math.SQRT2) - 10);
  });

  it("grows the shape width for one unbreakable word", () => {
    const word = "tenant-isolation-tests"; // 22 chars ≈ 242px, box is 100
    const { elements, warnings } = apply(
      [],
      [{ op: "add", type: "rect", id: "r1", w: 100, h: 60, label: word }]
    );
    const rect = byId(elements, "r1");
    const label = byId(elements, rect.boundElements[0].id);
    expect(label.text).toBe(word); // no wrap, no hard break
    expect(rect.width).toBeGreaterThanOrEqual(word.length * CHAR_W + 10);
    expect(warnings.some((w) => w.includes('"r1" grew'))).toBe(true);
  });

  it("hard-breaks words wider than the auto-grow cap", () => {
    const word = "x".repeat(60); // 660px > MAX_AUTO_TEXT_WIDTH (440)
    const { elements } = apply(
      [],
      [{ op: "add", type: "rect", id: "r1", w: 100, h: 60, label: word }]
    );
    const rect = byId(elements, "r1");
    const label = byId(elements, rect.boundElements[0].id);
    expect(label.text).toContain("\n");
    expect(rect.width).toBeLessThanOrEqual(440 + 10);
    expect(label.width).toBeLessThanOrEqual(rect.width - 10);
  });

  it("re-wraps and re-grows when an update shrinks a labelled shape", () => {
    const first = apply(
      [],
      [
        {
          op: "add",
          type: "rect",
          id: "r1",
          w: 400,
          h: 80,
          label: "prompt caching and streaming heartbeat",
        },
      ]
    );
    expect(first.warnings).toEqual([]);
    const { elements, warnings } = apply(first.elements, [
      { op: "update", id: "r1", w: 160 },
    ]);
    const rect = byId(elements, "r1");
    const label = byId(elements, rect.boundElements[0].id);
    expect(label.text).toContain("\n");
    expect(label.width).toBeLessThanOrEqual(160 - 10);
    expect(rect.height).toBeGreaterThan(80);
    expect(warnings.some((w) => w.includes('"r1" grew'))).toBe(true);
  });

  it("reroutes bound arrows when a label update grows the shape", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 120, h: 60 },
        { op: "add", type: "rect", id: "b", x: 400, y: 0, w: 120, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
      ]
    );
    const arrowBefore = byId(first.elements, "ab");
    const { elements } = apply(first.elements, [
      {
        op: "update",
        id: "a",
        label: "an unreasonably wordy service name that must wrap",
      },
    ]);
    const arrowAfter = byId(elements, "ab");
    expect(byId(elements, "a").height).toBeGreaterThan(60);
    expect(arrowAfter.version).toBeGreaterThan(arrowBefore.version);
    // Re-anchored on the grown shape's edge, still pointing at b's center.
    expect(arrowAfter.y).toBeGreaterThan(arrowBefore.y);
  });

  it("wraps arrow labels without resizing the arrow", () => {
    const { elements, warnings } = apply(
      [],
      [
        {
          op: "add",
          type: "arrow",
          id: "ar",
          x: 0,
          y: 0,
          w: 100,
          h: 0,
          label: "proposed fold across both delivery bands for later",
        },
      ]
    );
    const arrow = byId(elements, "ar");
    expect(arrow.width).toBe(100);
    expect(arrow.height).toBe(0);
    const label = byId(elements, arrow.boundElements[0].id);
    expect(label.text).toContain("\n");
    expect(warnings).toEqual([]);
  });

  it("emits no warnings when labels fit as given", () => {
    const { warnings } = apply(
      [],
      [
        { op: "add", type: "rect", id: "r1", w: 160, h: 70, label: "api" },
        {
          op: "add",
          type: "rect",
          id: "r2",
          x: 240,
          y: 0,
          w: 160,
          h: 70,
          label: "db",
        },
      ]
    );
    expect(warnings).toEqual([]);
  });
});

describe("applyWhiteboardOps: overlap warnings", () => {
  it("warns when a new shape partially overlaps an existing one", () => {
    const first = apply(
      [],
      [{ op: "add", type: "rect", id: "a", x: 0, y: 0, w: 160, h: 70 }]
    );
    const { warnings } = apply(first.elements, [
      { op: "add", type: "rect", id: "b", x: 100, y: 30, w: 160, h: 70 },
    ]);
    expect(warnings.some((w) => w.includes('"b" overlaps "a"'))).toBe(true);
  });

  it("stays quiet for full containment and clean layouts", () => {
    const first = apply(
      [],
      [{ op: "add", type: "rect", id: "outer", x: 0, y: 0, w: 400, h: 300 }]
    );
    const { warnings } = apply(first.elements, [
      { op: "add", type: "rect", id: "inner", x: 50, y: 50, w: 100, h: 60 },
      { op: "add", type: "rect", id: "aside", x: 500, y: 0, w: 100, h: 60 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("warns when moving an element onto another", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 160, h: 70 },
        { op: "add", type: "rect", id: "b", x: 300, y: 0, w: 160, h: 70 },
      ]
    );
    const { warnings } = apply(first.elements, [
      { op: "update", id: "b", x: 80, y: 20 },
    ]);
    expect(warnings.some((w) => w.includes("overlaps"))).toBe(true);
  });
});

describe("applyWhiteboardOps: arrow labels", () => {
  it("warns when an arrow label lands on an unrelated shape", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 100, w: 120, h: 60 },
        { op: "add", type: "rect", id: "b", x: 800, y: 100, w: 120, h: 60 },
        // Sits exactly at the a→b midpoint, where the label will land.
        { op: "add", type: "rect", id: "mid", x: 400, y: 100, w: 140, h: 60 },
      ]
    );
    const { warnings } = apply(first.elements, [
      {
        op: "add",
        type: "arrow",
        id: "ab",
        from: "a",
        to: "b",
        label: "flows",
      },
    ]);
    expect(
      warnings.some((w) => w.includes('label of "ab"') && w.includes('"mid"'))
    ).toBe(true);
  });

  it("does not flag an arrow label near its own endpoints", () => {
    const { warnings } = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 100, w: 120, h: 60 },
        { op: "add", type: "rect", id: "b", x: 200, y: 100, w: 120, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b", label: "go" },
      ]
    );
    expect(warnings.filter((w) => w.includes("overlaps"))).toEqual([]);
  });

  it("moves an arrow's label along when a shape move reroutes the arrow", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 120, h: 60 },
        { op: "add", type: "rect", id: "b", x: 400, y: 0, w: 120, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b", label: "go" },
      ]
    );
    const arrow = byId(first.elements, "ab");
    const labelId = arrow.boundElements.find(
      (r: { type: string }) => r.type === "text"
    ).id;
    const labelBefore = byId(first.elements, labelId);
    const { elements } = apply(first.elements, [
      { op: "update", id: "b", x: 400, y: 600 },
    ]);
    const labelAfter = byId(elements, labelId);
    expect(labelAfter.y).toBeGreaterThan(labelBefore.y);
    // Still centered on the rerouted arrow's bounding box.
    const after = byId(elements, "ab");
    expect(labelAfter.x + labelAfter.width / 2).toBeCloseTo(
      after.x + after.width / 2,
      0
    );
  });
});

describe("applyWhiteboardOps: stroke style, fill, arrowheads", () => {
  it("applies dashed/dotted strokes on add and update", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "r", style: "dashed" },
        { op: "add", type: "arrow", id: "a", x: 0, y: 0, style: "dotted" },
      ]
    );
    expect(byId(first.elements, "r").strokeStyle).toBe("dashed");
    expect(byId(first.elements, "a").strokeStyle).toBe("dotted");
    const { elements } = apply(first.elements, [
      { op: "update", id: "r", style: "solid" },
    ]);
    expect(byId(elements, "r").strokeStyle).toBe("solid");
  });

  it("fills shapes with named tints, hex, and transparent; rejects junk", () => {
    const { elements, errors } = apply(
      [],
      [
        { op: "add", type: "rect", id: "r1", fill: "violet" },
        { op: "add", type: "ellipse", id: "e1", fill: "#123456" },
        { op: "add", type: "diamond", id: "d1", fill: "transparent" },
        { op: "add", type: "rect", id: "bad", fill: "plaid" },
      ]
    );
    expect(byId(elements, "r1").backgroundColor).toBe("#e5dbff");
    expect(byId(elements, "e1").backgroundColor).toBe("#123456");
    expect(byId(elements, "d1").backgroundColor).toBe("transparent");
    expect(errors).toEqual(['ops[3]: unknown fill "plaid".']);
  });

  it("rejects fill on arrows and heads on non-arrows", () => {
    const { errors } = apply(
      [],
      [
        { op: "add", type: "arrow", id: "a", fill: "red" },
        { op: "add", type: "rect", id: "r", endHead: "dot" },
        { op: "add", type: "rect", id: "r2", via: [[1, 2]] },
      ]
    );
    expect(errors).toEqual([
      "ops[0]: fill only applies to rect/ellipse/diamond.",
      "ops[1]: startHead/endHead only apply to arrows.",
      "ops[2]: via/elbow only apply to arrows and lines.",
    ]);
  });

  it("sets custom arrowheads on add and update", () => {
    const first = apply(
      [],
      [
        {
          op: "add",
          type: "arrow",
          id: "a",
          startHead: "dot",
          endHead: "triangle",
        },
      ]
    );
    const arrow = byId(first.elements, "a");
    expect(arrow.startArrowhead).toBe("dot");
    expect(arrow.endArrowhead).toBe("triangle");
    const { elements } = apply(first.elements, [
      { op: "update", id: "a", startHead: "none", endHead: "bar" },
    ]);
    expect(byId(elements, "a").startArrowhead).toBeNull();
    expect(byId(elements, "a").endArrowhead).toBe("bar");
  });
});

describe("applyWhiteboardOps: arrow bends (via) and elbow routing", () => {
  it("builds a curved multi-point arrow from via waypoints", () => {
    const { elements, errors } = apply(
      [],
      [
        {
          op: "add",
          type: "arrow",
          id: "a",
          x: 0,
          y: 0,
          w: 200,
          h: 0,
          via: [[100, 80]],
        },
      ]
    );
    expect(errors).toEqual([]);
    const arrow = byId(elements, "a");
    expect(arrow.points).toEqual([
      [0, 0],
      [100, 80],
      [200, 0],
    ]);
    expect(arrow.width).toBe(200);
    expect(arrow.height).toBe(80); // bbox extent, not endpoint dy
    expect(arrow.roundness).toEqual({ type: 2 }); // smooth bends
  });

  it("aims bound endpoints at the nearest bend, not the far element", () => {
    const { elements } = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 100 },
        { op: "add", type: "rect", id: "b", x: 400, y: 0, w: 100, h: 100 },
        {
          op: "add",
          type: "arrow",
          id: "ab",
          from: "a",
          to: "b",
          via: [[250, 300]],
        },
      ]
    );
    const arrow = byId(elements, "ab");
    // Bend is below both boxes, so the arrow leaves a's bottom half, not its
    // right edge midpoint (which aiming at b's center would produce).
    expect(arrow.y).toBeGreaterThan(50);
    expect(arrow.points.length).toBe(3);
  });

  it("routes elbow arrows orthogonally between boxes and stamps customData", () => {
    const { elements } = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 400, y: 300, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b", elbow: true },
      ]
    );
    const arrow = byId(elements, "ab");
    expect(arrow.customData.elbow).toBe(true);
    expect(arrow.roundness).toBeNull(); // elbows stay crisp
    const pts = arrow.points as number[][];
    expect(pts.length).toBe(4);
    // Every segment is axis-aligned.
    for (let i = 1; i < pts.length; i++) {
      const straight =
        pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1];
      expect(straight, `segment ${i}`).toBe(true);
    }
    // Leaves a's right edge, enters b's left edge.
    expect(arrow.x).toBe(100);
    expect(arrow.y).toBe(30);
    expect(arrow.x + pts[3][0]).toBe(400);
    expect(arrow.y + pts[3][1]).toBe(330);
  });

  it("re-routes elbow arrows orthogonally when a bound shape moves", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 400, y: 300, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b", elbow: true },
      ]
    );
    const { elements } = apply(first.elements, [
      { op: "update", id: "b", x: 0, y: 500 },
    ]);
    const arrow = byId(elements, "ab");
    const pts = arrow.points as number[][];
    for (let i = 1; i < pts.length; i++) {
      const straight =
        pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1];
      expect(straight, `segment ${i}`).toBe(true);
    }
    // Now stacked vertically: leaves a's bottom edge.
    expect(arrow.x).toBe(50);
    expect(arrow.y).toBe(60);
  });

  it("keeps hand-set bends in place when a bound shape moves", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 100 },
        { op: "add", type: "rect", id: "b", x: 400, y: 0, w: 100, h: 100 },
        {
          op: "add",
          type: "arrow",
          id: "ab",
          from: "a",
          to: "b",
          via: [[250, 300]],
        },
      ]
    );
    const before = byId(first.elements, "ab");
    const bendBefore = {
      x: before.x + before.points[1][0],
      y: before.y + before.points[1][1],
    };
    const { elements } = apply(first.elements, [
      { op: "update", id: "b", x: 600, y: 200 },
    ]);
    const after = byId(elements, "ab");
    expect(after.points.length).toBe(3);
    expect(after.x + after.points[1][0]).toBeCloseTo(bendBefore.x, 5);
    expect(after.y + after.points[1][1]).toBeCloseTo(bendBefore.y, 5);
  });

  it("adds and removes bends via update", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 100 },
        { op: "add", type: "rect", id: "b", x: 400, y: 0, w: 100, h: 100 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
      ]
    );
    const bent = apply(first.elements, [
      { op: "update", id: "ab", via: [[250, 250]] },
    ]);
    const arrow = byId(bent.elements, "ab");
    expect(arrow.points.length).toBe(3);
    expect(arrow.roundness).toEqual({ type: 2 });
    const straightened = apply(bent.elements, [
      { op: "update", id: "ab", via: [] },
    ]);
    const back = byId(straightened.elements, "ab");
    expect(back.points.length).toBe(2);
    expect(back.roundness).toBeNull();
  });

  it("recenters an arrow label on its bent path midpoint", () => {
    const { elements } = apply(
      [],
      [
        {
          op: "add",
          type: "arrow",
          id: "a",
          x: 0,
          y: 0,
          w: 200,
          h: 0,
          via: [[100, 200]],
          label: "hop",
        },
      ]
    );
    const arrow = byId(elements, "a");
    const labelId = arrow.boundElements.find(
      (r: { type: string }) => r.type === "text"
    ).id;
    const label = byId(elements, labelId);
    // Bbox is 200x200 starting at (0,0); center is (100, 100).
    expect(label.x + label.width / 2).toBeCloseTo(100, 0);
    expect(label.y + label.height / 2).toBeCloseTo(100, 0);
  });
});

describe("applyWhiteboardOps: arrow crossing warnings", () => {
  const crossings = (warnings: string[]) =>
    warnings.filter((w) => w.includes("passes through"));

  it("warns when a straight arrow slices through an unrelated box", () => {
    const { warnings } = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 100, w: 100, h: 60 },
        { op: "add", type: "rect", id: "mid", x: 300, y: 100, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 600, y: 100, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
      ]
    );
    expect(crossings(warnings)).toEqual([
      '"ab" passes through "mid" — reroute it around (elbow:true or via ' +
        "bend points) or move one of them.",
    ]);
  });

  it("stays quiet for bound endpoints and arrows routed around", () => {
    const { warnings } = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 100, w: 100, h: 60 },
        { op: "add", type: "rect", id: "mid", x: 300, y: 100, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 600, y: 100, w: 100, h: 60 },
        {
          op: "add",
          type: "arrow",
          id: "ab",
          from: "a",
          to: "b",
          via: [[350, 320]],
        },
      ]
    );
    expect(crossings(warnings)).toEqual([]);
  });

  it("warns when a shape is moved onto an existing arrow's path", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 100, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 600, y: 100, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
        { op: "add", type: "rect", id: "float", x: 300, y: 500, w: 100, h: 60 },
      ]
    );
    expect(crossings(first.warnings)).toEqual([]);
    const { warnings } = apply(first.elements, [
      { op: "update", id: "float", x: 300, y: 100 },
    ]);
    expect(crossings(warnings)).toEqual([
      '"ab" passes through "float" — reroute it around (elbow:true or via ' +
        "bend points) or move one of them.",
    ]);
  });

  it("clears the warning once the arrow is rerouted with via", () => {
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 100, w: 100, h: 60 },
        { op: "add", type: "rect", id: "mid", x: 300, y: 100, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 600, y: 100, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b" },
      ]
    );
    expect(crossings(first.warnings)).toHaveLength(1);
    const { warnings } = apply(first.elements, [
      { op: "update", id: "ab", via: [[350, 350]] },
    ]);
    expect(crossings(warnings)).toEqual([]);
  });

  it("checks every segment of a bent arrow, not just the chord", () => {
    const { warnings } = apply(
      [],
      [
        { op: "add", type: "rect", id: "box", x: 300, y: 300, w: 100, h: 60 },
        {
          op: "add",
          type: "arrow",
          id: "hook",
          x: 0,
          y: 0,
          w: 700,
          h: 0,
          // Endpoints' straight chord misses the box; the bend dips into it.
          via: [[350, 330]],
        },
      ]
    );
    expect(crossings(warnings)).toHaveLength(1);
  });
});

describe("applyWhiteboardOps: connectors render beneath shapes", () => {
  it("moves agent arrows to the front of the element list", () => {
    const { elements } = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 60 },
        { op: "add", type: "rect", id: "b", x: 300, y: 0, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ab", from: "a", to: "b", label: "x" },
      ]
    );
    const ids = (elements as El[]).map((e) => e.id);
    expect(ids[0]).toBe("ab"); // connector at the back of the z-order
    // Its label stays above the shapes, at its original position.
    expect(ids.indexOf("a")).toBeLessThan(
      ids.findIndex((id) => byId(elements, id as string).containerId === "ab")
    );
  });

  it("nulls the fractional index of displaced connectors only", () => {
    // Simulate a scene the editor already indexed: shape then arrow.
    const first = apply(
      [],
      [
        { op: "add", type: "rect", id: "a", x: 0, y: 0, w: 100, h: 60 },
        { op: "add", type: "arrow", id: "ar", x: 200, y: 200, w: 100, h: 0 },
      ]
    );
    const els = first.elements as El[];
    const indexed = [
      { ...byId(els, "a"), index: "a0" },
      { ...byId(els, "ar"), index: "a1" },
    ];
    const { elements } = apply(indexed, [{ op: "update", id: "a", x: 10 }]);
    const ids = (elements as El[]).map((e) => e.id);
    expect(ids[0]).toBe("ar");
    expect(byId(elements, "ar").index).toBeNull(); // editor re-assigns
    expect(byId(elements, "a").index).toBe("a0"); // user order untouched
  });

  it("leaves user-drawn arrows where the user put them", () => {
    const userArrow = {
      id: "user-arrow",
      type: "arrow",
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      points: [
        [0, 0],
        [100, 0],
      ],
      isDeleted: false,
    };
    const { elements } = apply(
      [userArrow],
      [{ op: "add", type: "rect", id: "r", x: 300, y: 300, w: 100, h: 60 }]
    );
    const ids = (elements as El[]).map((e) => e.id);
    expect(ids).toEqual(["user-arrow", "r"]);
  });
});

// The builder mirrors Excalidraw internals captured from a specific version;
// force a re-verification of those formulas whenever the web pin moves.
describe("excalidraw capture version", () => {
  it("matches the @excalidraw/excalidraw pin in apps/web", async () => {
    const { EXCALIDRAW_CAPTURE_VERSION } =
      await import("../src/shared/whiteboard-builder.js");
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(
      await readFile(new URL("../../web/package.json", import.meta.url), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@excalidraw/excalidraw"]).toBe(
      EXCALIDRAW_CAPTURE_VERSION
    );
  });
});
