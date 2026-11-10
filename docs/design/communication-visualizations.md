# Metric and chart blocks — design checkpoint

Status: review prototype; visual selection pending. No production block contract changed.
Preview: `/design-options.html` on the isolated web stack (development entry only).

## Directions

All three show identical synthetic delivery data: observed 42, 56, missing, 68,
74 items; planned 40, 50, 60, 65, 70. The metric is Friday's 74 items, with a
6-item change from Thursday. These are communication examples, not collected
session analytics.

1. Compact inline: 160px charts and restrained cards. Fits frequent stream
   updates; less space for axis labels and longer explanations.
2. Analytical panel: 224px charts, moderate padding. Prioritizes comparison
   and reading exact values; consumes more vertical stream space.
3. Presentation card: 256px charts, larger headline and accent. Strong for
   milestones and summaries; expensive for frequent small updates.

All retain explicit units, zero baseline, null gaps and expandable native HTML
tables. Light/dark theme controls and responsive stacking are reviewable.
The three styles share one prototype, not three independent feature systems.

## Library fit

Installed Recharts is 3.8.1; package range is ^3.8.1. Existing jobs, activity and
service-resource charts use the shadcn ChartContainer wrapper. Reuse that stack:
no new dependency is warranted for bars, lines or multiple series.

Official references:

- https://recharts.github.io/en-US/guide/sizes/ documents sizing and responsive support.
- https://github.com/recharts/recharts/blob/main/storybook/stories/API/Accessibility.mdx
  documents the default accessibility layer in v3 and keyboard navigation.
- https://recharts.github.io/en-US/examples/LineChartConnectNulls/ documents null gaps.

The wrapper already supplies responsive sizing, theme colors and tooltip/legend
compositions. Keyboard interaction still needs runtime verification in the final
stream renderer; a native exact-value table is the dependable alternative.
Use stable series order/IDs, explicit legend labels, line patterns as well as
colors, visible focus styles, and no silent null-to-zero conversion.
Units belong in headings and accessible table captions. Bar axes include zero;
initial line axes should also include zero to avoid unstated truncation.
Long labels need wrapping/full table labels rather than unannounced shortening.

Recharts is already bundled by existing screens. This does not make additional
imports free: measure final build chunks and use a lazy renderer if they enlarge
the stream entry chunk substantially. No credible incremental byte estimate is
claimed at this prototype checkpoint.

## Proposed bounded contract (independent of presentation)

Add metric and chart variants to shared BlockBody; each has `version: 1`, title,
unit, optional description/source/asOf, and dataKind measured/estimated/synthetic.
Source is inert text, never fetched. Immutable Block author/recipient/routing
provenance remains service-owned; payload labels cannot override it.

Metric: finite numeric value or explicit null, optional label and comparison
(value plus explanatory label). No executable formatters, markup or callbacks.
Chart: bar or line; x-axis label; one common unit; ordered series with unique
stable IDs and labels; ordered rows with labels and values aligned with series.
Null means missing. Reject row/series arity mismatches and nonfinite values.
Proposed limits: 6 series, 200 rows, 12 metrics, 160-character labels,
2,000-character descriptions and 64KiB total encoded payload. Unknown versions
must produce a graceful unsupported block, not execute or silently reinterpret.
Finalize the exact schema before exposing MCP descriptions.

## Integration and access plan

Inspected shared block-types.ts, chat/service.ts PostInput/UpdateInput and
resolveKindAndData, chat/store.ts entry point, shared/mcp/stream-tools.ts,
and web chat/block-bodies.tsx. Extend the existing post payload selector and
update data validation; retain service ownership checks, destination resolution,
thread permissions, author identity and attachment provenance paths.
Do not add a parallel publishing endpoint or derive author identity from data.
Persist through the existing data field, then verify history/reload/thread feeds.
Coordinate stream-tools changes with PR1433 before touching MCP registration.

Required final coverage: contract bounds/finite values/version handling;
post/update storage round trips and unauthorized/cross-stream attempts; renderer
empty/missing/large/long-label cases; actual isolated MCP calls; served browser
post/update/reload/thread flows at desktop/mobile in both themes. This prototype
only exercises theme toggles and exact-table disclosure; it proves no post/update
or persistence behavior yet.

## Revision after user review

The user rejected the standalone comparison as insufficient and requested real
stream context, desktop coverage, stronger colors, tighter bar grouping and more
chart types than bar/line. The revised development preview renders persisted
sample posts through the actual chat BlockBody host with the normal stream shell.
It is explicitly enabled by `vizReview` on development builds only; these are
review fixtures, not new public block types or evidence of a completed MCP API.
Deep links select each of the three sample messages. The fixture is lazy-loaded
and excluded from production rendering. No production stream or database is used.

Each direction now shows a metric, bar, line, area and scatter chart, using the
same complete synthetic observations (42, 56, 61, 68, 74) and planned values
(40, 50, 60, 65, 70). Missing-data stress cases remain required for implementation,
but no longer obscure the basic design comparison. Bars use 12% category gaps
and 2px gaps within groups. Theme colors use the app's data-theme-mode attribute.
The additional chart types expand the original bar/line scope at user request;
final API design must cover area and numeric scatter semantics deliberately.

## Selected-theme palette correction

User requested selected-theme accent colors. Removed the custom violet/cyan
palette. Series now reference the existing --chart-1 and --chart-2 tokens
directly, as other Dispatch charts do. Metric accent and legend swatches follow
those same slots. The selected theme owns those colors; no per-block color
strings or separate light/dark palette is introduced.

## Palette comparison after user feedback

User asked for screenshots directly in active chat and disliked the initial
selected-theme pair. New screenshots are posted at home root with each visual
iteration instead of being hidden in prior feedback threads. Development review
fixtures now offer four local palette comparisons using existing theme slots:
1+2 (theme pair), 1+3 (alternate), 3+4 (secondary), and 1+5 (tonal). These are
review controls, not a proposed production chart editor or arbitrary color API.
The theme retains control of all six colors. Stable observed/planned mapping
remains intact when switching. Tonal colors provide less categorical distinction;
line dashes and exact tables remain necessary and further final accessibility
validation remains required.
