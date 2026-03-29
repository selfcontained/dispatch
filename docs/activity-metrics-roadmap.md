# Activity Metrics Roadmap

High-level plan for expanding Dispatch's activity tracking and usage metrics.

## Shipped

The following work is already in the product and should be treated as baseline, not future roadmap:

- `agent_events` history table with `agent_type`, `agent_name`, `project_dir`
- Stat cards for total working time, avg blocked time, avg waiting time, busiest day
- Yearly activity heatmap
- Daily status stacked bar chart for the last 30 days
- Delete/stop events captured in history
- Soft delete via `agents.deleted_at`, with active-agent queries filtering deleted rows
- Token harvesting into `agent_token_usage`
- Token dashboards for totals, daily usage, by model, and by project

## Next Up: Event-Derived Metrics

Derive more value from existing `agent_events` data before adding new ingestion paths.

- **Time period selector** — scope activity queries and charts to last 30d / this year / all time
- **Agent count over time** — agents created per day/week using the first event per `agent_id`
- **Per-project breakdown** — group by `project_dir`, show working time per project
- **Active hours heatmap** — hour-of-day x day-of-week grid from event timestamps

Why this phase goes first:

- no schema changes required
- no new background harvesting required
- unlocks a better information architecture for the activity pane

## Follow-On: History Views Enabled By Soft Delete

Soft delete is already implemented, but the analytics surface does not yet expose the richer history it enables.

Potential additions:

- Agent session history for deleted agents
- Total agents ever created
- Per-agent timelines and lifetime metrics
- Richer stats such as avg agent lifetime and most productive agents

## Follow-On: Token Analytics Expansion

Token tracking is already implemented. Remaining work here is higher-order analytics rather than ingestion.

Potential additions:

- Cost estimation using configurable model pricing
- Per-agent token history and lifetime rollups
- Better attribution for multi-project or worktree-heavy usage patterns

## Later: Tool And PR Tracking

Add workflow analytics once the event-derived dashboards are in place.

- Record MCP tool calls in `agent_events` or a dedicated table
- Track PR creation events from the GitHub MCP tools
- Display PRs created per week, most-used tools, and tool-call volume over time

## Recommended Build Order

1. Add a shared time period selector and thread it through existing activity queries.
2. Ship event-derived metrics from `agent_events`: agent-count-over-time and per-project working time.
3. Add the active-hours heatmap.
4. Expose deleted-agent history views now that soft delete exists.
5. Add token cost estimation and deeper token analysis.
6. Add MCP tool and PR tracking.
