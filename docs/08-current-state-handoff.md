# Current State Handoff (April 2026)

This doc is for a new agent or contributor picking up work on Dispatch. It describes what the tool is, how it runs, what's implemented, and where to make changes.

## What Dispatch Is

Dispatch is a local-first control plane for managing long-running coding agents on a Mac host. It provides a browser-based UI for agent control, terminal interaction, media sharing, activity analytics, and automated code review via personas.

Core capabilities:
- Start and manage multiple coding agents (Claude, Codex, OpenCode) backed by `tmux`.
- Browser UI with real-time terminal access, media sharing, and activity dashboards.
- Agent sessions persist across browser disconnects.
- Git worktree isolation for parallel agent work.
- MCP-based tooling with repo-specific custom tools.
- Persona agents for automated code review with structured feedback.
- Slack notifications with focus-aware suppression.
- Token usage tracking and activity analytics.

## Project Structure

```
dispatch/                        # pnpm monorepo
├── apps/
│   ├── server/                  # Fastify API server (@dispatch/server)
│   │   └── src/
│   │       ├── server.ts        # All route registrations (71+ endpoints)
│   │       ├── agents/          # Agent manager, lifecycle, token harvesting
│   │       ├── db/              # PostgreSQL migrations and queries
│   │       ├── jobs/            # Job scheduler, runner, reporting
│   │       ├── notifications/   # Slack notifier
│   │       ├── personas/        # Persona loader
│   │       ├── streaming/       # CDP-based screen streaming
│   │       └── terminal/        # tmux terminal bridge
│   └── web/                     # Vite React frontend (@dispatch/web)
│       └── src/
│           ├── App.tsx          # Main app layout
│           └── components/      # UI components (shadcn-based)
├── packages/
│   └── shared/                  # Shared code (@dispatch/shared)
│       └── src/
│           ├── git/             # Worktree operations
│           ├── github/          # PR operations
│           ├── mcp/             # MCP server, repo tools, built-in tools
│           └── lib/             # run-command utility
├── e2e/                         # Playwright E2E tests (16 spec files)
├── bin/                         # CLI tools
└── docs/                        # Documentation
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Backend**: Fastify
- **Frontend**: React + Vite + Tailwind + shadcn/ui
- **Database**: PostgreSQL (Docker Compose)
- **Package manager**: pnpm (monorepo workspaces)
- **Terminal**: xterm.js → WebSocket → tmux
- **Testing**: Vitest (unit), Playwright (E2E)

## Database Schema

| Table | Purpose |
|-------|---------|
| `agents` | Agent records with status, paths, git context, setup phases, persona references |
| `agent_events` | Status event log (working, blocked, waiting_user, done, idle) |
| `agent_token_usage` | Token consumption per agent/session/model (input, output, cache) |
| `agent_feedback` | Structured feedback findings with severity and file references |
| `media` | Media file metadata (screenshots, videos, descriptions, source) |
| `media_seen` | Tracks which media items have been viewed |
| `sessions` | Authentication sessions with expiration |
| `settings` | Key-value store for app settings |
| `jobs` | Job definitions with schedule, config, directory, and enabled state |
| `job_runs` | Job execution history with status, reports, and agent references |
| `simulator_reservations` | iOS Simulator device allocation tracking |
| `persona_reviews` | Review status and verdicts from persona agents |

Migrations run automatically on API server start.

## Agent Types

Three agent CLIs are supported, each configurable via Settings:

| Type | CLI | Description |
|------|-----|-------------|
| `claude` | Claude Code | Anthropic's coding agent |
| `codex` | Codex | OpenAI's coding agent |
| `opencode` | OpenCode | Open-source coding agent |

## Agent Runtime Contract

- Session name format: `dispatch_<agent-id>`
- Agent ID format: `agt_<12 hex>`
- Each agent receives these environment variables:
  - `DISPATCH_AGENT_ID` — unique agent identifier
  - `DISPATCH_MEDIA_DIR` — directory for media files
  - `PATH` — includes `DISPATCH_BIN_DIR` for CLI tools
- Agents access MCP tools at `/api/mcp/:agentId`

## MCP Tools

### Built-in Tools (always available)

| Tool | Description |
|------|-------------|

| `create_pr` | Open GitHub pull request |
| `get_pr_status` | Check PR CI status and reviews |
| `dispatch_event` | Report agent status |
| `dispatch_pin` | Surface key info in the sidebar (URLs, ports, PRs, files) |
| `dispatch_share` | Upload media to session |
| `dispatch_feedback` | Submit structured finding |
| `dispatch_get_feedback` | Retrieve feedback findings |
| `dispatch_resolve_feedback` | Mark a feedback item as fixed or ignored |
| `dispatch_launch_persona` | Launch persona child agent |

### Repo Tools

Custom tools defined in `.dispatch/tools.json` at the repo root. Exposed to agents with a `repo_` prefix.

### Lifecycle Hooks

The `stop` hook in `.dispatch/tools.json` runs when an agent is stopped (e.g., teardown dev environments).

## Key Features

### Activity & Analytics
- Heatmaps, daily status charts, active-hours analysis
- Working time by project breakdown
- Token usage tracking by day, project, and model
- Agent creation trends

### Personas & Feedback
- Repo-defined personas via `.dispatch/personas/*.md`
- Structured findings with severity, file refs, suggestions
- See `15-personas-and-feedback.md`

### Notifications
- Slack webhook integration
- Configurable event triggers (done, waiting_user, blocked)
- Focus-aware suppression
- See `16-notifications.md`

### Media & Streaming
- Screenshot/image/video sharing via `dispatch_share`
- iOS Simulator screenshot capture
- Live Playwright browser streaming via CDP/MJPEG
- Media sidebar with lightbox and seen/unseen tracking

### Jobs
- Scheduled, repo-scoped agent tasks defined in `.dispatch/jobs/*.md`
- Cron-based scheduling with manual trigger support
- Structured reporting via `job_complete` / `job_failed` / `job_needs_input` / `job_log` MCP tools
- Run history with per-task status and error details
- Interactive recovery when agent needs human input
- See `jobs-feature-spec.md`

### History
- Soft-deleted agents preserved for history
- Paginated agent history with project/type filtering
- Per-agent detail view with events, tokens, and media

## CLI Tools

| Binary | Purpose |
|--------|---------|
| `dispatch-dev` | Manage isolated dev environments (DB + API + Vite) |
| `dispatch-server` | Launch the production server |
| `dispatch-deploy` | Deployment automation |
| `dispatch-release` | Release management |
| `dispatch-share` | CLI for sharing media to agent sessions (legacy — agents should use MCP tools) |
| `dispatch-event` | CLI for reporting agent status events (legacy — agents should use MCP tools) |
| `dispatch-stream` | CLI for managing screen streams |
| `dispatch-launchd-wrapper` | macOS launchd service wrapper |
| `install-launchd` / `uninstall-launchd` | Register/unregister as macOS service |
| `pack-release` | Build release tarballs for deployments without rebuilding |
| `preflight` | Pre-launch validation |

## API Surface

71+ endpoints across these families: authentication, agent lifecycle, agent setup, events, terminal, media, streaming, personas, feedback, activity/analytics, token usage, history, notifications, settings, system, release management, MCP, and diagnostics. See `03-api-spec.md` for the complete specification.

## Frontend

- Responsive layout with mobile support (slide panels, mobile terminal toolbar)
- Agent sidebar with real-time status indicators
- Inline terminal via xterm.js
- Media sidebar with lightbox viewer
- Activity dashboard with charts and heatmaps
- Settings pane (agent types, notifications, security)
- Feedback panel for reviewing persona findings
- Documentation pane (in-app)
- Release manager for self-updates
- Theming (dark/light mode, CSS custom properties)

## Development

### Commands

```bash
pnpm install                  # install dependencies
pnpm run dev                  # backend + frontend dev mode (don't use in agent sessions)
pnpm run check                # type check backend + web
pnpm run finalize:web         # type check + production build for web
pnpm run test                 # unit tests (vitest)
pnpm run test:e2e             # E2E tests (playwright, spins up isolated DB)
```

### dispatch-dev (for agents)

Agents should use `dispatch-dev` instead of `pnpm run dev`:

```bash
dispatch-dev up               # start isolated DB + API + Vite
dispatch-dev restart           # pick up code changes (reuses ports/DB)
dispatch-dev status            # check what's running
dispatch-dev logs              # API server logs
dispatch-dev down              # full teardown
```

### Validation Checklist

Before considering work complete:
1. `pnpm run check` passes
2. `pnpm run finalize:web` passes (if web files changed)
3. `pnpm run test:e2e` passes
4. `pnpm run test` passes (if backend logic changed)
