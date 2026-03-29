# Activity Metrics Roadmap

High-level plan for expanding Dispatch's activity tracking and usage metrics.

## Current State (PR #140)

- `agent_events` history table with `agent_type`, `agent_name`, `project_dir`
- Stat cards: total working time, avg blocked time, avg waiting time, busiest day
- Yearly activity heatmap (Jan–Dec)
- Daily stacked bar chart (last 30 days, recharts)
- Delete/stop events captured in history

## Phase 1: Low-Hanging Fruit from Existing Data

Derive new metrics from `agent_events` without schema changes.

- **Agent count over time** — agents created per day/week (first event per agent_id)
- **Success rate** — ratio of agents reaching `done` vs `idle`/stopped
- **Per-project breakdown** — group by `project_dir`, show working time per project
- **Active hours heatmap** — hour-of-day × day-of-week grid from event timestamps
- **Time period selector** — scope all metrics to last 30d / this year / all time

## Phase 2: Soft Delete

Add `deleted_at` column to `agents` table, filter from list/UI queries.

Unlocks:
- Agent session history (see past agents, what they worked on)
- Total agents ever created (not just currently existing)
- Per-agent timelines and lifetime metrics
- Richer stats: avg agent lifetime, most productive agents

## Phase 3: Token Tracking

Parse Claude Code JSONL session logs at agent stop/delete.

- New `agent_token_usage` table (agent_id, session, input_tokens, output_tokens, model, timestamp)
- Harvest from `~/.claude/sessions/` JSONL files
- Display: total tokens used, tokens per day, tokens per project
- Cost estimation: tokens × model pricing (configurable rates)

## Phase 4: Tool & PR Tracking

Log MCP tool calls and PR events for workflow insights.

- Record MCP tool calls in event history or separate table (tool name, agent_id, timestamp)
- Track PR creation events (already flows through MCP `create_pr` tool)
- Display: PRs created per week, most-used tools, tool call volume over time
