# Metric and chart communication blocks

Agents post independent metric/chart blocks through the existing `post` tool and
replace their payload through `update({ id, data })`. No review badges, palette
picker, gallery wrapper, dashboard collection, or provider calls ship with them.

## Metric

```json
{
  "metric": {
    "version": 1,
    "title": "Items delivered",
    "unit": "items",
    "dataKind": "synthetic",
    "value": 74,
    "comparison": { "value": 6, "label": "since Thursday" }
  }
}
```

Values display compactly; the exact number remains available to assistive
technology and in the value's title. Null means missing.

## Chart

```json
{
  "chart": {
    "version": 1,
    "type": "line",
    "title": "Workstream progress",
    "unit": "items",
    "xLabel": "Day",
    "dataKind": "synthetic",
    "series": [
      { "id": "design", "label": "Design", "color": "cyan" },
      { "id": "build", "label": "Build", "color": "pink" },
      { "id": "review", "label": "Review", "color": "lime" }
    ],
    "points": [
      { "label": "Monday", "values": [10, 20, 30] },
      { "label": "Tuesday", "values": [12, null, 34] }
    ]
  }
}
```

`version`, `title`, `unit` and `dataKind` are required for both kinds. dataKind is
measured, estimated or synthetic, as declared by the author. Optional description,
source and asOf are plain explanatory text, never fetched or executed. Those
fields do not override server-owned authorship, routing or immutable provenance.

Series IDs and named colors are explicit and unique; reordering a series should
move its ID, color and values together. Supported graph slots are cyan, pink,
lime, orange, purple and yellow. Dedicated neon tokens have deeper light-theme
counterparts. Dash patterns and labeled exact tables complement color.

| Type               | Point semantics                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bar, line, area    | One value per series; null is missing. Area baseline is zero, with unstacked translucent fills.                                                                               |
| scatter            | Numeric x plus one y value per series; xLabel/xUnit explicitly describe x; unit describes y.                                                                                  |
| heatmap            | One row label and one numeric/missing cell per series. A common continuous scale includes zero; missing cells are uncolored.                                                  |
| histogram          | Contiguous, equal-width numeric bins with from/to and explicit xUnit; values are nonnegative frequencies. Labels cannot replace exact bin boundaries.                         |
| waterfall          | One series; each value is a signed delta. Starts at zero. Missing delta makes following cumulative positions unknown. Exact table includes input delta and derived start/end. |
| interval, timeline | One series; values are [start,end] in the stated unit, or [null,null]. Timeline values are numeric offsets, not executable dates.                                             |
| bullet             | Two series in actual, target order; values give a bar and target dot for each row.                                                                                            |

Exact tables expose raw plotted values, scatter coordinates, histogram boundaries,
range endpoints and waterfall cumulative positions. No interpolation fills nulls.
Cartesian domains include zero; long labels may shorten on axes, with full labels
in the table. Large horizontal datasets scroll inside a bounded chart viewport.

Limits: six series, 200 points, 64KiB UTF-8 encoded payload, 160-character labels,
2,000-character explanations/source, unique safe series IDs up to 64 characters.
Numbers must be finite and within ±1e15 to keep derived plot geometry bounded.
Unknown versions, malformed data, inconsistent row arity, duplicated series/colors,
reversed ranges, overlapping/unequal histogram bins and overflow totals fail
validation. Renderer fallback handles invalid/unsupported payloads without code
execution. JSON does not accept arbitrary chart library props, HTML, callbacks,
URLs to execute, custom CSS colors or source requests.

## Integration and library

Uses existing shared BlockBody, blocks.data persistence, chat service post/update
ownership/routing, stream/thread feeds and MCP schemas. A kind-constraint migration
adds metric/chart. Full payload replacement is validated before writing; existing
service-owned delivery intent is preserved. A recipient cannot replace an author's
chart data. Structured data also travels in agent delivery/history envelopes.

Reuse installed Recharts 3.8.1 and the shadcn ChartContainer/tooltip composition.
Renderer is lazy-loaded from the chat body; no new dependency is added. Heatmaps
use a native table with colored cells. Other types compose existing Recharts
primitives. No UI changes to Markdown's list renderer are included.

Official references:

- https://recharts.github.io/en-US/guide/sizes/
- https://github.com/recharts/recharts/blob/main/storybook/stories/API/Accessibility.mdx
- https://recharts.github.io/en-US/examples/LineChartConnectNulls/
- https://recharts.github.io/en-US/examples/Waterfall/

## Review state

Initial standalone gallery and subsequent development-only review controls were
removed at the user's request. Current previews show actual independent persisted
blocks, including six-series samples and all ten types. User selected a stronger
neon direction and smaller samples during iteration; final visual acceptance and
merge approval remain required. No additional chart families or collection flows
are implied by this contract.

## Grouping proposal (awaiting approval)

At the user's request, `visualizationGroup` posts one authored group containing
1–6 related metrics OR charts. Items have `{kind: "metric"|"chart", data: ...}`;
nested groups and mixed metric/chart groups are excluded. The group has version 1
and an optional title; its total payload remains bounded at 64KiB. Updates replace
the group payload through the same ownership boundary as individual blocks.

Agents choose grouping intent, not column counts. Container queries use the
available message width: metrics wrap through one/two/three/four columns; chart
groups through one/two/three. A single metric is a compact tile. Related group
members share the post's author, routing and thread; unrelated posts never auto-pack.
Desktop and mobile proposal captures show the actual grouped renderer.

Tests and checks remain paused by explicit user instruction until visual proposal
approval. Latest grouping/heatmap changes are intentionally unverified by those
checks; earlier passing results must not be represented as final-head evidence.
