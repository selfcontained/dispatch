import { parseVisualizationGroup } from "@dispatch/shared";
import { describe, it, expect } from "vitest";
import {
  CHART_TYPES,
  parseVisualization,
  type ChartData,
} from "@dispatch/shared";
import { resolveKindAndData } from "../src/chat/service.js";
import { chartSchema } from "../src/chat/visualization-schema.js";
const base: ChartData = {
  version: 1,
  title: "Delivery",
  unit: "items",
  dataKind: "synthetic",
  type: "bar",
  xLabel: "Day",
  series: [{ id: "observed", label: "Observed", color: "cyan" }],
  points: [{ label: "Mon", values: [42] }],
};
describe("visualization contract", () => {
  it("accepts six series, missing observations and empty data", () => {
    const colors = [
      "cyan",
      "pink",
      "lime",
      "orange",
      "purple",
      "yellow",
    ] as const;
    const chart = {
      ...base,
      series: colors.map((color, i) => ({
        id: `series${i}`,
        label: `Series ${i}`,
        color,
      })),
      points: [{ label: "Day", values: [1, 2, null, 4, 5, 6] }],
    };
    expect(parseVisualization("chart", chart)).toEqual(chart);
    expect(
      parseVisualization("chart", { ...chart, points: [] }).points
    ).toEqual([]);
    expect(resolveKindAndData({ chart }).kind).toBe("chart");
    expect(chartSchema.safeParse(chart).success).toBe(true);
  });
  it.each(CHART_TYPES)("validates %s semantics", (type) => {
    const data = {
      ...base,
      type,
      ...(type === "bullet"
        ? {
            series: [
              ...base.series,
              { id: "target", label: "Target", color: "pink" as const },
            ],
          }
        : {}),
      ...(type === "scatter" || type === "histogram"
        ? { xUnit: "seconds" }
        : {}),
      points: [
        {
          label: "Example",
          values:
            type === "bullet" || type === "interval" || type === "timeline"
              ? [2, 4]
              : [2],
          ...(type === "scatter" ? { x: 1 } : {}),
          ...(type === "histogram" ? { from: 0, to: 10 } : {}),
        },
      ],
    };
    expect(parseVisualization("chart", data).type).toBe(type);
  });
  it.each([NaN, Infinity, -Infinity, 1e16])(
    "rejects unsafe numeric %s",
    (value) =>
      expect(() =>
        parseVisualization("chart", {
          ...base,
          points: [{ label: "x", values: [value] }],
        })
      ).toThrow()
  );
  it("rejects version, malformed, oversized, spoofed and executable payloads", () => {
    for (const patch of [
      { version: 2 },
      { html: "<script/>" },
      { author: { kind: "system" } },
      { series: [base.series[0], base.series[0]] },
      { points: Array(201).fill(base.points[0]) },
      { points: [{ label: "x", values: [] }] },
      { source: "x".repeat(2001) },
      { title: "" },
    ])
      expect(() =>
        parseVisualization("chart", { ...base, ...patch })
      ).toThrow();
    expect(() =>
      resolveKindAndData({
        chart: base,
        question: { options: [{ label: "Hi" }] },
      })
    ).toThrow();
  });
  it("rejects misleading histogram bins, ranges and missing scatter units", () => {
    expect(() =>
      parseVisualization("chart", {
        ...base,
        type: "scatter",
        points: [{ label: "x", x: 1, values: [2] }],
      })
    ).toThrow();
    expect(() =>
      parseVisualization("chart", {
        ...base,
        type: "interval",
        points: [{ label: "x", values: [4, 2] }],
      })
    ).toThrow();
    expect(() =>
      parseVisualization("chart", {
        ...base,
        type: "histogram",
        xUnit: "ms",
        points: [
          { label: "a", from: 0, to: 10, values: [1] },
          { label: "b", from: 10, to: 30, values: [2] },
        ],
      })
    ).toThrow();
  });
  it("preserves exact metric value and rejects provenance overrides", () => {
    const metric = {
      version: 1 as const,
      title: "Count",
      unit: "items",
      dataKind: "measured" as const,
      value: 123456789.125,
    };
    expect(parseVisualization("metric", metric).value).toBe(123456789.125);
    expect(() =>
      parseVisualization("metric", {
        ...metric,
        provenance: { author: "user" },
      })
    ).toThrow();
  });
});

describe("visualization groups", () => {
  const metric = {
    version: 1 as const,
    title: "Count",
    unit: "items",
    dataKind: "synthetic" as const,
    value: 12,
  };
  it("preserves related items and rejects nesting, mixed groups and layout controls", () => {
    const group = {
      version: 1,
      title: "Summary",
      items: [
        { kind: "metric", data: metric },
        { kind: "metric", data: { ...metric, title: "Other", value: 20 } },
      ],
    };
    expect(parseVisualizationGroup(group).items).toHaveLength(2);
    for (const invalid of [
      { ...group, columns: 3 },
      { ...group, items: [] },
      { ...group, items: Array(7).fill(group.items[0]) },
      { ...group, items: [{ kind: "visualization_group", data: group }] },
      { ...group, items: [group.items[0], { kind: "chart", data: base }] },
    ])
      expect(() => parseVisualizationGroup(invalid)).toThrow();
    expect(
      resolveKindAndData({ visualizationGroup: parseVisualizationGroup(group) })
        .kind
    ).toBe("visualization_group");
  });
});

it("keeps histogram width/contiguity tolerance relative even for picosecond bins", () => {
  const bins = (ranges: number[][]) => ({
    ...base,
    type: "histogram",
    xUnit: "seconds",
    points: ranges.map(([from, to], i) => ({
      label: `Bin ${i}`,
      from,
      to,
      values: [1],
    })),
  });
  for (const ranges of [
    [
      [0, 1e-12],
      [1e-12, 1e-10],
    ],
    [
      [0, 1e-12],
      [9e-10, 9.01e-10],
    ],
    [
      [0, 1e-12],
      [0.5e-12, 1.5e-12],
    ],
  ])
    expect(() => parseVisualization("chart", bins(ranges))).toThrow();
  for (const ranges of [
    [
      [0, 1e-12],
      [1e-12, 2e-12],
      [2e-12, 3e-12],
    ],
    [
      [0, 0.1],
      [0.1, 0.2],
      [0.2, 0.1 + 0.2],
    ],
  ])
    expect(() => parseVisualization("chart", bins(ranges))).not.toThrow();
});
