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
| GET    | `/agents/:id/diff-stats`        | Get worktree diff stats for an agent         |
| POST   | `/agents/:id/prompt-rename`     | Prompt a running agent to rename its session |
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

`type` is one of `claude`, `codex`, `cursor`, `opencode`, or `terminal` and defaults to `codex` if omitted. The type must be enabled in app settings. Terminal-type agents have no CLI to drive — `fullAccess`, `autoReview`, and `initialPrompt` are stored as off/empty regardless of what's posted.

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

Server-Sent Events stream. Used by the frontend for real-time UI updates. Event types:

| Event type                     | Payload                                              |
| ------------------------------ | ---------------------------------------------------- |
| `snapshot`                     | Full agent list (sent on initial connection)         |
| `agent.upsert`                 | Single agent record (created or updated)             |
| `agent.terminal_state_changed` | Terminal UI state for an agent                       |
| `agent.diff_state_changed`     | Diff stats for an agent (or `null` when cleared)     |
| `agent.deleted`                | Agent ID that was deleted                            |
| `media.changed`                | Agent ID whose media list changed                    |
| `media.seen`                   | Agent ID + array of media keys marked seen           |
| `whiteboard.changed`           | Agent ID + new version + source (`user` or `agent`)  |
| `stream.started`               | Agent ID whose live stream started                   |
| `stream.stopped`               | Agent ID whose live stream stopped                   |
| `feedback.created`             | Agent ID + new feedback record                       |
| `feedback.updated`             | Agent ID + updated feedback record                   |
| `job.changed`                  | (no payload) — job config or run state changed       |
| `template.changed`             | (no payload) — template created, updated, or deleted |
| `notification`                 | Web notification payload (id, agent, event, message) |
| `release.cached_info_changed`  | Latest release-info snapshot (or `null`)             |

## Terminal

| Method | Path                                | Description                             |
| ------ | ----------------------------------- | --------------------------------------- |
| POST   | `/agents/:id/terminal/token`        | Issue short-lived terminal access token |
| WS     | `/agents/:id/terminal/ws?token=...` | WebSocket for interactive terminal I/O  |

The WebSocket provides bidirectional terminal I/O with resize support, bridging to the agent's tmux session.

## Quick Phrases

Reusable text snippets that can be injected into agent terminal sessions.

| Method | Path                                 | Description                                         |
| ------ | ------------------------------------ | --------------------------------------------------- |
| GET    | `/quick-phrases`                     | List all phrases (with parsed template args)        |
| POST   | `/quick-phrases`                     | Create a phrase (`text` required, `label` optional) |
| PATCH  | `/quick-phrases/:id`                 | Update phrase `text` and/or `label`                 |
| DELETE | `/quick-phrases/:id`                 | Delete a phrase                                     |
| POST   | `/agents/:id/terminal/inject-phrase` | Inject a phrase into an agent's tmux session        |

The inject-phrase endpoint accepts `phraseId`, optional `args` (key-value map for template variables), and optional `submit` (default `true` — sends Enter after pasting; `false` pastes only). Text is capped at 1000 chars per phrase, 2000 chars per arg value, and 10000 chars after variable substitution.

## Media

| Method | Path                      | Description                                                |
| ------ | ------------------------- | ---------------------------------------------------------- |
| GET    | `/agents/:id/media`       | List media files with seen/unseen status                   |
| GET    | `/agents/:id/media/:file` | Download a media file                                      |
| POST   | `/agents/:id/media`       | Upload media (multipart form: file + source + description) |
| POST   | `/agents/:id/media/seen`  | Mark media files as seen                                   |

## Whiteboard

Per-agent shared Excalidraw canvas. The scene is stored as JSONB with an integer version for optimistic locking; agents edit it via the `whiteboard_*` MCP tools, the UI via these routes.

| Method | Path                              | Description                                                                                    |
| ------ | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/agents/:id/whiteboard`          | Get the scene, version, and updated-at (empty scene if never set)                              |
| PUT    | `/agents/:id/whiteboard`          | Save the scene (`scene` + `baseVersion`); `409` with the current scene and version on conflict |
| POST   | `/agents/:id/whiteboard/snapshot` | Upload a PNG rendering of the board (multipart file field)                                     |
| DELETE | `/agents/:id/whiteboard/snapshot` | Remove the PNG snapshot (used when the board is emptied)                                       |

Scene saves are capped at 20,000 elements and an 8 MB body. The snapshot is written to the agent's media directory as `whiteboard.png` (not listed in the media pane) so agents can view the board via `whiteboard_get`.

## Streaming

Live Playwright browser streaming via Chrome DevTools Protocol.

| Method | Path                        | Description                                |
| ------ | --------------------------- | ------------------------------------------ |
| POST   | `/agents/:id/stream`        | Start or stop a screen stream              |
| GET    | `/agents/:id/stream`        | MJPEG stream (`multipart/x-mixed-replace`) |
| GET    | `/agents/:id/stream/viewer` | HTML viewer page for the live stream       |

## Personas

| Method | Path                        | Description                                                                               |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/personas`                 | List available personas (reads from `.dispatch/personas/` in the repo at `cwd`)           |
| POST   | `/agents/:id/launch-review` | Tell a CLI agent (via its tmux session) to call `dispatch_launch_persona` on its own work |

### `GET /personas`

Query params: `cwd=/path/to/repo`. The server tries the worktree root first, then the repo root.

### `POST /agents/:id/launch-review`

```json
{
  "persona": "backend-security-review",
  "agentType": "claude",
  "includeDiff": true
}
```

Sends a server-built prompt into the parent agent's tmux session asking it to call the `dispatch_launch_persona` MCP tool with the given options. Requires the parent to be in `tmux` access mode; returns 409 otherwise. `agentType` must be one of the CLI types (`claude`, `codex`, `cursor`, `opencode`); `persona` must match the slug pattern `[a-zA-Z0-9_-]+`. `includeDiff` defaults to `true`; set to `false` for non-code reviews (PRDs, docs, media) where the git diff is not the review target. The launched agent creates its review through `dispatch_review_submit` after completing its initial pass.

### `PATCH /agents/:id/feedback/:feedbackId`

```json
{ "status": "fixed", "reason": "Resolved by tightening the JWT TTL check." }
```

Status values: `open`, `dismissed`, `forwarded`, `fixed`, `ignored`. `reason` is optional in general but **required** when `status` is `ignored` (max 10,000 characters). When `status` is `fixed` or `ignored`, the server captures the current HEAD SHA of the agent's working tree as `resolutionCommit` for round-trip review provenance.

## Personalities

| Method | Path                    | Description                                             |
| ------ | ----------------------- | ------------------------------------------------------- |
| GET    | `/personalities`        | List all personalities and the active personality ID    |
| POST   | `/personalities`        | Create a personality (`{ name, prompt }`)               |
| PATCH  | `/personalities/:id`    | Update name and/or prompt (both optional)               |
| DELETE | `/personalities/:id`    | Delete a personality                                    |
| POST   | `/personalities/active` | Set the active personality (`{ id }` or `{ id: null }`) |

### `POST /personalities`

```json
{ "name": "Concise reviewer", "prompt": "Be brief and direct..." }
```

`name` is required (max 80 chars, unique — returns `409` on duplicate). `prompt` is required (max 1,000 chars). Returns `201` with the new personality.

### `POST /personalities/active`

```json
{ "id": "<personality-id>" }
```

Pass `{ "id": null }` to deactivate. Returns `404` if the ID doesn't match an existing personality.

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

| Method | Path                  | Description                                                 |
| ------ | --------------------- | ----------------------------------------------------------- |
| GET    | `/history/projects`   | List projects from archived agents (excludes active ones)   |
| GET    | `/history/agents`     | Paginated archived-agent history with filtering and sorting |
| GET    | `/history/agents/:id` | Detailed agent history including events, tokens, and media  |

### `GET /history/agents`

Query params: `search` (name substring), `project`, `type`, `sort` (`created_at` | `name` | `updated_at`), `order` (`asc` | `desc`, default `desc`), `limit` (max 100), `offset`. Only returns archived (finished) agents.

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

| Method | Path                        | Description                                                                   |
| ------ | --------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/agents/settings`          | Get agent settings (worktree location, icon color, instance name)             |
| POST   | `/agents/settings`          | Update agent settings (all fields optional)                                   |
| GET    | `/app/settings/agent-types` | Get enabled agent types                                                       |
| POST   | `/app/settings/agent-types` | Set enabled agent types (`claude`, `codex`, `cursor`, `opencode`, `terminal`) |

## System

| Method | Path                         | Description                                                                     |
| ------ | ---------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/health`                    | Database connectivity check                                                     |
| GET    | `/app/version`               | Current app version                                                             |
| GET    | `/app/branding`              | App branding info (icon color)                                                  |
| GET    | `/system/defaults`           | System defaults (home directory)                                                |
| GET    | `/system/path-info`          | Path validation (exists, isDirectory, isGitRepo)                                |
| GET    | `/system/path-completions`   | Directory path autocomplete                                                     |
| GET    | `/system/resources`          | Service resource metrics snapshot (`window` query: `15m` or `1h`, default `1h`) |
| POST   | `/system/resources/settings` | Enable or disable resource metrics collection (`{ "enabled": boolean }`)        |
| GET    | `/git/branches`              | List remote branches for a repo                                                 |
| POST   | `/clipboard/image`           | Write browser clipboard image to macOS pasteboard                               |
| POST   | `/energy-report`             | Report PWA energy metrics                                                       |

## Browser Extension

The Chrome extension (developer preview) pairs with Dispatch and submits page feedback to running agents. Pairing endpoints are unauthenticated but rate-limited; the extension data endpoints authenticate with the bearer token issued at pairing exchange rather than the browser session cookie.

| Method | Path                                            | Description                                                                                               |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/browser-extension/pairings`              | Start a pairing — returns `pairingId`, a one-time `pairingSecret`, and a short verification `code`        |
| POST   | `/auth/browser-extension/pairings/:id/exchange` | Exchange an approved pairing for a bearer token                                                           |
| POST   | `/browser-extension/pairings/:id/approve`       | Approve a pending pairing by verification code (called from the Dispatch UI)                              |
| GET    | `/browser-extension/connections`                | List active extension connections (device name, created/expires/last-used)                                |
| DELETE | `/browser-extension/connections/:id`            | Revoke an extension connection                                                                            |
| GET    | `/browser-extension/agents`                     | List running agents eligible to receive feedback (bearer, scope `agents:read`; excludes reviewer agents)  |
| POST   | `/browser-extension/submissions`                | Submit page feedback to an agent (bearer, scope `submissions:write`; idempotent via `clientSubmissionId`) |
| DELETE | `/browser-extension/token`                      | Revoke the caller's own bearer token                                                                      |

## Release Management

| Method | Path                        | Description                                                                          |
| ------ | --------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/release/status`           | Current deployed release tag and timestamp                                           |
| GET    | `/release/info`             | Latest available version and unreleased commits                                      |
| GET    | `/release/cached-info`      | Return the latest auto-check snapshot (or `null` if no check has run yet)            |
| GET    | `/release/auto-update-mode` | Get automatic update-check mode (`off` or `check`)                                   |
| POST   | `/release/auto-update-mode` | Set automatic update-check mode                                                      |
| GET    | `/release/channel`          | Get current release channel (`stable` or `latest`)                                   |
| POST   | `/release/channel`          | Set release channel                                                                  |
| GET    | `/release/admin-check`      | Check if current instance is a release admin                                         |
| POST   | `/release/promote`          | Promote a pre-release to stable (admin only)                                         |
| GET    | `/releases`                 | List recent GitHub releases                                                          |
| POST   | `/release`                  | Trigger new release (`versionType`: major/minor/patch)                               |
| POST   | `/release/update`           | One-click update to a specific tag (gated — see below)                               |
| POST   | `/release/assisted/launch`  | Launch a full-access agent on the production checkout to perform an assisted update  |
| POST   | `/release/assisted/phase`   | Phase callback used by the assisted-update agent (token-authed, not for browser use) |
| GET    | `/release/assisted/state`   | Read the current assisted-update state (tag, phase, notes, checks)                   |
| DELETE | `/release/assisted/state`   | Clear the persisted assisted-update state                                            |
| GET    | `/release/create/stream`    | SSE stream for release-creation progress (backs the admin Releases page)             |
| GET    | `/release/update/stream`    | SSE stream for update-apply progress (backs the all-users Updates page)              |

### `POST /release/auto-update-mode`

```json
{ "mode": "check" }
```

`mode` must be `off` or `check`. When set to `check`, the server fires an immediate background check (in addition to the periodic 6-hour interval) and broadcasts a `release.cached_info_changed` SSE event when results arrive.

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

| Method | Path            | Description                                                      |
| ------ | --------------- | ---------------------------------------------------------------- |
| GET    | `/jobs`         | List all configured jobs                                         |
| POST   | `/jobs`         | Create a job                                                     |
| PATCH  | `/jobs`         | Update a job configuration                                       |
| DELETE | `/jobs`         | Delete a job configuration                                       |
| POST   | `/jobs/enable`  | Enable a job (registers cron schedule)                           |
| POST   | `/jobs/disable` | Disable a job (removes cron schedule)                            |
| POST   | `/jobs/run`     | Manually trigger a job run                                       |
| GET    | `/jobs/stats`   | Get job run statistics                                           |
| GET    | `/jobs/history` | Get job run history (filterable by `name`, `directory`, `limit`) |

### `POST /jobs`

```json
{
  "name": "docs-audit",
  "directory": "~/dev/apps/dispatch",
  "displayName": "Documentation Audit",
  "prompt": "Audit the docs and fix drift.",
  "schedule": "0 3 * * *",
  "timeoutMs": 1800000,
  "needsInputTimeoutMs": 600000,
  "agentType": "claude",
  "useWorktree": true,
  "baseBranch": "main",
  "branchName": "job/docs-audit-{{run_id}}",
  "fullAccess": true,
  "autoArchive": true,
  "callable": false,
  "singleton": true,
  "defaultArgs": { "scope": "primary" },
  "enabled": true
}
```

`name` and `directory` are required (they form the composite key). `~` in `directory` is expanded to the user's home directory. All other fields are optional:

- `displayName` — human-readable label shown in the UI.
- `prompt` — the job prompt (nullable; when null, falls back to a prompt file in `.dispatch/job-prompts/`).
- `schedule` — cron expression for automatic runs (nullable; null means manual-only).
- `timeoutMs` — maximum run duration in milliseconds.
- `needsInputTimeoutMs` — how long a run can stay in `needs_input` before timing out.
- `agentType` — one of `claude`, `codex`, `cursor`, `opencode`.
- `useWorktree` — run in a managed git worktree.
- `baseBranch` — branch to fork worktrees from (nullable).
- `branchName` — branch name for the worktree (nullable).
- `fullAccess` — grant full filesystem access to the agent.
- `autoArchive` — automatically archive the agent when the run completes.
- `callable` — expose in the command palette for on-demand runs.
- `singleton` — prevent concurrent runs of this job.
- `defaultArgs` — key-value pairs passed to the job prompt as default arguments.
- `enabled` — whether the cron schedule is active on creation.

### `PATCH /jobs`

Same schema as `POST /jobs`. `name` and `directory` are required to identify the job; all other fields are optional and only provided fields are updated.

### `DELETE /jobs`

```json
{ "name": "docs-audit", "directory": "~/dev/apps/dispatch" }
```

### `POST /jobs/enable` / `POST /jobs/disable`

```json
{ "name": "docs-audit", "directory": "~/dev/apps/dispatch" }
```

### `POST /jobs/run`

```json
{ "name": "docs-audit", "directory": "/path/to/repo", "wait": false }
```

`name` + `directory` together identify the job. `wait: true` blocks the response until the run reaches a terminal state; otherwise the response returns as soon as the run is queued. Manual runs are tagged with `triggerSource: "manual"` internally.

### `GET /jobs/history`

Query params: `name` (required), `directory` (required), `limit` (1–100, optional).

## Templates

| Method | Path                    | Description                                               |
| ------ | ----------------------- | --------------------------------------------------------- |
| GET    | `/templates`            | List all templates (excludes job-backed templates)        |
| GET    | `/templates/:id`        | Get a template by ID (includes parsed `args` from prompt) |
| POST   | `/templates`            | Create a template                                         |
| PATCH  | `/templates/:id`        | Update a template                                         |
| DELETE | `/templates/:id`        | Delete a template                                         |
| POST   | `/templates/:id/launch` | Launch an agent from a template                           |

### `POST /templates`

```json
{
  "name": "Backend feature",
  "directory": "~/projects/myapp",
  "description": "Standard backend feature agent",
  "prompt": "You are working on {{feature_name}}. Focus on {{area}}.",
  "agentType": "claude",
  "useWorktree": true,
  "baseBranch": "main",
  "branchName": "feature/{{feature_name}}",
  "fullAccess": true,
  "callable": false,
  "allowMedia": true
}
```

`name` and `directory` are required. All other fields are optional. `agentType` must be one of `claude`, `codex`, `cursor`, `opencode`. `callable` controls whether the template appears in the command palette for on-demand use. `allowMedia` (defaults `true`) enables media file attachments on launch. `~` in `directory` is expanded to the user's home directory.

Template prompts support `{{arg_name}}` placeholder syntax — arguments are parsed from the prompt and presented to the user in the launch dialog.

### `PATCH /templates/:id`

Same fields as `POST /templates` but all are optional. Only provided fields are updated.

### `POST /templates/:id/launch`

Launches an agent from a template. Accepts either JSON or `multipart/form-data` (for startup file uploads).

**JSON body:**

```json
{
  "args": { "feature_name": "auth-refactor", "area": "middleware" },
  "directory": "~/projects/myapp",
  "agentType": "codex"
}
```

All fields are optional. `args` fills `{{placeholder}}` values in the template prompt. `directory` overrides the template's default directory. `agentType` overrides the template's configured agent type.

**Multipart body (for startup files):**

When `allowMedia` is enabled on the template, the launch endpoint accepts `multipart/form-data` with:

- `args` — JSON-encoded string of template arguments
- `directory` — override directory
- `agentType` — override agent type
- `startupFiles` — up to 10 file uploads (images, video, documents, or text files)
- `startupLinks` — JSON array of URLs to pin for the agent

Returns `{ agent }` with the newly created agent record.

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
