export type WhiteboardOp = {
  op: "add" | "update" | "delete";
  type?: "rect" | "ellipse" | "diamond" | "arrow" | "line" | "text" | "frame";
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  label?: string;
  from?: string;
  to?: string;
  color?: string;
  fill?: string;
  style?: "solid" | "dashed" | "dotted";
  startHead?: "none" | "arrow" | "triangle" | "bar" | "dot" | "diamond";
  endHead?: "none" | "arrow" | "triangle" | "bar" | "dot" | "diamond";
};

export type SimplifiedElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  color?: string;
  fill?: string;
  from?: string;
  to?: string;
};

export type WhiteboardScene = {
  records: Record<string, unknown>[];
};

export type WhiteboardGetResult = {
  scene: WhiteboardScene;
  version: number;
  elements: SimplifiedElement[];
  snapshotPath: string | null;
};

export type WhiteboardUpdateResult = {
  version: number;
  elementCount: number;
};

export function simplifyElements(
  records: Record<string, unknown>[]
): SimplifiedElement[] {
  return records
    .filter(
      (r) =>
        typeof r.typeName === "string" &&
        r.typeName === "shape" &&
        typeof r.type === "string"
    )
    .map((r) => {
      const props = (r.props ?? {}) as Record<string, unknown>;
      const el: SimplifiedElement = {
        id: String(r.id),
        type: String(r.type),
        x: typeof r.x === "number" ? r.x : 0,
        y: typeof r.y === "number" ? r.y : 0,
        w: typeof props.w === "number" ? props.w : 0,
        h: typeof props.h === "number" ? props.h : 0,
      };
      if (props.text && typeof props.text === "string") el.label = props.text;
      if (props.color && typeof props.color === "string")
        el.color = props.color;
      if (props.fill && typeof props.fill === "string") el.fill = props.fill;
      return el;
    });
}
