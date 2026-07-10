import { describe, it, expect } from "vitest";

import { applyOps, makeShapeId } from "../src/shared/whiteboard-builder.js";
import type {
  WhiteboardOp,
  WhiteboardScene,
} from "../src/shared/whiteboard.js";

function emptyScene(): WhiteboardScene {
  return { records: [] };
}

describe("applyOps", () => {
  describe("add operations", () => {
    it("adds a rect shape", () => {
      const ops: WhiteboardOp[] = [
        {
          op: "add",
          type: "rect",
          id: "r1",
          x: 10,
          y: 20,
          w: 100,
          h: 50,
          label: "Box",
        },
      ];
      const result = applyOps(emptyScene(), ops);
      expect(result.records).toHaveLength(1);
      const shape = result.records[0];
      expect(shape.type).toBe("geo");
      expect((shape.props as Record<string, unknown>).geo).toBe("rectangle");
      expect(shape.x).toBe(10);
      expect(shape.y).toBe(20);
      expect((shape.props as Record<string, unknown>).w).toBe(100);
      expect((shape.props as Record<string, unknown>).h).toBe(50);
    });

    it("adds an ellipse shape", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "ellipse", id: "e1", x: 0, y: 0 },
      ];
      const result = applyOps(emptyScene(), ops);
      expect(result.records).toHaveLength(1);
      expect((result.records[0].props as Record<string, unknown>).geo).toBe(
        "ellipse"
      );
    });

    it("adds a diamond shape", () => {
      const ops: WhiteboardOp[] = [{ op: "add", type: "diamond", id: "d1" }];
      const result = applyOps(emptyScene(), ops);
      expect(result.records).toHaveLength(1);
      expect((result.records[0].props as Record<string, unknown>).geo).toBe(
        "diamond"
      );
    });

    it("adds a text shape", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "text", id: "t1", label: "Hello world" },
      ];
      const result = applyOps(emptyScene(), ops);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].type).toBe("text");
      const richText = (result.records[0].props as Record<string, unknown>)
        .richText as {
        content: Array<{ content: Array<{ text: string }> }>;
      };
      expect(richText.content[0].content[0].text).toBe("Hello world");
    });

    it("adds an arrow shape with bindings", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "rect", id: "a", x: 0, y: 0 },
        { op: "add", type: "rect", id: "b", x: 300, y: 0 },
        { op: "add", type: "arrow", id: "arr1", from: "a", to: "b" },
      ];
      const result = applyOps(emptyScene(), ops);
      expect(result.records).toHaveLength(3);
      const arrow = result.records[2];
      expect(arrow.type).toBe("arrow");
      const props = arrow.props as Record<string, unknown>;
      expect((props.start as Record<string, unknown>).type).toBe("binding");
      expect((props.end as Record<string, unknown>).type).toBe("binding");
    });

    it("adds an arrow shape with point coordinates", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "arrow", id: "arr2", x: 10, y: 20, w: 200, h: 100 },
      ];
      const result = applyOps(emptyScene(), ops);
      const props = result.records[0].props as Record<string, unknown>;
      expect((props.start as Record<string, unknown>).type).toBe("point");
      expect((props.end as Record<string, unknown>).type).toBe("point");
    });

    it("adds a frame shape", () => {
      const ops: WhiteboardOp[] = [
        {
          op: "add",
          type: "frame",
          id: "f1",
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          label: "Section",
        },
      ];
      const result = applyOps(emptyScene(), ops);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].type).toBe("frame");
      expect((result.records[0].props as Record<string, unknown>).name).toBe(
        "Section"
      );
    });

    it("adds a line shape (arrow with no arrowheads)", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "line", id: "l1", x: 0, y: 0, w: 100, h: 100 },
      ];
      const result = applyOps(emptyScene(), ops);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].type).toBe("arrow");
      const props = result.records[0].props as Record<string, unknown>;
      expect(props.arrowheadStart).toBe("none");
      expect(props.arrowheadEnd).toBe("none");
    });

    it("uses default dimensions when not specified", () => {
      const ops: WhiteboardOp[] = [{ op: "add", type: "rect", id: "def1" }];
      const result = applyOps(emptyScene(), ops);
      const props = result.records[0].props as Record<string, unknown>;
      expect(props.w).toBe(200);
      expect(props.h).toBe(200);
    });
  });

  describe("color/fill/style resolution", () => {
    it("resolves valid colors", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "rect", id: "c1", color: "blue" },
      ];
      const result = applyOps(emptyScene(), ops);
      expect((result.records[0].props as Record<string, unknown>).color).toBe(
        "blue"
      );
    });

    it("defaults invalid colors to black", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "rect", id: "c2", color: "neon-pink" },
      ];
      const result = applyOps(emptyScene(), ops);
      expect((result.records[0].props as Record<string, unknown>).color).toBe(
        "black"
      );
    });

    it("resolves valid fills", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "rect", id: "f1", fill: "solid" },
      ];
      const result = applyOps(emptyScene(), ops);
      expect((result.records[0].props as Record<string, unknown>).fill).toBe(
        "solid"
      );
    });

    it("defaults invalid fills to none", () => {
      const ops: WhiteboardOp[] = [
        {
          op: "add",
          type: "rect",
          id: "f2",
          fill: "gradient" as unknown as string,
        },
      ];
      const result = applyOps(emptyScene(), ops);
      expect((result.records[0].props as Record<string, unknown>).fill).toBe(
        "none"
      );
    });

    it("resolves valid dash styles", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "rect", id: "s1", style: "dashed" },
      ];
      const result = applyOps(emptyScene(), ops);
      expect((result.records[0].props as Record<string, unknown>).dash).toBe(
        "dashed"
      );
    });

    it("defaults undefined style to solid", () => {
      const ops: WhiteboardOp[] = [{ op: "add", type: "rect", id: "s2" }];
      const result = applyOps(emptyScene(), ops);
      expect((result.records[0].props as Record<string, unknown>).dash).toBe(
        "solid"
      );
    });
  });

  describe("update operations", () => {
    it("updates position and label", () => {
      const scene = applyOps(emptyScene(), [
        { op: "add", type: "rect", id: "u1", x: 0, y: 0, label: "Old" },
      ]);
      const result = applyOps(scene, [
        { op: "update", id: "u1", x: 50, y: 60, label: "New" },
      ]);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].x).toBe(50);
      expect(result.records[0].y).toBe(60);
      const richText = (result.records[0].props as Record<string, unknown>)
        .richText as {
        content: Array<{ content: Array<{ text: string }> }>;
      };
      expect(richText.content[0].content[0].text).toBe("New");
    });

    it("updates color and fill", () => {
      const scene = applyOps(emptyScene(), [
        { op: "add", type: "rect", id: "u2", color: "black" },
      ]);
      const result = applyOps(scene, [
        { op: "update", id: "u2", color: "red", fill: "solid" },
      ]);
      const props = result.records[0].props as Record<string, unknown>;
      expect(props.color).toBe("red");
      expect(props.fill).toBe("solid");
    });

    it("skips update when id not found", () => {
      const scene = applyOps(emptyScene(), [
        { op: "add", type: "rect", id: "exists" },
      ]);
      const result = applyOps(scene, [
        { op: "update", id: "nonexistent", x: 999 },
      ]);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].x).not.toBe(999);
    });
  });

  describe("delete operations", () => {
    it("deletes a shape by id", () => {
      const scene = applyOps(emptyScene(), [
        { op: "add", type: "rect", id: "d1", x: 0, y: 0 },
        { op: "add", type: "rect", id: "d2", x: 100, y: 0 },
      ]);
      const result = applyOps(scene, [{ op: "delete", id: "d1" }]);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].id).toContain("d2");
    });

    it("skips delete when id not found", () => {
      const scene = applyOps(emptyScene(), [
        { op: "add", type: "rect", id: "keep" },
      ]);
      const result = applyOps(scene, [{ op: "delete", id: "gone" }]);
      expect(result.records).toHaveLength(1);
    });
  });

  describe("mixed operations", () => {
    it("handles add + update + delete in sequence", () => {
      const ops: WhiteboardOp[] = [
        { op: "add", type: "rect", id: "m1", x: 0, y: 0, label: "A" },
        { op: "add", type: "rect", id: "m2", x: 100, y: 0, label: "B" },
        { op: "add", type: "rect", id: "m3", x: 200, y: 0, label: "C" },
        { op: "update", id: "m2", label: "B-updated" },
        { op: "delete", id: "m1" },
      ];
      const result = applyOps(emptyScene(), ops);
      expect(result.records).toHaveLength(2);
      const ids = result.records.map((r) => r.id as string);
      expect(ids.some((id) => id.includes("m1"))).toBe(false);
      expect(ids.some((id) => id.includes("m2"))).toBe(true);
    });

    it("replaces existing shape on duplicate add", () => {
      const scene = applyOps(emptyScene(), [
        { op: "add", type: "rect", id: "dup", x: 0, y: 0 },
      ]);
      const result = applyOps(scene, [
        { op: "add", type: "ellipse", id: "dup", x: 50, y: 50 },
      ]);
      expect(result.records).toHaveLength(1);
      expect((result.records[0].props as Record<string, unknown>).geo).toBe(
        "ellipse"
      );
      expect(result.records[0].x).toBe(50);
    });
  });
});

describe("makeShapeId", () => {
  it("returns a shape: prefixed id for plain strings", () => {
    const id = makeShapeId("test123");
    expect(id).toMatch(/^shape:/);
  });

  it("passes through already-prefixed ids", () => {
    const id = makeShapeId("shape:already");
    expect(id).toBe("shape:already");
  });

  it("generates a unique id when no argument given", () => {
    const a = makeShapeId();
    const b = makeShapeId();
    expect(a).toMatch(/^shape:/);
    expect(a).not.toBe(b);
  });
});
