// Reduce raw Excalidraw elements to a compact, agent-readable summary:
// geometry, text, connections. Style noise (seeds, versions, strokes,
// roundness) is stripped — agents get the PNG snapshot for visual detail.

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

// Result shapes shared by the MCP handlers (server/mcp-whiteboard-handlers.ts)
// and the tool/context layers (shared/mcp) — one definition, three consumers.
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
  created: Array<{ id: string; type: string }>;
  errors: string[];
  warnings: string[];
  elements: SimplifiedElement[];
};

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
