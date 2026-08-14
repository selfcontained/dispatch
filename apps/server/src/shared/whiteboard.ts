type RawElement = Record<string, unknown>;

export type SimplifiedElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  text?: string;
  containerId?: string;
  from?: string;
  to?: string;
  frameId?: string;
  strokeColor?: string;
  backgroundColor?: string;
};

export type WhiteboardGetResult = {
  elements: SimplifiedElement[];
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  snapshotPath: string | null;
  snapshotStale: boolean;
};

export type WhiteboardUpdateResult = {
  version: number;
  elementCount: number;
  addedIds: string[];
  updatedIds: string[];
  deletedIds: string[];
  elements: SimplifiedElement[];
};

// Excalidraw's restoreElements() calls isInvisiblySmallElement() — which reads
// `element.points.length` unguarded — before restoreElement() applies its own
// defaults. A points-less arrow therefore throws and takes down the whole view,
// so we normalize these fields before the data ever reaches the editor.
const POINTS_REQUIRED_TYPES = new Set(["arrow", "line", "draw", "freedraw"]);

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPoint(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

export function sanitizeElement(raw: unknown): RawElement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const el = raw as RawElement;
  if (typeof el.id !== "string" || typeof el.type !== "string") return null;

  const width = finite(el.width);
  const height = finite(el.height);
  const out: RawElement = {
    ...el,
    x: finite(el.x),
    y: finite(el.y),
    width,
    height,
  };

  if (POINTS_REQUIRED_TYPES.has(el.type)) {
    const points = Array.isArray(el.points) ? el.points.filter(isPoint) : [];
    // Same fallback restoreElement() would apply, just early enough to matter.
    const usedFallback = points.length < 2;
    out.points = usedFallback
      ? [
          [0, 0],
          [width, height],
        ]
      : points;

    // The freedraw renderer indexes pressures[i] per point when
    // simulatePressure is falsy, so a missing or short pressures array throws
    // the same way missing points did. Default to 0.5 as Excalidraw's own
    // restore does.
    if (el.type === "freedraw" && el.simulatePressure !== true) {
      const pressures = Array.isArray(el.pressures) ? el.pressures : [];
      out.pressures = (out.points as unknown[]).map((_, i) => {
        const pressure = usedFallback ? undefined : pressures[i];
        return typeof pressure === "number" && Number.isFinite(pressure)
          ? pressure
          : 0.5;
      });
    }
  }

  return out;
}

export function sanitizeElements(elements: unknown[]): unknown[] {
  const out: RawElement[] = [];
  for (const raw of elements) {
    const el = sanitizeElement(raw);
    if (el) out.push(el);
  }
  return out;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function simplifyElements(elements: unknown[]): SimplifiedElement[] {
  const out: SimplifiedElement[] = [];
  for (const raw of elements) {
    if (typeof raw !== "object" || raw === null) continue;
    const el = raw as RawElement;
    if (el.isDeleted === true) continue;

    const simplified: SimplifiedElement = {
      id: str(el.id) ?? "",
      type: str(el.type) ?? "unknown",
      x: num(el.x),
      y: num(el.y),
      width: num(el.width),
      height: num(el.height),
    };
    if (typeof el.angle === "number" && Math.abs(el.angle) > 0.01) {
      simplified.angle = Number((el.angle as number).toFixed(2));
    }
    const text = str(el.text) ?? str(el.originalText);
    if (text) simplified.text = text;
    const containerId = str((el as { containerId?: unknown }).containerId);
    if (containerId) simplified.containerId = containerId;
    const startBinding = el.startBinding as { elementId?: unknown } | null;
    const endBinding = el.endBinding as { elementId?: unknown } | null;
    const from = str(startBinding?.elementId);
    const to = str(endBinding?.elementId);
    if (from) simplified.from = from;
    if (to) simplified.to = to;
    const frameId = str(el.frameId);
    if (frameId) simplified.frameId = frameId;
    const strokeColor = str(el.strokeColor);
    if (strokeColor) simplified.strokeColor = strokeColor;
    const backgroundColor = str(el.backgroundColor);
    if (backgroundColor && backgroundColor !== "transparent") {
      simplified.backgroundColor = backgroundColor;
    }
    out.push(simplified);
  }
  return out;
}
