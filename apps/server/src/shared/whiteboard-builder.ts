// Expand simplified agent drawing ops into full Excalidraw elements without
// importing Excalidraw (browser-only; dies on import server-side). Field shape
// mirrors convertToExcalidrawElements output, captured from the real editor.
//
// Captured from @excalidraw/excalidraw EXCALIDRAW_CAPTURE_VERSION. Bumping the
// web pin requires re-verifying the mirrored formulas here (bound-text fitting,
// CHAR_WIDTH, getSizeFromPoints, fractional-index behavior); a unit test
// asserts the pin matches this constant so an upgrade fails loudly.
export const EXCALIDRAW_CAPTURE_VERSION = "0.18.1";

export type WhiteboardOpShape =
  | "rect"
  | "ellipse"
  | "diamond"
  | "arrow"
  | "line"
  | "text"
  | "frame";

export type WhiteboardArrowhead =
  | "none"
  | "arrow"
  | "triangle"
  | "bar"
  | "dot"
  | "diamond";

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
  fill?: string;
  style?: "solid" | "dashed" | "dotted";
  startHead?: WhiteboardArrowhead;
  endHead?: WhiteboardArrowhead;
  via?: Array<[number, number]>;
  elbow?: boolean;
};

export type ApplyOpsResult = {
  elements: unknown[];
  created: Array<{ id: string; type: string }>;
  errors: string[];
  // Non-fatal layout notices: auto-grown shapes, overlapping elements.
  warnings: string[];
};

export const MAX_OPS = 100;

// Default agent ink: Excalidraw's default stroke — black on light boards,
// inverted to near-white in dark mode, so it reads cleanly on any theme.
const AGENT_STROKE = "#1e1e1e";

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

// Excalidraw's background palette: softer tints of the stroke palette, so a
// named fill reads as a wash rather than a solid block.
const NAMED_FILLS: Record<string, string> = {
  black: "#343a40",
  gray: "#e9ecef",
  violet: "#e5dbff",
  blue: "#a5d8ff",
  cyan: "#99e9f2",
  teal: "#96f2d7",
  green: "#b2f2bb",
  yellow: "#ffec99",
  orange: "#ffd8a8",
  red: "#ffc9c9",
};

function resolveFill(fill: string): string | null {
  if (fill.toLowerCase() === "transparent") return "transparent";
  const named = NAMED_FILLS[fill.toLowerCase()];
  if (named) return named;
  if (/^#[0-9a-fA-F]{6}$/.test(fill)) return fill;
  return null;
}

const ARROWHEADS: Record<WhiteboardArrowhead, string | null> = {
  none: null,
  arrow: "arrow",
  triangle: "triangle",
  bar: "bar",
  dot: "dot",
  diamond: "diamond",
};

function measureText(text: string): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  return {
    width: Math.ceil(longest * CHAR_WIDTH),
    height: Math.ceil(lines.length * FONT_SIZE * LINE_HEIGHT),
  };
}

// Bound-label fitting mirrors Excalidraw's own formulas (BOUND_TEXT_PADDING,
// getBoundTextMaxWidth, computeContainerDimensionForBoundText) so the editor
// agrees with what we bake in — text must never escape its shape.
const BOUND_TEXT_PADDING = 5;
const PAD2 = BOUND_TEXT_PADDING * 2;
// Widest a shape will auto-grow for one unbreakable word before we hard-break
// the word instead (keeps a pasted URL from spawning a 1000px box).
const MAX_AUTO_TEXT_WIDTH = 440;

const FITTED_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

function usableTextWidth(type: string, width: number): number {
  if (type === "ellipse") return Math.round(width / Math.SQRT2) - PAD2;
  if (type === "diamond") return width / 2 - PAD2;
  if (type === "arrow" || type === "line") return Math.max(140, width * 0.7);
  return width - PAD2;
}

function usableTextHeight(type: string, height: number): number {
  if (type === "ellipse") return Math.round(height / Math.SQRT2) - PAD2;
  if (type === "diamond") return height / 2 - PAD2;
  return height - PAD2;
}

function containerWidthFor(type: string, textWidth: number): number {
  if (type === "ellipse") return Math.round((textWidth + PAD2) * Math.SQRT2);
  if (type === "diamond") return 2 * (textWidth + PAD2);
  return textWidth + PAD2;
}

function containerHeightFor(type: string, textHeight: number): number {
  if (type === "ellipse") return Math.round((textHeight + PAD2) * Math.SQRT2);
  if (type === "diamond") return 2 * (textHeight + PAD2);
  return textHeight + PAD2;
}

function longestWordWidth(text: string): number {
  let max = 1;
  for (const word of text.split(/[\s\n]+/)) max = Math.max(max, word.length);
  return Math.ceil(max * CHAR_WIDTH);
}

// Greedy word-wrap using the same CHAR_WIDTH estimate as measureText. Words
// wider than maxWidth are hard-broken so a wrapped line never exceeds it.
function wrapLabel(text: string, maxWidth: number): string {
  const maxChars = Math.max(1, Math.floor(maxWidth / CHAR_WIDTH));
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const words = raw.split(" ").filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      while (word.length > maxChars) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

// Wrap `text` to fit `container`, growing the container when it can't (wider
// for one unbreakable word, taller for extra lines), and center `labelEl` on
// the result. Mutates both. Returns true when the container grew.
function layoutBoundText(
  container: Mutable,
  labelEl: Mutable,
  text: string
): boolean {
  const type = container.type as string;
  const fitted = FITTED_TYPES.has(type);
  let grew = false;
  let maxW = usableTextWidth(type, container.width as number);
  if (fitted) {
    const wordW = Math.min(longestWordWidth(text), MAX_AUTO_TEXT_WIDTH);
    if (wordW > maxW) {
      maxW = wordW;
      container.width = containerWidthFor(type, wordW);
      grew = true;
    }
  }
  const wrapped = wrapLabel(text, maxW);
  const size = measureText(wrapped);
  if (
    fitted &&
    size.height > usableTextHeight(type, container.height as number)
  ) {
    container.height = containerHeightFor(type, size.height);
    grew = true;
  }
  const { x: cx, y: cy } = center(container);
  Object.assign(labelEl, {
    text: wrapped,
    originalText: text,
    width: size.width,
    height: size.height,
    x: cx - size.width / 2,
    y: cy - size.height / 2,
  });
  return grew;
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

function boundLabel(
  container: Mutable,
  text: string
): { label: Mutable; grew: boolean } {
  const label = baseElement(
    "text",
    0,
    0,
    0,
    0,
    container.strokeColor as string
  );
  Object.assign(label, {
    fontSize: FONT_SIZE,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: container.id,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  });
  const grew = layoutBoundText(container, label, text);
  container.boundElements = [
    ...((container.boundElements as unknown[]) ?? []),
    { type: "text", id: label.id },
  ];
  return { label, grew };
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

// A linear element's x,y is its FIRST point, not the bbox corner — points can
// run negative. Center must come from the points' extent or labels drift.
function center(el: Mutable): { x: number; y: number } {
  const points = el.points as number[][] | undefined;
  if (Array.isArray(points) && points.length > 0) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return {
      x: (el.x as number) + (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (el.y as number) + (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }
  return {
    x: (el.x as number) + (el.width as number) / 2,
    y: (el.y as number) + (el.height as number) / 2,
  };
}

type Point = { x: number; y: number };

// Set a linear element's x/y/width/height/points from absolute start, bend
// (via), and end coordinates. Width/height are the points' bbox extents,
// matching Excalidraw's getSizeFromPoints.
function setLinearGeometry(
  el: Mutable,
  start: Point,
  via: Point[],
  end: Point
): void {
  const rel = [
    [0, 0],
    ...via.map((p) => [p.x - start.x, p.y - start.y]),
    [end.x - start.x, end.y - start.y],
  ];
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  el.x = start.x;
  el.y = start.y;
  el.width = Math.max(...xs) - Math.min(...xs);
  el.height = Math.max(...ys) - Math.min(...ys);
  el.points = rel;
}

// Orthogonal (right-angle) route between two endpoints, exiting bound shapes
// through the facing edge midpoint. Returns bends only — endpoints included.
function elbowRoute(
  fromEl: Mutable | null,
  toEl: Mutable | null,
  rawStart: Point,
  rawEnd: Point
): { start: Point; via: Point[]; end: Point } {
  const startC = fromEl ? center(fromEl) : rawStart;
  const endC = toEl ? center(toEl) : rawEnd;
  const dx = endC.x - startC.x;
  const dy = endC.y - startC.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const edge = (el: Mutable, sign: number): Point =>
    horizontal
      ? {
          x: (el.x as number) + (sign > 0 ? (el.width as number) : 0),
          y: (el.y as number) + (el.height as number) / 2,
        }
      : {
          x: (el.x as number) + (el.width as number) / 2,
          y: (el.y as number) + (sign > 0 ? (el.height as number) : 0),
        };
  const start = fromEl ? edge(fromEl, horizontal ? dx : dy) : rawStart;
  const end = toEl ? edge(toEl, horizontal ? -dx : -dy) : rawEnd;
  const via: Point[] = [];
  if (horizontal) {
    const midX = (start.x + end.x) / 2;
    if (Math.abs(start.y - end.y) > 1) {
      via.push({ x: midX, y: start.y }, { x: midX, y: end.y });
    }
  } else {
    const midY = (start.y + end.y) / 2;
    if (Math.abs(start.x - end.x) > 1) {
      via.push({ x: start.x, y: midY }, { x: end.x, y: midY });
    }
  }
  return { start, via, end };
}

// Route a linear element between its endpoints: elbow (right-angle bends) or
// bend-aimed straight/curved attachment. Bound endpoints (fromEl/toEl) exit
// through the shape edge, aiming at the nearest bend or the far element.
// Owns the geometry only — callers set roundness per their own rules.
function routeLinear(
  el: Mutable,
  fromEl: Mutable | null,
  toEl: Mutable | null,
  rawStart: Point,
  rawEnd: Point,
  via: Point[],
  elbow: boolean
): void {
  if (elbow) {
    const r = elbowRoute(fromEl, toEl, rawStart, rawEnd);
    setLinearGeometry(el, r.start, r.via, r.end);
    return;
  }
  const startC = fromEl ? center(fromEl) : rawStart;
  const endC = toEl ? center(toEl) : rawEnd;
  const startAim = via[0] ?? endC;
  const endAim = via[via.length - 1] ?? startC;
  const start = fromEl ? edgePoint(fromEl, startAim.x, startAim.y) : rawStart;
  const end = toEl ? edgePoint(toEl, endAim.x, endAim.y) : rawEnd;
  setLinearGeometry(el, start, via, end);
}

// Re-center an element's bound label on its current geometry.
function recenteredLabel(
  container: Mutable,
  live: (id: string | undefined) => Mutable | null
): Mutable | null {
  const ref = (
    (container.boundElements as Array<{ id?: string; type?: string }>) ?? []
  ).find((b) => b.type === "text");
  const labelEl = ref?.id ? live(ref.id) : null;
  if (!labelEl) return null;
  const c = center(container);
  return {
    ...bump(labelEl),
    x: c.x - (labelEl.width as number) / 2,
    y: c.y - (labelEl.height as number) / 2,
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
  const ax = arrow.x as number;
  const ay = arrow.y as number;
  const oldEnd = {
    x: ax + (points?.[points.length - 1]?.[0] ?? 0),
    y: ay + (points?.[points.length - 1]?.[1] ?? 0),
  };
  const oldStart = { x: ax, y: ay };
  const next = bump(arrow);
  const elbow =
    (arrow.customData as { elbow?: boolean } | undefined)?.elbow === true;
  // Non-elbow: keep hand-set bends where they are; only the bound endpoints
  // move, each aiming at its nearest bend (or the far element when straight).
  const bends = elbow
    ? []
    : (points ?? []).slice(1, -1).map((p) => ({ x: ax + p[0], y: ay + p[1] }));
  routeLinear(next, fromEl, toEl, oldStart, oldEnd, bends, elbow);
  return next;
}

export function applyWhiteboardOps(
  existing: unknown[],
  ops: WhiteboardOp[]
): ApplyOpsResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const created: Array<{ id: string; type: string }> = [];
  // Elements this call added, moved, resized, or grew — overlap-checked below.
  const touched = new Set<string>();

  const grewNote = (at: string, el: Mutable): void => {
    warnings.push(
      `${at}: "${el.id}" grew to ${el.width}x${el.height} to fit its label; ` +
        `move neighbors if it now crowds them.`
    );
  };

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

  // Validate cross-cutting style fields; returns null (and records an error)
  // on bad input. Enum fields (style, heads) are schema-checked upstream.
  const checkStyle = (
    at: string,
    op: WhiteboardOp,
    type: string
  ): { fill?: string } | null => {
    const linear = type === "arrow" || type === "line";
    let fill: string | undefined;
    if (op.fill !== undefined) {
      if (!FITTED_TYPES.has(type === "rect" ? "rectangle" : type)) {
        errors.push(`${at}: fill only applies to rect/ellipse/diamond.`);
        return null;
      }
      const resolved = resolveFill(op.fill);
      if (!resolved) {
        errors.push(`${at}: unknown fill "${op.fill}".`);
        return null;
      }
      fill = resolved;
    }
    if (
      (op.startHead !== undefined || op.endHead !== undefined) &&
      type !== "arrow"
    ) {
      errors.push(`${at}: startHead/endHead only apply to arrows.`);
      return null;
    }
    if ((op.via !== undefined || op.elbow !== undefined) && !linear) {
      errors.push(`${at}: via/elbow only apply to arrows and lines.`);
      return null;
    }
    if (op.via !== undefined) {
      if (
        op.via.length > 10 ||
        op.via.some(
          (p) =>
            !Array.isArray(p) ||
            p.length !== 2 ||
            p.some((n) => typeof n !== "number" || !Number.isFinite(n))
        )
      ) {
        errors.push(`${at}: via must be up to 10 [x,y] number pairs.`);
        return null;
      }
    }
    return { fill };
  };

  for (const [i, op] of ops.entries()) {
    const at = `ops[${i}]`;
    if (op.op === "add") {
      const stroke = resolveColor(op.color);
      if (!stroke) {
        errors.push(`${at}: unknown color "${op.color}".`);
        continue;
      }
      const styled = checkStyle(at, op, op.type ?? "");
      if (!styled) continue;
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
          if (styled.fill !== undefined) el.backgroundColor = styled.fill;
          if (op.style) el.strokeStyle = op.style;
          put(el);
          touched.add(el.id as string);
          created.push({ id: el.id as string, type: op.type });
          if (op.label) {
            const fit = boundLabel(el, op.label);
            put(fit.label);
            if (fit.grew) grewNote(at, el);
          }
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
          touched.add(el.id as string);
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
            startArrowhead:
              op.startHead !== undefined ? ARROWHEADS[op.startHead] : null,
            endArrowhead:
              op.endHead !== undefined
                ? ARROWHEADS[op.endHead]
                : op.type === "arrow"
                  ? "arrow"
                  : null,
          });
          if (op.type === "arrow") el.elbowed = false;
          if (op.style) el.strokeStyle = op.style;
          if (op.elbow) {
            el.customData = { ...(el.customData as Mutable), elbow: true };
          }

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
          const rawStart = { x, y };
          const rawEnd = { x: x + (op.w ?? 100), y: y + (op.h ?? 0) };
          if (op.elbow) {
            routeLinear(el, fromEl, toEl, rawStart, rawEnd, [], true);
          } else if (op.via?.length || fromEl || toEl) {
            const via = (op.via ?? []).map(([vx, vy]) => ({ x: vx, y: vy }));
            routeLinear(el, fromEl, toEl, rawStart, rawEnd, via, false);
            // Freeform bends read best as smooth curves; elbows stay crisp.
            if (via.length > 0) el.roundness = { type: 2 };
          }
          if (fromEl || toEl) {
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
          touched.add(el.id as string);
          created.push({ id: el.id as string, type: op.type });
          if (op.label) {
            const label = boundLabel(el, op.label).label;
            put(label);
            touched.add(label.id as string);
          }
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
      const styled = checkStyle(at, op, target.type as string);
      if (!styled) continue;
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
      if (styled.fill !== undefined) updated.backgroundColor = styled.fill;
      if (op.style) updated.strokeStyle = op.style;
      if (op.startHead !== undefined) {
        updated.startArrowhead = ARROWHEADS[op.startHead];
      }
      if (op.endHead !== undefined) {
        updated.endArrowhead = ARROWHEADS[op.endHead];
      }
      const movedXY = op.x !== undefined || op.y !== undefined;
      const resized = op.w !== undefined || op.h !== undefined;
      let rerouted = false;
      let grew = false;

      // Re-shape an existing arrow/line: new bends (via) or elbow routing,
      // anchored to its bindings when present.
      if (op.via !== undefined || op.elbow !== undefined) {
        const pts = updated.points as number[][] | undefined;
        const ux = updated.x as number;
        const uy = updated.y as number;
        const rawStart = { x: ux, y: uy };
        const rawEnd = {
          x: ux + (pts?.[pts.length - 1]?.[0] ?? 0),
          y: uy + (pts?.[pts.length - 1]?.[1] ?? 0),
        };
        const fromEl = live(
          (updated.startBinding as { elementId?: string } | null)?.elementId
        );
        const toEl = live(
          (updated.endBinding as { elementId?: string } | null)?.elementId
        );
        updated.customData = {
          ...(updated.customData as Mutable),
          elbow: op.elbow === true,
        };
        const via = op.elbow
          ? []
          : (op.via ?? []).map(([vx, vy]) => ({ x: vx, y: vy }));
        routeLinear(updated, fromEl, toEl, rawStart, rawEnd, via, !!op.elbow);
        updated.roundness = via.length > 0 ? { type: 2 } : null;
        rerouted = true;
        touched.add(updated.id as string);
      }

      if (op.label !== undefined && updated.type === "text") {
        const size = measureText(op.label);
        Object.assign(updated, {
          text: op.label,
          originalText: op.label,
          width: size.width,
          height: size.height,
        });
      } else if (op.label !== undefined && updated.type === "frame") {
        updated.name = op.label;
      } else if (updated.type !== "text" && updated.type !== "frame") {
        const boundText = (
          (updated.boundElements as Array<{
            id?: string;
            type?: string;
          }>) ?? []
        ).find((b) => b.type === "text");
        const labelEl = boundText?.id ? live(boundText.id) : null;
        if (op.label !== undefined && !labelEl) {
          const fit = boundLabel(updated, op.label);
          put(fit.label);
          touched.add(fit.label.id as string);
          grew = fit.grew;
        } else if (labelEl && (op.label !== undefined || resized)) {
          // Label or size changed: re-wrap to the new geometry.
          const next = bump(labelEl);
          const text =
            op.label ??
            (labelEl.originalText as string | undefined) ??
            (labelEl.text as string);
          grew = layoutBoundText(updated, next, text);
          put(next);
          touched.add(next.id as string);
        } else if (labelEl && (movedXY || rerouted)) {
          // Pure move: re-center without re-wrapping user-formatted text.
          const moved = recenteredLabel(updated, live);
          if (moved) put(moved);
        }
      }
      if (grew) grewNote(at, updated);

      put(updated);
      const geometryChanged =
        movedXY ||
        resized ||
        grew ||
        (op.label !== undefined && updated.type === "text");
      if (geometryChanged) {
        touched.add(updated.id as string);
        // Attached arrows must follow the moved/grown element.
        for (const ref of (updated.boundElements as Array<{
          id?: string;
          type?: string;
        }>) ?? []) {
          if (ref.type !== "arrow" || !ref.id) continue;
          const arrow = live(ref.id);
          if (!arrow) continue;
          const rerouted = rerouteArrow(arrow, live);
          if (rerouted) {
            put(rerouted);
            touched.add(rerouted.id as string);
            // The arrow's own label must follow it to the new midpoint —
            // and its landing spot needs the same overlap check as any move.
            const label = recenteredLabel(rerouted, live);
            if (label) {
              put(label);
              touched.add(label.id as string);
            }
          }
        }
      }
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

  warnings.push(...overlapWarnings(byId, touched));
  warnings.push(...crossingWarnings(byId, touched));

  return {
    elements: sendConnectorsToBack([...order, ...appended], byId),
    created,
    errors,
    warnings,
  };
}

// Agent-drawn arrows/lines render BENEATH shapes: a connector that still
// crosses something reads as passing behind the box, not through its text.
// User elements keep their relative order; arrow labels stay on top.
function sendConnectorsToBack(
  ids: string[],
  byId: Map<string, Mutable>
): unknown[] {
  const isConnector = (id: string): boolean => {
    const el = byId.get(id);
    return (
      (el?.type === "arrow" || el?.type === "line") &&
      (el?.customData as { author?: string } | undefined)?.author === "agent"
    );
  };
  const connectors = ids.filter(isConnector);
  if (connectors.length === 0) return ids.map((id) => byId.get(id));
  const rest = ids.filter((id) => !isConnector(id));
  // Excalidraw orders by fractional index when present, which would undo the
  // array move — null the index of any connector we displaced so the editor
  // re-assigns one matching its new position.
  const firstShape = ids.findIndex((id) => !isConnector(id));
  for (const id of connectors) {
    const el = byId.get(id) as Mutable;
    if (ids.indexOf(id) > firstShape && el.index !== null) {
      byId.set(id, { ...el, index: null });
    }
  }
  return [...connectors, ...rest].map((id) => byId.get(id));
}

const MAX_OVERLAP_WARNINGS = 6;
// Ignore near-touches; only clearly overlapping shapes are worth a warning.
const OVERLAP_SLACK = 4;

function overlapCandidate(
  el: Mutable | undefined,
  byId: Map<string, Mutable>
): el is Mutable {
  if (!el || el.isDeleted === true) return false;
  if (FITTED_TYPES.has(el.type as string)) return true;
  if (el.type !== "text") return false;
  // Standalone text sprawled over a shape is the classic mess. Shape labels
  // are positioned by us inside their shape and skipped — but arrow labels
  // sit at the arrow midpoint, which can land on unrelated elements.
  if (!el.containerId) return true;
  const container = byId.get(el.containerId as string);
  return container?.type === "arrow" || container?.type === "line";
}

// Is `label` bound to an arrow that starts or ends at `shape`? Labels on a
// short arrow legitimately sit close to its own endpoints.
function boundToNeighbor(
  label: Mutable,
  shape: Mutable,
  byId: Map<string, Mutable>
): boolean {
  const container = byId.get(label.containerId as string);
  if (!container) return false;
  const sb = container.startBinding as { elementId?: string } | null;
  const eb = container.endBinding as { elementId?: string } | null;
  return sb?.elementId === shape.id || eb?.elementId === shape.id;
}

// Overlaps involving an arrow's label blame the arrow, not the random text id.
function describeForOverlap(el: Mutable): string {
  return el.type === "text" && el.containerId
    ? `the label of "${el.containerId}"`
    : `"${el.id}"`;
}

// Bounding-box overlap worth warning about. Shape-in-shape containment is
// often intentional (a badge inside a box) and exempt — but text inside an
// unrelated shape is exactly the clutter we're hunting, so it always counts.
function overlapsBadly(a: Mutable, b: Mutable): boolean {
  const ax = a.x as number;
  const ay = a.y as number;
  const aw = a.width as number;
  const ah = a.height as number;
  const bx = b.x as number;
  const by = b.y as number;
  const bw = b.width as number;
  const bh = b.height as number;
  const ix = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const iy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  if (ix <= OVERLAP_SLACK || iy <= OVERLAP_SLACK) return false;
  if (a.type === "text" || b.type === "text") return true;
  const aInB = ax >= bx && ay >= by && ax + aw <= bx + bw && ay + ah <= by + bh;
  const bInA = bx >= ax && by >= ay && bx + bw <= ax + aw && by + bh <= ay + ah;
  return !aInB && !bInA;
}

// Warn about elements this call placed (or grew) on top of other elements.
function overlapWarnings(
  byId: Map<string, Mutable>,
  touched: Set<string>
): string[] {
  const warnings: string[] = [];
  const reported = new Set<string>();
  let extra = 0;
  for (const id of touched) {
    const el = byId.get(id);
    if (!overlapCandidate(el, byId)) continue;
    for (const [otherId, other] of byId) {
      if (otherId === id) continue;
      if (touched.has(otherId) && reported.has(`${otherId}|${id}`)) continue;
      if (!overlapCandidate(other, byId)) continue;
      // An arrow's label may touch the arrow's own endpoints; skip that pair.
      if (el.containerId && boundToNeighbor(el, other, byId)) continue;
      if (other.containerId && boundToNeighbor(other, el, byId)) continue;
      if (!overlapsBadly(el, other)) continue;
      reported.add(`${id}|${otherId}`);
      if (warnings.length >= MAX_OVERLAP_WARNINGS) {
        extra++;
        continue;
      }
      warnings.push(
        `${describeForOverlap(el)} overlaps ${describeForOverlap(other)} — ` +
          `move or resize one (update x/y) to keep the board readable.`
      );
    }
  }
  if (extra > 0) warnings.push(`…and ${extra} more overlapping pair(s).`);
  return warnings;
}

const MAX_CROSSING_WARNINGS = 6;

// Does the segment (x1,y1)→(x2,y2) pass through the box? Liang–Barsky clip;
// a graze along the edge (chord shorter than ~2px) doesn't count.
function segmentHitsBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bx: number,
  by: number,
  bw: number,
  bh: number
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - bx, bx + bw - x1, y1 - by, by + bh - y1];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return (t1 - t0) * Math.hypot(dx, dy) > 2;
}

// Shapes an arrow should not be drawn through: closed shapes and free text.
// Ellipses/diamonds use their bbox — close enough for a routing nudge.
function crossingTarget(el: Mutable | undefined): el is Mutable {
  if (!el || el.isDeleted === true) return false;
  if (FITTED_TYPES.has(el.type as string)) return true;
  return el.type === "text" && !el.containerId;
}

// Warn when an arrow/line's path cuts through a shape it isn't bound to.
// Arrows only know their endpoints; without this the agent cannot tell that
// a "clean" straight arrow slices through three boxes on its way.
function crossingWarnings(
  byId: Map<string, Mutable>,
  touched: Set<string>
): string[] {
  const warnings: string[] = [];
  let extra = 0;
  for (const [arrowId, arrow] of byId) {
    if (arrow.type !== "arrow" && arrow.type !== "line") continue;
    if (arrow.isDeleted === true) continue;
    const points = arrow.points as number[][] | undefined;
    if (!Array.isArray(points) || points.length < 2) continue;
    const ax = arrow.x as number;
    const ay = arrow.y as number;
    const boundIds = new Set(
      [
        (arrow.startBinding as { elementId?: string } | null)?.elementId,
        (arrow.endBinding as { elementId?: string } | null)?.elementId,
      ].filter((id): id is string => typeof id === "string")
    );
    for (const [shapeId, shape] of byId) {
      if (shapeId === arrowId || boundIds.has(shapeId)) continue;
      if (!touched.has(arrowId) && !touched.has(shapeId)) continue;
      if (!crossingTarget(shape)) continue;
      // Inset by the slack so brushing a border doesn't count.
      const bx = (shape.x as number) + OVERLAP_SLACK;
      const by = (shape.y as number) + OVERLAP_SLACK;
      const bw = (shape.width as number) - OVERLAP_SLACK * 2;
      const bh = (shape.height as number) - OVERLAP_SLACK * 2;
      if (bw <= 0 || bh <= 0) continue;
      const hit = points.some((p, i) => {
        if (i === 0) return false;
        const prev = points[i - 1];
        return segmentHitsBox(
          ax + prev[0],
          ay + prev[1],
          ax + p[0],
          ay + p[1],
          bx,
          by,
          bw,
          bh
        );
      });
      if (!hit) continue;
      if (warnings.length >= MAX_CROSSING_WARNINGS) {
        extra++;
        continue;
      }
      warnings.push(
        `"${arrowId}" passes through "${shapeId}" — reroute it around ` +
          `(elbow:true or via bend points) or move one of them.`
      );
    }
  }
  if (extra > 0) warnings.push(`…and ${extra} more arrow crossing(s).`);
  return warnings;
}
