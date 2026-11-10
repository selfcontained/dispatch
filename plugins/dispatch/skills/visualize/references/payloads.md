# Visualization payloads

All payloads use version 1. Required shared fields: title, unit and dataKind
(measured, estimated or synthetic). Optional description and source are plain
text; optional asOf explains freshness. Source declarations are author-supplied.
No source is fetched automatically.

## Metric

```js
post({
  metric: {
    version: 1,
    title: "Bundle size",
    value: 184,
    unit: "KiB",
    dataKind: "measured",
    comparison: { value: -23, label: "since previous build" },
    source: "Production build output",
  },
});
```

value is a number or null. comparison is optional and carries a numeric value
in the same unit plus its explanatory label. Supply actual comparison data;
Dispatch does not calculate the difference. The renderer may abbreviate large
numbers while retaining exact values.

## Chart

```js
post({
  chart: {
    version: 1,
    type: "line",
    title: "Workstream progress",
    unit: "items",
    xLabel: "Day",
    dataKind: "synthetic",
    series: [
      { id: "design", label: "Design", color: "cyan" },
      { id: "build", label: "Build", color: "pink" },
      { id: "review", label: "Review", color: "lime" },
    ],
    points: [
      { label: "Monday", values: [10, 20, 30] },
      { label: "Tuesday", values: [12, null, 34] },
    ],
  },
});
```

Values align with the ordered series array. IDs must be unique safe identifiers
starting with a letter, followed by letters, digits, underscores or hyphens.
Colors must be unique within a chart: cyan, pink, lime, orange, purple or yellow.
Keep IDs/colors associated with the same series when changing their order.
unit describes the plotted values; xLabel describes the horizontal categories
or dimension. Scatter and histogram additionally require xUnit.

| type               | Point data and constraints                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| bar, line, area    | label and one numeric/null value per series; area is unstacked with a zero baseline                                          |
| scatter            | label, numeric x, one y value per series; xLabel/xUnit describe x, unit describes y                                          |
| heatmap            | label for the row, one numeric/null cell per series; one continuous color scale                                              |
| histogram          | label, numeric from/to bin boundaries, nonnegative frequencies per series; bins must be contiguous, equally wide and ordered |
| waterfall          | One series; values contains one signed delta. Starts at zero. A missing delta leaves subsequent cumulative positions unknown |
| interval, timeline | One series; values is [start,end], ordered in the stated unit, or [null,null]. Timeline uses numeric offsets                 |
| bullet             | Two series in actual, target order; values contains those two measurements per row                                           |

## Related groups

```js
post({
  visualizationGroup: {
    version: 1,
    title: "Delivery summary",
    items: [
      {
        kind: "metric",
        data: {
          version: 1,
          title: "Delivered",
          unit: "items",
          dataKind: "synthetic",
          value: 74,
        },
      },
      {
        kind: "metric",
        data: {
          version: 1,
          title: "Workstreams",
          unit: "active",
          dataKind: "synthetic",
          value: 6,
        },
      },
    ],
  },
});
```

A group contains 1–6 items of the same kind: metric or chart. Its title is
optional. Each item carries a complete metric or chart payload. There are no
nested groups, mixed-kind groups or layout properties. Responsive arrangement
belongs to Dispatch; grouping intent belongs to the author.

## Updates and bounds

Keep the ID from post, then replace the entire payload:

```js
update({ id: blockId, data: { ...previousPayload, value: 80 } });
```

For a group, replace its complete version/title/items payload. The tool updates
the existing block's kind; do not wrap replacement data in metric/chart/group.
Reuse the original conversation and identity permissions.

Limits: six series, 200 points per chart, six items per group, 64KiB UTF-8 payload
including all grouped items. Numeric magnitude is bounded at ±1e15; all numbers
and derived waterfall totals must be finite. Labels are 1–160 characters; series
IDs up to 64; description/source up to 2,000. Units are required even for counts
or percentages. Empty points arrays are supported; unknown versions and unknown
fields are rejected. Do not supply callbacks, HTML, arbitrary CSS colors, axis
truncation settings or Recharts configuration.
