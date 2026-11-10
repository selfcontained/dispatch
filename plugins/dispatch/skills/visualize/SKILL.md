---
name: visualize
description: Share numeric results as Dispatch metrics, charts or responsive groups.
---

# Show data in the conversation

Use Dispatch's existing `post` and `update` tools. These are communication
primitives for whatever the agent is working on, not a fixed analytics dashboard.
A simple fact can stay in prose; use a metric for a meaningful headline number,
and a chart when the shape or comparison matters.

Before posting, inspect the exposed tool schema. Older Dispatch versions may
not expose `metric`, `chart` or `visualizationGroup`; do not claim a chart was
posted if the tool rejects it. Follow the available capability rather than
inventing alternate tool names or silently falling back to an image.

Read [references/payloads.md](references/payloads.md) for bounded payloads,
examples, chart-specific semantics and replacement updates.

## Pick a useful visual

| Intent                                       | Primitive                                            |
| -------------------------------------------- | ---------------------------------------------------- |
| A headline measurement, estimate or count    | Metric, with an optional comparison                  |
| Compare categories                           | Bar                                                  |
| Show change over an ordered sequence         | Line; area when magnitude should be emphasized       |
| Compare two numeric dimensions               | Scatter, with explicit x and y units                 |
| Find patterns across a matrix                | Heatmap with one common numeric scale                |
| Show a distribution                          | Histogram with explicit contiguous, equal-width bins |
| Explain contributions to a running total     | Waterfall with signed deltas                         |
| Communicate uncertainty or bounded estimates | Interval                                             |
| Compare actual values against targets        | Bullet                                               |
| Show durations and overlaps                  | Timeline with numeric start/end offsets              |

Prefer an explicit `visualizationGroup` when several metrics or charts belong
together. A group contains metrics OR charts, with one author and one thread.
Dispatch chooses the columns from available stream width; agents do not specify
screen sizes or column counts. Separate posts remain independent. Do not turn a
collection of unrelated results into a dashboard by default.

## Keep the result truthful

- Supply units, meaningful series/axis labels and a useful title. Include source,
  as-of context and a short explanation when they help interpret the result.
- Mark data measured, estimated or synthetic according to its actual origin.
  Do not manufacture measurements to fill an attractive chart.
- Keep a series ID and its named color associated when reordering or updating.
  Up to six uniquely colored series are supported; colors come from the graph
  palette. Raw CSS, library options, scripts and remote execution are excluded.
- Use null for missing observations. Do not replace unknown values with zero or
  connect gaps to suggest measurements that do not exist.
- Let the built-in exact-data table carry the full values. Histogram frequencies,
  scatter coordinates, range endpoints and waterfall deltas have distinct
  meanings; follow their payload rules.

Post into the already-authorized conversation. Existing `to`, `taskId`,
`agentHome` and `replyTo` rules still apply; visual content grants no additional
routing or messaging permission. Keep the returned block ID and use
`update({ id, data: completeReplacement })` for a revised result rather than
posting duplicates. Full data replacements are validated; author identity and
thread provenance remain owned by Dispatch.
