import { createShapeId } from "@tldraw/tlschema";

import type { WhiteboardOp, WhiteboardScene } from "./whiteboard.js";

const TLDRAW_COLORS = new Set([
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
]);

const TLDRAW_FILLS = new Set(["none", "semi", "solid", "pattern"]);

const TLDRAW_DASH = new Set(["draw", "solid", "dashed", "dotted"]);

const TLDRAW_ARROWHEADS = new Set([
  "arrow",
  "triangle",
  "square",
  "dot",
  "pipe",
  "diamond",
  "inverted",
  "bar",
  "none",
]);

type GeoType = "rectangle" | "ellipse" | "diamond";

const GEO_MAP: Record<string, GeoType> = {
  rect: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
};

function resolveColor(color: string | undefined): string {
  if (!color) return "black";
  if (TLDRAW_COLORS.has(color)) return color;
  const lower = color.toLowerCase();
  if (TLDRAW_COLORS.has(lower)) return lower;
  return "black";
}

function resolveFill(fill: string | undefined): string {
  if (!fill) return "none";
  if (TLDRAW_FILLS.has(fill)) return fill;
  return "none";
}

function resolveDash(style: string | undefined): string {
  if (!style) return "solid";
  if (TLDRAW_DASH.has(style)) return style;
  return "solid";
}

function resolveArrowhead(head: string | undefined): string {
  if (!head) return "none";
  if (TLDRAW_ARROWHEADS.has(head)) return head;
  return "none";
}

function makeShapeId(userProvidedId?: string): string {
  if (userProvidedId) {
    if (userProvidedId.startsWith("shape:")) return userProvidedId;
    return createShapeId(userProvidedId);
  }
  return createShapeId();
}

function textToRichText(text: string): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function buildGeoShape(
  op: WhiteboardOp,
  geo: GeoType
): Record<string, unknown> {
  const id = makeShapeId(op.id);
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: op.x ?? 0,
    y: op.y ?? 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    parentId: "page:page",
    index: "a1",
    props: {
      geo,
      w: op.w ?? 200,
      h: op.h ?? 200,
      growY: 0,
      color: resolveColor(op.color),
      fill: resolveFill(op.fill),
      dash: resolveDash(op.style),
      size: "m",
      font: "draw",
      align: "middle",
      verticalAlign: "middle",
      labelColor: "black",
      url: "",
      scale: 1,
      richText: op.label ? textToRichText(op.label) : textToRichText(""),
    },
  };
}

function buildTextShape(op: WhiteboardOp): Record<string, unknown> {
  const id = makeShapeId(op.id);
  return {
    id,
    typeName: "shape",
    type: "text",
    x: op.x ?? 0,
    y: op.y ?? 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    parentId: "page:page",
    index: "a1",
    props: {
      color: resolveColor(op.color),
      size: "m",
      font: "draw",
      textAlign: "start",
      w: op.w ?? 200,
      autoSize: !op.w,
      scale: 1,
      richText: textToRichText(op.label ?? ""),
    },
  };
}

function buildArrowShape(op: WhiteboardOp): Record<string, unknown> {
  const id = makeShapeId(op.id);
  const startX = op.x ?? 0;
  const startY = op.y ?? 0;
  const endX = startX + (op.w ?? 200);
  const endY = startY + (op.h ?? 0);

  const start = op.from
    ? {
        type: "binding",
        boundShapeId: makeShapeId(op.from),
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
      }
    : { type: "point", x: startX, y: startY };

  const end = op.to
    ? {
        type: "binding",
        boundShapeId: makeShapeId(op.to),
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
      }
    : { type: "point", x: endX, y: endY };

  return {
    id,
    typeName: "shape",
    type: "arrow",
    x: op.from ? 0 : startX,
    y: op.from ? 0 : startY,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    parentId: "page:page",
    index: "a1",
    props: {
      kind: "elbow",
      color: resolveColor(op.color),
      fill: resolveFill(op.fill),
      dash: resolveDash(op.style),
      size: "m",
      font: "draw",
      arrowheadStart: resolveArrowhead(op.startHead),
      arrowheadEnd: resolveArrowhead(op.endHead ?? "arrow"),
      start,
      end,
      bend: 0,
      labelColor: "black",
      richText: op.label ? textToRichText(op.label) : textToRichText(""),
      labelPosition: 0.5,
      scale: 1,
      elbowMidPoint: 0.5,
    },
  };
}

function buildFrameShape(op: WhiteboardOp): Record<string, unknown> {
  const id = makeShapeId(op.id);
  return {
    id,
    typeName: "shape",
    type: "frame",
    x: op.x ?? 0,
    y: op.y ?? 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    parentId: "page:page",
    index: "a1",
    props: {
      w: op.w ?? 400,
      h: op.h ?? 300,
      name: op.label ?? "",
      color: resolveColor(op.color),
    },
  };
}

function buildLineShape(op: WhiteboardOp): Record<string, unknown> {
  return buildArrowShape({
    ...op,
    startHead: op.startHead ?? "none",
    endHead: op.endHead ?? "none",
  });
}

function buildShape(op: WhiteboardOp): Record<string, unknown> | null {
  const shapeType = op.type ?? "rect";
  const geo = GEO_MAP[shapeType];
  if (geo) return buildGeoShape(op, geo);
  if (shapeType === "text") return buildTextShape(op);
  if (shapeType === "arrow") return buildArrowShape(op);
  if (shapeType === "frame") return buildFrameShape(op);
  if (shapeType === "line") return buildLineShape(op);
  return null;
}

export function applyOps(
  scene: WhiteboardScene,
  ops: WhiteboardOp[]
): WhiteboardScene {
  const records = [...(scene.records ?? [])];
  const indexById = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const id = records[i].id as string;
    if (id) indexById.set(id, i);
  }

  let nextIndex = records.length;

  for (const op of ops) {
    if (op.op === "add") {
      const shape = buildShape(op);
      if (!shape) continue;
      shape.index = `a${nextIndex++}`;
      const existingIdx = indexById.get(shape.id as string);
      if (existingIdx !== undefined) {
        records[existingIdx] = shape;
      } else {
        indexById.set(shape.id as string, records.length);
        records.push(shape);
      }
    } else if (op.op === "update") {
      const targetId = op.id ? makeShapeId(op.id) : undefined;
      if (!targetId) continue;
      const idx = indexById.get(targetId);
      if (idx === undefined) continue;
      const existing = { ...records[idx] };
      const props = { ...((existing.props ?? {}) as Record<string, unknown>) };
      if (op.x !== undefined) existing.x = op.x;
      if (op.y !== undefined) existing.y = op.y;
      if (op.w !== undefined) props.w = op.w;
      if (op.h !== undefined) props.h = op.h;
      if (op.label !== undefined) props.richText = textToRichText(op.label);
      if (op.color !== undefined) props.color = resolveColor(op.color);
      if (op.fill !== undefined) props.fill = resolveFill(op.fill);
      if (op.style !== undefined) props.dash = resolveDash(op.style);
      existing.props = props;
      records[idx] = existing;
    } else if (op.op === "delete") {
      const targetId = op.id ? makeShapeId(op.id) : undefined;
      if (!targetId) continue;
      const idx = indexById.get(targetId);
      if (idx === undefined) continue;
      records.splice(idx, 1);
      indexById.delete(targetId);
      for (const [key, val] of indexById) {
        if (val > idx) indexById.set(key, val - 1);
      }
    }
  }

  return { records };
}

export { makeShapeId };
