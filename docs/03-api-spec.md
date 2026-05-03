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
  "role": "standard",
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

| Method | Path                    | Description                                         |
| ------ | ----------------------- | --------------------------------------------------- |
| GET    | `/auth/status`          | Check auth state and whether password is configured |
| POST   | `/auth/setup`           | Set initial password (first-run only)               |
| POST   | `/auth/login`           | Authenticate and create session cookie              |
| POST   | `/auth/logout`          | Invalidate session                                  |
| POST   | `/auth/change-password` | Change password (requires valid session)            |

## Agent Lifecycle

| Method | Path                            | Description                                  |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/agents`                       | List all active agents                       |
| GET    | `/agents/:id`                   | Get agent details                            |
| POST   | `/agents`                       | Create new agent                             |
| POST   | `/agents/:id/start`             | Start a stopped agent                        |
| POST   | `/agents/:id/stop`              | Stop a running agent                         |
| PATCH  | `/agents/:id/review-agent-type` | Set preferred agent type for persona reviews |
| DELETE | `/agents/:id`                   | Delete agent (soft delete)                   |

### `POST /agents` — Create Agent

```json
{
  "cwd": "/path/to/repo",
  "name": "fix-auth-bug",
  "type": "claude",
  "fullAccess": true,
  "agentArgs": ["--model", "opus"],
  "useWorktree": true,
  "createNewBranch": true,
  "worktreeBranch": "fix-auth-bug",
  "baseBranch": "main",
  "autoReview": false,
  "initialPrompt": "Start by reading CONTRIBUTING.md..."
}
```

`type` is one of `claude`, `codex`, `opencode`, or `terminal` and defaults to `codex` if omitted. The type must be enabled in app settings. Terminal-type agents have no CLI to drive — `fullAccess`, `autoReview`, and `initialPrompt` are stored as off/empty regardless of what's posted.

`useWorktree` requests a managed git worktree; `createNewBranch` (default: true when worktree is created) controls whether a fresh branch forks from `baseBranch` or the existing `worktreeBranch` is checked out directly. `autoReview` queues a persona review to run automatically when the agent reaches a terminal state. `initialPrompt` is piped into the agent CLI as its first user turn.

This endpoint also accepts `multipart/form-data` to attach up to 10 startup files (20 MB each); array/boolean fields like `agentArgs` and `fullAccess` are accepted as JSON-encoded strings in that form.

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

Query params: `cleanupWorktree=auto|keep|force` (default: `auto` — cleans up worktree if no unmerged/uncommitted changes; `keep` preserves worktree; `force` always removes)

## Agent Setup

Used during agent initialization to track setup progress.

| Method | Path                         | Description                                                  |
| ------ | ---------------------------- | ------------------------------------------------------------ |
| POST   | `/agents/:id/setup/phase`    | Report setup phase (`worktree` → `env` → `deps` → `session`) |
| POST   | `/agents/:id/setup/complete` | Mark setup complete with resolved paths                      |
| POST   | `/agents/:id/setup/error`    | Report setup failure (worktree create, env copy, deps, etc.) |

### `POST /agents/:id/setup/complete`

```json
{
  "effectiveCwd": "/resolved/working/directory",
  "worktreePath": "/path/to/worktree",
  "worktreeBranch": "branch-name"
}
```

### `POST /agents/:id/setup/error`

```json
{ "message": "Could not create worktree: branch is checked out elsewhere." }
```

Marks the agent as `stopped` with `last_error` set to `message` (defaults to `"Setup failed."` if omitted) and surfaces a blocked latest-event in the UI.

## Agent Events & State

| Method | Path                          | Description                                                 |
| ------ | ----------------------------- | ----------------------------------------------------------- |
| POST   | `/agents/:id/latest-event`    | Update agent's latest status event                          |
| POST   | `/focus`                      | Track which agent the user is viewing                       |
| GET    | `/events`                     | SSE stream of real-time UI events                           |
| GET    | `/agents/git-context`         | Get git context for agents (filtered by `ids` query param)  |
| GET    | `/agents/:id/worktree-status` | Check worktree for unmerged commits and uncommitted changes |

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

| Method | Path                                | Description                             |
| ------ | ----------------------------------- | --------------------------------------- |
| POST   | `/agents/:id/terminal/token`        | Issue short-lived terminal access token |
| WS     | `/agents/:id/terminal/ws?token=...` | WebSocket for interactive terminal I/O  |

The WebSocket provides bidirectional terminal I/O with resize support, bridging to the agent's tmux session.

## Media

| Method | Path                      | Description                                       |
| ------ | ------------------------- | ------------------------------------------------- |
| GET    | `/agents/:id/media`       | List media files with seen/unseen status          |
| GET    | `/agents/:id/media/:file` | Download a media file                             |
| POST   | `/agents/:id/media`       | Upload media (multipart form: file + description) |
| POST   | `/agents/:id/media/seen`  | Mark media files as seen                          |

## Streaming

Live Playwright browser streaming via Chrome DevTools Protocol.

| Method | Path                        | Description                                |
| ------ | --------------------------- | ------------------------------------------ |
| POST   | `/agents/:id/stream`        | Start or stop a screen stream              |
| GET    | `/agents/:id/stream`        | MJPEG stream (`multipart/x-mixed-replace`) |
| GET    | `/agents/:id/stream/viewer` | HTML viewer page for the live stream       |

## Personas

| Method | Path                          | Description                                                                               |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/personas`                   | List available personas (reads from `.dispatch/personas/` in the repo at `cwd`)           |
| POST   | `/agents/:id/launch-review`   | Tell a CLI agent (via its tmux session) to call `dispatch_launch_persona` on its own work |
| POST   | `/agents/:id/persona-reviews` | Directly spawn a persona review agent as a child of `:id` (server-side equivalent)        |

### `GET /personas`

Query params: `cwd=/path/to/repo`. The server tries the worktree root first, then the repo root.

### `POST /agents/:id/launch-review`

```json
{
  "persona": "backend-security-review",
  "agentType": "claude",
  "allowRecheck": true
}
```

Sends a server-built prompt into the parent agent's tmux session asking it to call the `dispatch_launch_persona` MCP tool with the given options. Requires the parent to be in `tmux` access mode; returns 409 otherwise. `agentType` must be one of the CLI types (`codex`, `claude`, `opencode`); `persona` must match the slug pattern `[a-zA-Z0-9_-]+`.

### `POST /agents/:id/persona-reviews`

```json
{
  "persona": "backend-security-review",
  "agentType": "claude",
  "allowRecheck": true,
  "context": "Review the auth middleware refactor in apps/server/src/auth/."
}
```

Spawns the persona review agent directly (without going through the parent agent's tmux). `agentType` and `allowRecheck` are optional; `context` defaults to a short generic briefing if omitted. Returns the new persona agent.

## Feedback

| Method | Path                               | Description                        |
| ------ | ---------------------------------- | ---------------------------------- |
| GET    | `/agents/:id/feedback`             | Get feedback findings for an agent |
| PATCH  | `/agents/:id/feedback/:feedbackId` | Update feedback status             |

### `GET /agents/:id/feedback`

Query params: `scope=children` to include feedback from child persona agents.

### `PATCH /agents/:id/feedback/:feedbackId`

```json
{ "status": "fixed", "reason": "Resolved by tightening the JWT TTL check." }
```

Status values: `open`, `dismissed`, `forwarded`, `fixed`, `ignored`. `reason` is optional in general but **required** when `status` is `ignored` (max 10,000 characters). When `status` is `fixed` or `ignored`, the server captures the current HEAD SHA of the agent's working tree as `resolutionCommit` for round-trip review provenance.

## Activity & Analytics

| Method | Path                                | Description                                                 |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| GET    | `/activity/heatmap`                 | Activity heatmap data (configurable `days`, `timezone`)     |
| GET    | `/activity/stats`                   | Aggregate stats (working/blocked/waiting time, busiest day) |
| GET    | `/activity/daily-status`            | Daily status breakdown                                      |
| GET    | `/activity/active-hours`            | Events marked as working/blocked/waiting_user               |
| GET    | `/activity/agents-created`          | Agent creation counts over time                             |
| GET    | `/activity/working-time-by-project` | Working time by project directory                           |

## Token Usage

| Method | Path                         | Description                                                    |
| ------ | ---------------------------- | -------------------------------------------------------------- |
| GET    | `/activity/token-stats`      | Total token usage (input, output, cache creation, cache reads) |
| GET    | `/activity/token-daily`      | Daily token usage breakdown                                    |
| GET    | `/activity/token-by-project` | Token usage by project (top 20)                                |
| GET    | `/activity/token-by-model`   | Token usage by model                                           |
| POST   | `/agents/:id/harvest-tokens` | Harvest token usage from an agent's session                    |

All token endpoints accept `days` and `timezone` query params.

## History

| Method | Path                  | Description                                                |
| ------ | --------------------- | ---------------------------------------------------------- |
| GET    | `/history/projects`   | List all projects where agents have worked                 |
| GET    | `/history/agents`     | Paginated agent history with filtering and sorting         |
| GET    | `/history/agents/:id` | Detailed agent history including events, tokens, and media |

### `GET /history/agents`

Query params: `project`, `type`, `sort` (`recent` | `oldest`), `limit`, `offset`

## Notifications

| Method | Path                      | Description                                                                         |
| ------ | ------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/notifications/settings` | Get Slack webhook URL, enabled Slack event types, and web notification config       |
| POST   | `/notifications/settings` | Update any subset of webhook URL, event lists, or web-notify toggle                 |
| POST   | `/notifications/test`     | Send a test message to the configured (or provided) webhook                         |
| POST   | `/notifications/ack`      | Acknowledge a web notification by ID (suppresses the Slack fallback for that event) |

### `POST /notifications/settings`

All fields are optional — the request updates only the fields it contains.

```json
{
  "webhookUrl": "https://hooks.slack.com/services/T.../B.../xxx",
  "notifyEvents": ["done", "waiting_user"],
  "webNotifyEnabled": true,
  "webNotifyEvents": ["done", "waiting_user", "blocked"]
}
```

`notifyEvents` and `webNotifyEvents` are arrays of event-type strings (`done`, `waiting_user`, `blocked`). When a notable agent event fires, Dispatch first attempts an in-app notification via the SSE event stream; if no browser client acks within ~3s it falls back to the Slack webhook (provided the event is enabled there).

### `POST /notifications/ack`

```json
{ "notificationId": "<id from the SSE event>" }
```

Returns `204` regardless of whether the notification was still pending.

## Settings

| Method | Path                        | Description                                                         |
| ------ | --------------------------- | ------------------------------------------------------------------- |
| GET    | `/agents/settings`          | Get agent settings (worktree location)                              |
| POST   | `/agents/settings`          | Update agent settings                                               |
| GET    | `/app/settings/agent-types` | Get enabled agent types                                             |
| POST   | `/app/settings/agent-types` | Set enabled agent types (`claude`, `codex`, `opencode`, `terminal`) |

## System

| Method | Path                       | Description                                       |
| ------ | -------------------------- | ------------------------------------------------- |
| GET    | `/health`                  | Database connectivity check                       |
| GET    | `/app/version`             | Current app version                               |
| GET    | `/app/branding`            | App branding info (icon color)                    |
| GET    | `/system/defaults`         | System defaults (home directory)                  |
| GET    | `/system/path-info`        | Path validation (exists, isDirectory, isGitRepo)  |
| GET    | `/system/path-completions` | Directory path autocomplete                       |
| GET    | `/git/branches`            | List remote branches for a repo                   |
| POST   | `/clipboard/image`         | Write browser clipboard image to macOS pasteboard |
| POST   | `/energy-report`           | Report PWA energy metrics                         |

## Release Management

| Method | Path                       | Description                                                                          |
| ------ | -------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/release/status`          | Current deployed release tag and timestamp                                           |
| GET    | `/release/info`            | Latest available version and unreleased commits                                      |
| GET    | `/release/channel`         | Get current release channel (`stable` or `latest`)                                   |
| POST   | `/release/channel`         | Set release channel                                                                  |
| GET    | `/release/admin-check`     | Check if current instance is a release admin                                         |
| POST   | `/release/promote`         | Promote a pre-release to stable (admin only)                                         |
| GET    | `/releases`                | List recent GitHub releases                                                          |
| POST   | `/release`                 | Trigger new release (`versionType`: major/minor/patch)                               |
| POST   | `/release/update`          | One-click update to a specific tag (gated — see below)                               |
| POST   | `/release/assisted/launch` | Launch a full-access agent on the production checkout to perform an assisted update  |
| POST   | `/release/assisted/phase`  | Phase callback used by the assisted-update agent (token-authed, not for browser use) |
| GET    | `/release/assisted/state`  | Read the current assisted-update state (tag, phase, notes, checks)                   |
| DELETE | `/release/assisted/state`  | Clear the persisted assisted-update state                                            |
| GET    | `/release/stream`          | SSE stream for release operation progress                                            |

### `POST /release/update`

```json
{ "tag": "v0.18.16" }
```

Returns `202 Accepted` and runs the update asynchronously. Returns `409 Conflict` with a structured error code when the path is gated:

| Error code                         | Reason                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ASSISTED_UPDATE_REQUIRED`         | Target release ships unapplied migrations or declares `mode: required` — caller must use `assisted/launch` |
| `ASSISTED_UPDATE_METADATA_INVALID` | Target release's `dispatch-update` metadata block is malformed                                             |

Also returns `503` with `MIGRATION_EVALUATION_UNAVAILABLE` when the target tarball can't be downloaded or parsed (transient — retry later).

The assisted-update agent itself bypasses the gate by sending a bearer token (`Authorization: Bearer <token>`) bound to a specific tag.

### `POST /release/assisted/launch`

```json
{ "tag": "v0.18.16" }
```

Creates a full-access agent on the server's own checkout, attaches an assisted-update state record, and returns `201` with `{ agent, assisted }`. Subject to several conflict checks:

- `409` if a release/update job is already in progress, if another assisted launch is racing, or if an assisted-update agent is already active on the production checkout.
- `409 ASSISTED_UPDATE_MIGRATIONS_INVALID` if the target tarball's `update-migrations/*.yaml` manifests fail to parse.
- `409 ASSISTED_UPDATE_METADATA_INVALID` if there are no migrations and the `dispatch-update` metadata block is malformed.
- `422` if no CLI agent type is enabled in settings.

### `POST /release/assisted/phase`

```json
{
  "token": "<assisted-state token>",
  "phase": "apply",
  "note": "Running migration 0001-bun-cutover.",
  "error": null
}
```

Token-authenticated callback used only by the launched assisted-update agent to advance its phase machine. Phases: `inspect → prepare → apply → restarting → validate → done`, plus `blocked` and `rollback` for failure paths. When the agent reports `validate`, the server runs the metadata-declared `requiredChecks` and gates the success transition.

### `GET /release/assisted/state`

Returns `{ "state": <AssistedUpdateState> | null }`.

## Jobs

| Method | Path            | Description                                                              |
| ------ | --------------- | ------------------------------------------------------------------------ |
| GET    | `/jobs`         | List all configured jobs                                                 |
| POST   | `/jobs`         | Create a job                                                             |
| PATCH  | `/jobs`         | Update a job configuration                                               |
| DELETE | `/jobs`         | Delete a job configuration                                               |
| POST   | `/jobs/enable`  | Enable a job (registers cron schedule)                                   |
| POST   | `/jobs/disable` | Disable a job (removes cron schedule)                                    |
| POST   | `/jobs/run`     | Manually trigger a job run                                               |
| GET    | `/jobs/stats`   | Get job run statistics                                                   |
| GET    | `/jobs/history` | Get job run history (filterable by `jobId`, `status`, `limit`, `offset`) |

### `POST /jobs/run`

```json
{ "name": "docs-audit", "directory": "/path/to/repo", "wait": false }
```

`name` + `directory` together identify the job. `wait: true` blocks the response until the run reaches a terminal state; otherwise the response returns as soon as the run is queued. Manual runs are tagged with `triggerSource: "manual"` internally.

## MCP (Model Context Protocol)

These endpoints use the `/api/mcp` base path (not `/api/v1`).

| Method | Path                            | Description                                               |
| ------ | ------------------------------- | --------------------------------------------------------- |
| POST   | `/api/mcp`                      | Handle global MCP requests                                |
| POST   | `/api/mcp/:agentId`             | Handle agent-scoped MCP requests with repo context        |
| POST   | `/api/mcp/jobs/:runId/:agentId` | Handle job-scoped MCP requests (adds job lifecycle tools) |

Agent-scoped MCP loads repo tools from `.dispatch/tools.json` in the agent's working directory.

## Error Codes

| Code | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| 400  | Invalid request body or parameters                                                       |
| 401  | Not authenticated                                                                        |
| 403  | Unauthorized                                                                             |
| 404  | Agent or resource not found                                                              |
| 409  | Lifecycle conflict (e.g., starting an already-running agent, gated release/update flows) |
| 422  | Request was well-formed but rejected by configuration (e.g., no CLI agent type enabled)  |
| 500  | Internal server error                                                                    |
| 503  | Transient dependency failure (e.g., release tarball download/parse during gate eval)     |
