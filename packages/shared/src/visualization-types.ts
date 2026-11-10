/** Versioned, inert communication data. No executable library options or markup. */
export const GRAPH_COLORS = [
  "cyan",
  "pink",
  "lime",
  "orange",
  "purple",
  "yellow",
] as const;
export const CHART_TYPES = [
  "bar",
  "line",
  "area",
  "scatter",
  "heatmap",
  "histogram",
  "waterfall",
  "interval",
  "bullet",
  "timeline",
] as const;
export type GraphColor = (typeof GRAPH_COLORS)[number];
export type ChartType = (typeof CHART_TYPES)[number];
export type VisualizationMeta = {
  version: 1;
  title: string;
  unit: string;
  dataKind: "measured" | "estimated" | "synthetic";
  description?: string;
  source?: string;
  asOf?: string;
};
export type MetricData = VisualizationMeta & {
  value: number | null;
  comparison?: { value: number; label: string };
};
export type ChartData = VisualizationMeta & {
  type: ChartType;
  xLabel: string;
  xUnit?: string;
  series: Array<{ id: string; label: string; color: GraphColor }>;
  /** Null values are missing, never zero. Interval/timeline use [start,end]. */
  points: Array<{
    label: string;
    values: Array<number | null>;
    x?: number;
    from?: number;
    to?: number;
  }>;
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !keys.includes(key)))
    throw new Error("Unknown visualization field.");
  return v;
}
function label(value: unknown, max = 160): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Expected text of 1–${max} characters.`);
}
function numeric(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1e15
  )
    throw new Error(
      "Values must be finite numbers within ±1e15 (or explicit null for missing values)."
    );
}
const metaKeys = [
  "version",
  "title",
  "unit",
  "dataKind",
  "description",
  "source",
  "asOf",
];
export function parseVisualization(kind: "metric", value: unknown): MetricData;
export function parseVisualization(kind: "chart", value: unknown): ChartData;
export function parseVisualization(
  kind: "metric" | "chart",
  value: unknown
): MetricData | ChartData;
export function parseVisualization(
  kind: "metric" | "chart",
  value: unknown
): MetricData | ChartData {
  // Bound the serialized UTF-8 payload, including optional explanation text.
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
    throw new Error("Visualization exceeds 64KiB.");
  const v = object(value, [
    ...metaKeys,
    ...(kind === "metric"
      ? ["value", "comparison"]
      : ["type", "xLabel", "xUnit", "series", "points"]),
  ]);
  if (v.version !== 1) throw new Error("Unsupported visualization version.");
  label(v.title);
  label(v.unit);
  if (!["measured", "estimated", "synthetic"].includes(v.dataKind as string))
    throw new Error("dataKind must be measured, estimated or synthetic.");
  for (const key of ["description", "source", "asOf"])
    if (v[key] !== undefined) label(v[key], key === "asOf" ? 160 : 2000);
  if (kind === "metric") {
    numeric(v.value, true);
    if (v.comparison !== undefined) {
      const c = object(v.comparison, ["value", "label"]);
      numeric(c.value);
      label(c.label);
    }
    return v as unknown as MetricData;
  }
  if (!CHART_TYPES.includes(v.type as ChartType))
    throw new Error("Unsupported chart type.");
  label(v.xLabel);
  if (v.xUnit !== undefined) label(v.xUnit);
  if (!Array.isArray(v.series) || v.series.length < 1 || v.series.length > 6)
    throw new Error("Use 1–6 series.");
  const ids = new Set();
  const colors = new Set();
  for (const entry of v.series) {
    const s = object(entry, ["id", "label", "color"]);
    label(s.id, 64);
    label(s.label);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s.id as string) || ids.has(s.id))
      throw new Error("Series IDs must be unique safe identifiers.");
    if (!GRAPH_COLORS.includes(s.color as GraphColor) || colors.has(s.color))
      throw new Error("Use unique named graph colors for each series.");
    ids.add(s.id);
    colors.add(s.color);
  }
  const range = v.type === "interval" || v.type === "timeline";
  if ((range || v.type === "waterfall") && v.series.length !== 1)
    throw new Error("Range, timeline and waterfall charts use one series.");
  if (v.type === "bullet" && v.series.length !== 2)
    throw new Error("Bullet needs actual and target series, in that order.");
  if ((v.type === "scatter" || v.type === "histogram") && !v.xUnit)
    throw new Error(
      "Scatter and histogram need explicit xUnit; unit is the y unit."
    );
  if (!Array.isArray(v.points) || v.points.length > 200)
    throw new Error("Use at most 200 points.");
  let previousEnd: number | undefined;
  let binWidth: number | undefined;
  let total = 0;
  for (const entry of v.points) {
    const p = object(entry, ["label", "values", "x", "from", "to"]);
    label(p.label);
    if (
      !Array.isArray(p.values) ||
      p.values.length !== (range ? 2 : v.series.length)
    )
      throw new Error(
        "Point values must match series (or [start,end] for interval/timeline)."
      );
    for (const n of p.values) numeric(n, true);
    if (v.type === "scatter") numeric(p.x);
    else if (p.x !== undefined)
      throw new Error("x is only supported by scatter.");
    if (v.type === "histogram") {
      numeric(p.from);
      numeric(p.to);
      if ((p.from as number) >= (p.to as number))
        throw new Error(
          "Histogram bins must be ordered, non-overlapping ranges."
        );
      const width = (p.to as number) - (p.from as number);
      if (binWidth !== undefined) {
        // Account for endpoint subtraction rounding without treating a whole
        // declared unit as the tolerance floor for tiny bins. Cap the allowance
        // relative to the first bin so low-precision coordinates cannot justify
        // visibly different widths or gaps.
        const coordinateScale = Math.max(
          Math.abs(p.from as number),
          Math.abs(p.to as number),
          Math.abs(previousEnd as number)
        );
        const tolerance = Math.max(
          binWidth * 1e-9,
          Math.min(binWidth * 1e-6, Number.EPSILON * coordinateScale * 4)
        );
        if (
          Math.abs(width - binWidth) > tolerance ||
          Math.abs((p.from as number) - (previousEnd as number)) > tolerance
        )
          throw new Error(
            "Histogram bins must have equal widths and be contiguous."
          );
      }
      binWidth ??= width;
      previousEnd = p.to as number;
      if (p.values.some((n) => n !== null && (n as number) < 0))
        throw new Error("Histogram counts cannot be negative.");
    } else if (p.from !== undefined || p.to !== undefined)
      throw new Error("Bin boundaries are only supported by histogram.");
    if (
      range &&
      ((p.values[0] === null) !== (p.values[1] === null) ||
        (p.values[0] !== null &&
          (p.values[0] as number) > (p.values[1] as number)))
    )
      throw new Error("Ranges need ordered finite endpoints or two nulls.");
    if (v.type === "waterfall") {
      if (p.values[0] !== null) total += p.values[0] as number;
      if (!Number.isFinite(total) || Math.abs(total) > 1e15)
        throw new Error("Waterfall total overflow.");
    }
  }
  return v as unknown as ChartData;
}

/** A single authored post containing related metrics OR charts, never nested groups. */
export type VisualizationGroupData = {
  version: 1;
  title?: string;
  items: Array<
    { kind: "metric"; data: MetricData } | { kind: "chart"; data: ChartData }
  >;
};
export function parseVisualizationGroup(
  value: unknown
): VisualizationGroupData {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
    throw new Error("Visualization group exceeds 64KiB.");
  const group = object(value, ["version", "title", "items"]);
  if (group.version !== 1)
    throw new Error("Unsupported visualization group version.");
  if (group.title !== undefined) label(group.title);
  if (
    !Array.isArray(group.items) ||
    group.items.length < 1 ||
    group.items.length > 6
  )
    throw new Error("Group 1–6 related metrics or charts.");
  let itemKind: unknown;
  for (const value of group.items) {
    const item = object(value, ["kind", "data"]);
    if (item.kind !== "metric" && item.kind !== "chart")
      throw new Error("Groups contain metrics or charts, not nested groups.");
    if (itemKind !== undefined && itemKind !== item.kind)
      throw new Error("Group metrics together or charts together.");
    itemKind = item.kind;
    parseVisualization(item.kind, item.data);
  }
  return group as unknown as VisualizationGroupData;
}
