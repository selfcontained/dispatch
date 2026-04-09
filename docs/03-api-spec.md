# API Specification

## Conventions

- Base path: `/api/v1` (except MCP endpoints which use `/api/mcp`)
- Auth: cookie-based session after password login
- Response format: JSON unless noted otherwise
- Real-time: Server-Sent Events (SSE) for live updates

## Agent Model

```json
{
  "id": "agt_01abc2def345",
  "name": "fix-auth-bug",
  "status": "running",
  "type": "claude",
  "cwd": "/home/user/projects/myproject",
  "effectiveCwd": "/home/user/projects/myproject/.dispatch/worktrees/fix-auth-bug",
  "tmuxSession": "dispatch_agt_01abc2def345",
  "fullAccess": true,
  "setupPhase": null,
  "latestEvent": { "type": "working", "message": "Running tests" },
  "parentAgentId": null,
  "persona": null,
  "worktreePath": "/home/user/projects/myproject/.dispatch/worktrees/fix-auth-bug",
  "worktreeBranch": "fix-auth-bug",
  "createdAt": "2026-03-07T19:20:00Z",
  "updatedAt": "2026-03-07T19:22:00Z"
}
```

## Authentication

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/status` | Check auth state and whether password is configured |
| POST | `/auth/setup` | Set initial password (first-run only) |
| POST | `/auth/login` | Authenticate and create session cookie |
| POST | `/auth/logout` | Invalidate session |
| POST | `/auth/change-password` | Change password (requires valid session) |

## Agent Lifecycle

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents` | List all active agents |
| GET | `/agents/:id` | Get agent details |
| POST | `/agents` | Create new agent |
| POST | `/agents/:id/start` | Start a stopped agent |
| POST | `/agents/:id/stop` | Stop a running agent |
| DELETE | `/agents/:id` | Delete agent (soft delete) |

### `POST /agents` — Create Agent

```json
{
  "cwd": "/path/to/repo",
  "name": "fix-auth-bug",
  "type": "claude",
  "fullAccess": true,
  "agentArgs": ["--model", "opus"],
  "useWorktree": true,
  "worktreeBranch": "fix-auth-bug",
  "baseBranch": "main"
}
```

For persona agents (launched via `dispatch_launch_persona`):

```json
{
  "cwd": "/path/to/repo",
  "type": "claude",
  "persona": "backend-security-review",
  "parentAgentId": "agt_01abc2def345",
  "personaContext": "Review the auth middleware changes..."
}
```

### `POST /agents/:id/stop`

```json
{ "force": false }
```

### `DELETE /agents/:id`

Query params: `force=true`, `cleanupWorktree=true`

## Agent Setup

Used during agent initialization to track setup progress.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/agents/:id/setup/phase` | Report setup phase (`worktree` → `env` → `deps` → `session`) |
| POST | `/agents/:id/setup/complete` | Mark setup complete with resolved paths |

### `POST /agents/:id/setup/complete`

```json
{
  "effectiveCwd": "/resolved/working/directory",
  "worktreePath": "/path/to/worktree",
  "worktreeBranch": "branch-name"
}
```

## Agent Events & State

| Method | Path | Description |
|--------|------|-------------|
| POST | `/agents/:id/latest-event` | Update agent's latest status event |
| POST | `/focus` | Track which agent the user is viewing |
| GET | `/events` | SSE stream of real-time UI events |
| GET | `/agents/git-context` | Get git context for agents (filtered by `ids` query param) |
| GET | `/agents/:id/worktree-status` | Check worktree for unmerged commits and uncommitted changes |

### `POST /agents/:id/latest-event`

```json
{
  "type": "working",
  "message": "Running E2E tests",
  "metadata": {}
}
```

Event types: `working`, `blocked`, `waiting_user`, `done`, `idle`

### `GET /events` (SSE)

Server-Sent Events stream. Events include agent state changes, media uploads, and stream updates. Used by the frontend for real-time UI updates.

## Terminal

| Method | Path | Description |
|--------|------|-------------|
| POST | `/agents/:id/terminal/token` | Issue short-lived terminal access token |
| WS | `/agents/:id/terminal/ws?token=...` | WebSocket for interactive terminal I/O |

The WebSocket provides bidirectional terminal I/O with resize support, bridging to the agent's tmux session.

## Media

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents/:id/media` | List media files with seen/unseen status |
| GET | `/agents/:id/media/:file` | Download a media file |
| POST | `/agents/:id/media` | Upload media (multipart form: file + description) |
| POST | `/agents/:id/media/seen` | Mark media files as seen |

## Streaming

Live Playwright browser streaming via Chrome DevTools Protocol.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/agents/:id/stream` | Start or stop a screen stream |
| GET | `/agents/:id/stream` | MJPEG stream (`multipart/x-mixed-replace`) |
| GET | `/agents/:id/stream/viewer` | HTML viewer page for the live stream |

## Personas

| Method | Path | Description |
|--------|------|-------------|
| GET | `/personas` | List available personas (reads from `.dispatch/personas/` in the repo at `cwd`) |

Query params: `cwd=/path/to/repo`

## Feedback

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents/:id/feedback` | Get feedback findings for an agent |
| PATCH | `/agents/:id/feedback/:feedbackId` | Update feedback status |

### `GET /agents/:id/feedback`

Query params: `scope=children` to include feedback from child persona agents.

### `PATCH /agents/:id/feedback/:feedbackId`

```json
{ "status": "fixed" }
```

Status values: `open`, `dismissed`, `forwarded`, `fixed`, `ignored`

## Activity & Analytics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/activity/heatmap` | Activity heatmap data (configurable `days`, `timezone`) |
| GET | `/activity/stats` | Aggregate stats (working/blocked/waiting time, busiest day) |
| GET | `/activity/daily-status` | Daily status breakdown |
| GET | `/activity/active-hours` | Events marked as working/blocked/waiting_user |
| GET | `/activity/agents-created` | Agent creation counts over time |
| GET | `/activity/working-time-by-project` | Working time by project directory |

## Token Usage

| Method | Path | Description |
|--------|------|-------------|
| GET | `/activity/token-stats` | Total token usage (input, output, cache creation, cache reads) |
| GET | `/activity/token-daily` | Daily token usage breakdown |
| GET | `/activity/token-by-project` | Token usage by project (top 20) |
| GET | `/activity/token-by-model` | Token usage by model |
| POST | `/agents/:id/harvest-tokens` | Harvest token usage from an agent's session |

All token endpoints accept `days` and `timezone` query params.

## History

| Method | Path | Description |
|--------|------|-------------|
| GET | `/history/projects` | List all projects where agents have worked |
| GET | `/history/agents` | Paginated agent history with filtering and sorting |
| GET | `/history/agents/:id` | Detailed agent history including events, tokens, and media |

### `GET /history/agents`

Query params: `project`, `type`, `sort` (`recent` | `oldest`), `limit`, `offset`

## Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/notifications/settings` | Get Slack webhook URL and enabled event types |
| POST | `/notifications/settings` | Update webhook URL and event configuration |
| POST | `/notifications/test` | Send a test message to the configured webhook |

### `POST /notifications/settings`

```json
{
  "slackWebhookUrl": "https://hooks.slack.com/services/...",
  "events": {
    "done": true,
    "waiting_user": true,
    "blocked": false
  }
}
```

## Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents/settings` | Get agent settings (worktree location) |
| POST | `/agents/settings` | Update agent settings |
| GET | `/app/settings/agent-types` | Get enabled agent types |
| POST | `/app/settings/agent-types` | Set enabled agent types (`claude`, `codex`, `opencode`) |

## System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Database connectivity check |
| GET | `/app/version` | Current app version |
| GET | `/system/defaults` | System defaults (home directory) |
| GET | `/system/path-info` | Path validation (exists, isDirectory, isGitRepo) |
| GET | `/system/path-completions` | Directory path autocomplete |
| GET | `/git/branches` | List remote branches for a repo |
| POST | `/clipboard/image` | Write browser clipboard image to macOS pasteboard |
| POST | `/energy-report` | Report PWA energy metrics |
| GET | `/diagnostics/git-context` | Git context refresh diagnostics |

## Release Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/release/status` | Current deployed release tag and timestamp |
| GET | `/release/info` | Latest available version and unreleased commits |
| POST | `/release` | Trigger new release (`versionType`: major/minor/patch) |
| POST | `/release/update` | Update to a specific release tag |
| GET | `/release/stream` | SSE stream for release operation progress |
| GET | `/app/version` | Current app version info |

## Jobs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/jobs` | List all configured jobs |
| GET | `/jobs/available` | Discover available job definitions from known directories |
| POST | `/jobs` | Create/register a job configuration |
| PATCH | `/jobs` | Update a job configuration |
| DELETE | `/jobs` | Delete a job configuration |
| POST | `/jobs/enable` | Enable a job (registers cron schedule) |
| POST | `/jobs/disable` | Disable a job (removes cron schedule) |
| POST | `/jobs/run` | Manually trigger a job run |
| GET | `/jobs/stats` | Get job run statistics |
| GET | `/jobs/history` | Get job run history (filterable by `jobId`, `status`, `limit`, `offset`) |

## MCP (Model Context Protocol)

These endpoints use the `/api/mcp` base path (not `/api/v1`).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mcp` | Handle global MCP requests |
| POST | `/api/mcp/:agentId` | Handle agent-scoped MCP requests with repo context |
| POST | `/api/mcp/jobs/:runId/:agentId` | Handle job-scoped MCP requests (adds job lifecycle tools) |

Agent-scoped MCP loads repo tools from `.dispatch/tools.json` in the agent's working directory.

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Invalid request body or parameters |
| 401 | Not authenticated |
| 403 | Unauthorized |
| 404 | Agent or resource not found |
| 409 | Lifecycle conflict (e.g., starting an already-running agent) |
| 500 | Internal server error |
