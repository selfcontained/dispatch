// Expand simplified agent drawing ops into full Excalidraw elements without
// importing Excalidraw (browser-only; dies on import server-side). Field shape
// mirrors convertToExcalidrawElements output, captured from the real editor.

export type WhiteboardOpShape =
  | "rect"
  | "ellipse"
  | "diamond"
  | "arrow"
  | "line"
  | "text"
  | "frame";

export type WhiteboardOp = {
  op: "add" | "update" | "delete";
  type?: WhiteboardOpShape;
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  label?: string;
  from?: string;
  to?: string;
  color?: string;
};

export type ApplyOpsResult = {
  elements: unknown[];
  created: Array<{ id: string; type: string }>;
  errors: string[];
};

export const MAX_OPS = 100;

// Signature agent ink (P1): Excalidraw palette violet; user restyles freely.
const AGENT_STROKE = "#6741d9";

const NAMED_COLORS: Record<string, string> = {
  black: "#1e1e1e",
  gray: "#868e96",
  violet: "#6741d9",
  blue: "#1971c2",
  cyan: "#0c8599",
  teal: "#099268",
  green: "#2f9e44",
  yellow: "#f08c00",
  orange: "#e8590c",
  red: "#e03131",
};

const FONT_SIZE = 20;
const LINE_HEIGHT = 1.25;
// Excalifont at 20px averages ~8.3px/char (measured from editor output).
// Over-estimate: a too-narrow box visibly clips text, a wide one is healed
// by autoResize on the first user edit.
const CHAR_WIDTH = FONT_SIZE * 0.55;

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function newId(): string {
  let id = "";
  for (let i = 0; i < 20; i++) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}

function nonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

type Mutable = Record<string, unknown>;

function resolveColor(color: string | undefined): string | null {
  if (color === undefined) return AGENT_STROKE;
  const named = NAMED_COLORS[color.toLowerCase()];
  if (named) return named;
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  return null;
}

function measureText(text: string): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  return {
    width: Math.ceil(longest * CHAR_WIDTH),
    height: Math.ceil(lines.length * FONT_SIZE * LINE_HEIGHT),
  };
}

function baseElement(
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  strokeColor: string
): Mutable {
  return {
    id: newId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    // Excalidraw assigns fractional indices to scene-less elements on load.
    index: null,
    roundness: null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    customData: { author: "agent" },
  };
}

function bump(el: Mutable): Mutable {
  return {
    ...el,
    version: (typeof el.version === "number" ? el.version : 0) + 1,
    versionNonce: nonce(),
    updated: Date.now(),
  };
}

function boundLabel(container: Mutable, text: string): Mutable {
  const { width, height } = measureText(text);
  const cx = (container.x as number) + (container.width as number) / 2;
  const cy = (container.y as number) + (container.height as number) / 2;
  const label = baseElement(
    "text",
    cx - width / 2,
    cy - height / 2,
    width,
    height,
    container.strokeColor as string
  );
  Object.assign(label, {
    text,
    fontSize: FONT_SIZE,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: container.id,
    originalText: text,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  });
  container.boundElements = [
    ...((container.boundElements as unknown[]) ?? []),
    { type: "text", id: label.id },
  ];
  return label;
}

// Where the segment from this shape's center toward (tx, ty) exits its
// bounding box — good enough for the initial render; Excalidraw re-routes
// bound arrows the moment either endpoint moves.
function edgePoint(
  el: Mutable,
  tx: number,
  ty: number
): { x: number; y: number } {
  const x = el.x as number;
  const y = el.y as number;
  const w = el.width as number;
  const h = el.height as number;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = 1 / Math.max(Math.abs(dx) / (w / 2), Math.abs(dy) / (h / 2));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function center(el: Mutable): { x: number; y: number } {
  return {
    x: (el.x as number) + (el.width as number) / 2,
    y: (el.y as number) + (el.height as number) / 2,
  };
}

// Recompute an arrow's endpoints from its bindings. Excalidraw only re-routes
// bound arrows during in-editor drags; server-side moves must do it here or
// arrows stay stranded at their old geometry.
function rerouteArrow(
  arrow: Mutable,
  resolve: (id: string | undefined) => Mutable | null
): Mutable | null {
  const fromEl = resolve(
    (arrow.startBinding as { elementId?: string } | null)?.elementId
  );
  const toEl = resolve(
    (arrow.endBinding as { elementId?: string } | null)?.elementId
  );
  if (!fromEl && !toEl) return null;
  const points = arrow.points as number[][];
  const oldEnd = {
    x: (arrow.x as number) + (points?.[points.length - 1]?.[0] ?? 0),
    y: (arrow.y as number) + (points?.[points.length - 1]?.[1] ?? 0),
  };
  const oldStart = { x: arrow.x as number, y: arrow.y as number };
  const startC = fromEl ? center(fromEl) : oldStart;
  const endC = toEl ? center(toEl) : oldEnd;
  const start = fromEl ? edgePoint(fromEl, endC.x, endC.y) : oldStart;
  const end = toEl ? edgePoint(toEl, startC.x, startC.y) : oldEnd;
  return {
    ...bump(arrow),
    x: start.x,
    y: start.y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
  };
}

export function applyWhiteboardOps(
  existing: unknown[],
  ops: WhiteboardOp[]
): ApplyOpsResult {
  const errors: string[] = [];
  const created: Array<{ id: string; type: string }> = [];

  // Work on a map so boundElements/binding rewrites replace in place.
  const order: string[] = [];
  const byId = new Map<string, Mutable>();
  for (const raw of existing) {
    if (typeof raw !== "object" || raw === null) continue;
    const el = { ...(raw as Mutable) };
    const id = typeof el.id === "string" ? el.id : newId();
    order.push(id);
    byId.set(id, el);
  }
  const appended: string[] = [];

  const put = (el: Mutable): void => {
    const id = el.id as string;
    if (!byId.has(id)) appended.push(id);
    byId.set(id, el);
  };

  const live = (id: string | undefined): Mutable | null => {
    if (!id) return null;
    const el = byId.get(id);
    return el && el.isDeleted !== true ? el : null;
  };

  for (const [i, op] of ops.entries()) {
    const at = `ops[${i}]`;
    if (op.op === "add") {
      const stroke = resolveColor(op.color);
      if (!stroke) {
        errors.push(`${at}: unknown color "${op.color}".`);
        continue;
      }
      if (op.id !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(op.id)) {
          errors.push(`${at}: id must match [A-Za-z0-9_-]{1,64}.`);
          continue;
        }
        if (byId.has(op.id)) {
          errors.push(`${at}: id "${op.id}" already exists on the board.`);
          continue;
        }
      }
      const x = op.x ?? 0;
      const y = op.y ?? 0;
      const w = op.w ?? 100;
      const h = op.h ?? 60;

      switch (op.type) {
        case "rect":
        case "ellipse":
        case "diamond": {
          const el = baseElement(
            op.type === "rect" ? "rectangle" : op.type,
            x,
            y,
            w,
            h,
            stroke
          );
          if (op.id) el.id = op.id;
          if (op.type === "rect") el.roundness = { type: 3 };
          put(el);
          created.push({ id: el.id as string, type: op.type });
          if (op.label) put(boundLabel(el, op.label));
          break;
        }
        case "text": {
          if (!op.label) {
            errors.push(`${at}: text requires a label.`);
            continue;
          }
          const size = measureText(op.label);
          const el = baseElement("text", x, y, size.width, size.height, stroke);
          if (op.id) el.id = op.id;
          Object.assign(el, {
            text: op.label,
            fontSize: FONT_SIZE,
            fontFamily: 5,
            textAlign: "left",
            verticalAlign: "top",
            containerId: null,
            originalText: op.label,
            autoResize: true,
            lineHeight: LINE_HEIGHT,
          });
          put(el);
          created.push({ id: el.id as string, type: "text" });
          break;
        }
        case "frame": {
          const el = baseElement("frame", x, y, w, h, "#1e1e1e");
          if (op.id) el.id = op.id;
          el.name = op.label ?? null;
          put(el);
          created.push({ id: el.id as string, type: "frame" });
          break;
        }
        case "arrow":
        case "line": {
          const el = baseElement(op.type, x, y, w, h, stroke);
          if (op.id) el.id = op.id;
          Object.assign(el, {
            points: [
              [0, 0],
              [op.w ?? 100, op.h ?? 0],
            ],
            lastCommittedPoint: null,
            startBinding: null,
            endBinding: null,
            startArrowhead: null,
            endArrowhead: op.type === "arrow" ? "arrow" : null,
          });
          if (op.type === "arrow") el.elbowed = false;

          if (op.from || op.to) {
            const fromEl = live(op.from);
            const toEl = live(op.to);
            if (op.from && !fromEl) {
              errors.push(`${at}: from element "${op.from}" not found.`);
              continue;
            }
            if (op.to && !toEl) {
              errors.push(`${at}: to element "${op.to}" not found.`);
              continue;
            }
            const startC = fromEl ? center(fromEl) : { x, y };
            const endC = toEl
              ? center(toEl)
              : { x: x + (op.w ?? 100), y: y + (op.h ?? 0) };
            const start = fromEl ? edgePoint(fromEl, endC.x, endC.y) : startC;
            const end = toEl ? edgePoint(toEl, startC.x, startC.y) : endC;
            Object.assign(el, {
              x: start.x,
              y: start.y,
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
              points: [
                [0, 0],
                [end.x - start.x, end.y - start.y],
              ],
            });
            const arrowRef = { id: el.id, type: "arrow" };
            if (fromEl) {
              el.startBinding = { elementId: fromEl.id, focus: 0, gap: 4 };
              put({
                ...bump(fromEl),
                boundElements: [
                  ...((fromEl.boundElements as unknown[]) ?? []),
                  arrowRef,
                ],
              });
            }
            if (toEl) {
              el.endBinding = { elementId: toEl.id, focus: 0, gap: 4 };
              put({
                ...bump(toEl),
                boundElements: [
                  ...((toEl.boundElements as unknown[]) ?? []),
                  arrowRef,
                ],
              });
            }
          }
          put(el);
          created.push({ id: el.id as string, type: op.type });
          if (op.label) put(boundLabel(el, op.label));
          break;
        }
        default:
          errors.push(`${at}: unknown type "${op.type}".`);
      }
      continue;
    }

    const target = live(op.id);
    if (!target) {
      errors.push(`${at}: element "${op.id}" not found.`);
      continue;
    }

    if (op.op === "update") {
      const updated = bump(target);
      if (op.x !== undefined) updated.x = op.x;
      if (op.y !== undefined) updated.y = op.y;
      if (op.w !== undefined) updated.width = op.w;
      if (op.h !== undefined) updated.height = op.h;
      if (op.color !== undefined) {
        const stroke = resolveColor(op.color);
        if (!stroke) {
          errors.push(`${at}: unknown color "${op.color}".`);
          continue;
        }
        updated.strokeColor = stroke;
      }
      if (op.label !== undefined) {
        if (updated.type === "text") {
          const size = measureText(op.label);
          Object.assign(updated, {
            text: op.label,
            originalText: op.label,
            width: size.width,
            height: size.height,
          });
        } else if (updated.type === "frame") {
          updated.name = op.label;
        } else {
          const boundText = (
            (updated.boundElements as Array<{
              id?: string;
              type?: string;
            }>) ?? []
          ).find((b) => b.type === "text");
          const labelEl = boundText?.id ? live(boundText.id) : null;
          if (labelEl) {
            const size = measureText(op.label);
            const cx = (updated.x as number) + (updated.width as number) / 2;
            const cy = (updated.y as number) + (updated.height as number) / 2;
            put({
              ...bump(labelEl),
              text: op.label,
              originalText: op.label,
              width: size.width,
              height: size.height,
              x: cx - size.width / 2,
              y: cy - size.height / 2,
            });
          } else {
            put(boundLabel(updated, op.label));
          }
        }
      }
      // Keep an existing bound label centered when geometry moved.
      if (
        (op.x !== undefined ||
          op.y !== undefined ||
          op.w !== undefined ||
          op.h !== undefined) &&
        updated.type !== "text"
      ) {
        const boundText = (
          (updated.boundElements as Array<{
            id?: string;
            type?: string;
          }>) ?? []
        ).find((b) => b.type === "text");
        const labelEl = boundText?.id ? live(boundText.id) : null;
        if (labelEl) {
          const cx = (updated.x as number) + (updated.width as number) / 2;
          const cy = (updated.y as number) + (updated.height as number) / 2;
          put({
            ...bump(labelEl),
            x: cx - (labelEl.width as number) / 2,
            y: cy - (labelEl.height as number) / 2,
          });
        }
        put(updated);
        // Attached arrows must follow the moved shape.
        for (const ref of (updated.boundElements as Array<{
          id?: string;
          type?: string;
        }>) ?? []) {
          if (ref.type !== "arrow" || !ref.id) continue;
          const arrow = live(ref.id);
          if (!arrow) continue;
          const rerouted = rerouteArrow(arrow, live);
          if (rerouted) put(rerouted);
        }
      }
      put(updated);
      continue;
    }

    if (op.op === "delete") {
      put({ ...bump(target), isDeleted: true });
      // Bound labels die with their container.
      for (const ref of (target.boundElements as Array<{
        id?: string;
        type?: string;
      }>) ?? []) {
        if (ref.type === "text" && ref.id) {
          const labelEl = live(ref.id);
          if (labelEl) put({ ...bump(labelEl), isDeleted: true });
        }
        // Arrows bound to a deleted shape survive; drop the dangling binding.
        if (ref.type === "arrow" && ref.id) {
          const arrow = live(ref.id);
          if (!arrow) continue;
          const next = bump(arrow);
          const sb = next.startBinding as { elementId?: string } | null;
          const eb = next.endBinding as { elementId?: string } | null;
          if (sb?.elementId === target.id) next.startBinding = null;
          if (eb?.elementId === target.id) next.endBinding = null;
          put(next);
        }
      }
      // Deleting an arrow (or contained label) leaves back-references on the
      // elements it was attached to; scrub them.
      const detachFrom = new Set<string>();
      const sb = target.startBinding as { elementId?: string } | null;
      const eb = target.endBinding as { elementId?: string } | null;
      if (typeof sb?.elementId === "string") detachFrom.add(sb.elementId);
      if (typeof eb?.elementId === "string") detachFrom.add(eb.elementId);
      if (typeof target.containerId === "string") {
        detachFrom.add(target.containerId);
      }
      for (const hostId of detachFrom) {
        const host = live(hostId);
        if (!host) continue;
        put({
          ...bump(host),
          boundElements: (
            (host.boundElements as Array<{ id?: string }>) ?? []
          ).filter((b) => b.id !== target.id),
        });
      }
      // Freed frame children stay on the board.
      if (target.type === "frame") {
        for (const [id, el] of byId) {
          if (el.frameId === target.id && el.isDeleted !== true) {
            put({ ...bump(byId.get(id) as Mutable), frameId: null });
          }
        }
      }
      continue;
    }

    errors.push(`${at}: unknown op "${(op as { op?: string }).op}".`);
  }

  return {
    elements: [...order, ...appended].map((id) => byId.get(id)),
    created,
    errors,
  };
}
