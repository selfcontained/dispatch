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
  "model": "opus",
  "fullAccess": true,
  "useWorktree": true,
  "createNewBranch": true,
  "worktreeBranch": "fix-auth-bug",
  "baseBranch": "main",
  "autoReview": false,
  "initialPrompt": "Start by reading CONTRIBUTING.md..."
}
```

`type` is one of `claude`, `codex`, `cursor`, `opencode`, or `terminal` and defaults to `codex` if omitted. The type must be enabled in app settings. Terminal-type agents have no CLI to drive — `fullAccess`, `autoReview`, and `initialPrompt` are stored as off/empty regardless of what's posted.

`model` optionally pins the agent to an id from the curated per-type catalog (`GET /agent-models`); ids outside the catalog are rejected with 400, and omitting the field uses the CLI default. When `model` is set, any explicit `--model`/`-m` flags in `agentArgs` are stripped in its favor. The model persists with the agent and is reused on resume.

`useWorktree` requests a managed git worktree; `createNewBranch` (default: true when worktree is created) controls whether a fresh branch named `worktreeBranch` forks from `baseBranch`, or `baseBranch` itself is checked out in the worktree — in which case `worktreeBranch` is ignored. Placement (sibling vs. `.dispatch/worktrees/`) comes from the instance-wide setting at `/agents/settings`, not from this payload. `autoReview` adds the Autonomous Review rule to the agent's launch guidance: before finishing it opens a draft PR, launches reviewer personas with `launch_agent`, and works the `review` blocks they post back. `initialPrompt` is piped into the agent CLI as its first user turn.

This endpoint also accepts `multipart/form-data` to attach up to 10 startup files (20 MB each); array/boolean fields like `agentArgs` and `fullAccess` are accepted as JSON-encoded strings in that form.

Persona agents are not created through this endpoint. An agent launches one with the `launch_agent` MCP tool and `persona: <slug>` (or the UI does through `POST /agents/:id/launch-persona`); the record carries `persona`, `parentAgentId`, and the briefing as `personaContext`.

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

Event types: `working`, `blocked`, `waiting_user`, `done`, `idle`. Status is derived on the server — a turn starting is `working`, a turn settling is `idle` unless the agent has an open `question` or `form` for the user (`waiting_user`), a failed turn or engine exit is `blocked` — so agents never report it themselves. This route is the internal write path the runtime uses.

### `GET /events` (SSE)

Server-Sent Events stream. Used by the frontend for real-time UI updates. Event types:

| Event type                     | Payload                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `snapshot`                     | Full agent list (sent on initial connection)                        |
| `agent.upsert`                 | Single agent record (created or updated)                            |
| `agent.diff_state_changed`     | Diff stats for an agent (or `null` when cleared)                    |
| `agent.deleted`                | Agent ID that was deleted                                           |
| `media.changed`                | Agent ID whose media list changed                                   |
| `media.seen`                   | Agent ID + array of media keys marked seen                          |
| `stream.entry`                 | Agent ID + one feed entry to upsert (a block, with its reactions)   |
| `stream.changed`               | Agent ID whose stream changed; refetch the feed                     |
| `stream.read`                  | Agent ID + the read boundary after `POST /streams/:rootId/read`     |
| `agent.tool_invoked`           | `{ agentId, tool, at }` — an agent called an MCP tool (ephemeral)   |
| `stream.started`               | Agent ID whose live stream started                                  |
| `stream.stopped`               | Agent ID whose live stream stopped                                  |
| `job.changed`                  | (no payload) — job config or run state changed                      |
| `template.changed`             | (no payload) — template created, updated, or deleted                |
| `notification`                 | Web notification payload (id, agent, event, message)                |
| `release.cached_info_changed`  | Latest release-info snapshot (or `null`)                            |

## Quick Phrases

Reusable text snippets that can be sent to an agent as a prompt.

| Method | Path                         | Description                                                  |
| ------ | ---------------------------- | ------------------------------------------------------------ |
| GET    | `/quick-phrases`             | List all phrases (with parsed template args)                 |
| POST   | `/quick-phrases`             | Create a phrase (`text` required, `label` optional)          |
| PATCH  | `/quick-phrases/:id`         | Update phrase `text` and/or `label`                          |
| DELETE | `/quick-phrases/:id`         | Delete a phrase                                              |
| POST   | `/agents/:id/prompts/phrase` | Render a phrase with its args and queue it as the next turn  |

The phrase endpoint accepts `phraseId`, optional `args` (key-value map for template variables), and optional `submit` (default `true`; `false` only renders the text and returns it). Text is capped at 1000 chars per phrase, 2000 chars per arg value, and 10000 chars after variable substitution.

## Media

| Method | Path                      | Description                                                |
| ------ | ------------------------- | ---------------------------------------------------------- |
| GET    | `/agents/:id/media`       | List media files with seen/unseen status                   |
| GET    | `/agents/:id/media/:file` | Download a media file                                      |
| POST   | `/agents/:id/media`       | Upload media (multipart form: file + source + description) |
| POST   | `/agents/:id/media/seen`  | Mark media files as seen                                   |

## Streams

Every agent's product is a stream of blocks (`docs/design/blocks.md`). Wire types live in `packages/shared/src/block-types.ts`. `:rootId` is the stream's root agent; a child's posts land in its parent's stream.

| Method | Path                                                | Description                                                                                           |
| ------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/chat/unread`                                      | Per-agent `{ unread, pendingQuestions }` for every live agent with a non-zero count                   |
| GET    | `/streams/:rootId/blocks?cursor=<c>&limit=<n>`      | Feed: blocks (with reactions and thread reply counts), turns, and system status marks, time ascending |
| GET    | `/streams/:rootId/blocks/:blockId/thread`           | A top-level block and the replies under it                                                            |
| POST   | `/streams/:rootId/blocks`                           | A user post (`{ id?, to?, text, replyTo?, attachments? }`), delivered to the agent as a prompt        |
| POST   | `/streams/:rootId/blocks/:blockId/answer`           | Answer a `question` block (`{ value, label?, attachments? }`); creates the reply and sets `state`     |
| POST   | `/streams/:rootId/blocks/:blockId/submit`           | Submit a `form` block (`{ values }`); creates the reply and sets `state`                              |
| PATCH  | `/streams/:rootId/blocks/:blockId/state`            | Merge into a block's `state` (`{ state }`): resolve, reopen, tick                                     |
| POST   | `/streams/:rootId/blocks/:blockId/reactions`        | React to a block (`{ emoji }`); a user reaction is injected into the agent as a reaction envelope     |
| DELETE | `/streams/:rootId/blocks/:blockId/reactions/:emoji` | Take the user's reaction back off (chip only; nothing is injected)                                    |
| POST   | `/streams/:rootId/read`                             | Mark agent blocks read (`{ upTo? }` block id); returns `{ unreadCount }`                              |

The feed is composed at read time from `blocks`, `agent_events`, and the agent's turns. The response carries `hasMore`, `unreadCount`, and an opaque `nextCursor` — pass it back as `cursor` to page backwards. A block with `to_agent_id` is a prompt for that agent: the write routes respond as soon as it is queued, with `delivered: null` until delivery settles, at which point the row flips to `true`/`false`. `answer` resolves the chosen option from the stored question (unknown values are `400` unless `allowFreeform`) and returns `409` once a question has been answered; `submit` does the same for a form. Every write publishes a `stream.entry` (one entry upserted) or `stream.changed` (refetch) SSE event; `read` publishes `stream.read`.

Agents write to the stream with the `post` / `update` / `react` MCP tools. `post` without `to` goes to the agent's own stream; `to: <agentId>` addresses another agent, and `notify: true` also sends the browser/Slack notification. `kind` defaults from the data given (`question`, `form`, `link`, `review`, `tasks`) and otherwise to `text`; a file is an attachment (`{ type: "file", path }`, uploaded on post). `update` on the author's own block may change `text`, `data`, `attachments` and `state`; on a block addressed to the agent, `state` only. `react` takes a block id and an emoji.

Reactions go both ways: the user reacts to agent blocks through the routes above, and the agent reacts to user blocks with `react`. Each shows on its block as `reactions: [{ id, authorKind, emoji, delivered, createdAt }]`, one per author and emoji; every change republishes the block as a `stream.entry`. A user reaction is delivered like a user post — `delivered: null` while pending — in a `--- DISPATCH REACTION ---` envelope naming the block. Agent reactions are display-only. Adding an emoji already there is a no-op; removing a reaction never notifies the other side.

Launching an agent with context records one launch post in its stream: a user block with `origin: "launch"`, the initial prompt as `text`, and attachments for each startup file (`file`) and startup link (`link`). When another agent created the agent (`launch_agent`), the post is attributed to that agent. The agent's first user turn is that post wrapped in the same `--- DISPATCH POST (id: …) ---` envelope any user post is delivered with, so an agent replies where it was launched. A launch with no prompt, files, or links records nothing.

User posts take up to `BLOCK_ATTACHMENTS_MAX` attachments: `{ type: "file", mediaId }` for a file uploaded first via `POST /agents/:id/media`, or `{ type: "link", url, title? }`. The body is zod-validated (`400` on shape errors, unknown media); `text` may be blank when at least one attachment is present. The injected envelope lists each attachment after the text.

Agent-to-agent traffic is the same table: a block with `to_agent_id` set. There is no separate messages API.

## Streaming

Live Playwright browser streaming via Chrome DevTools Protocol.

| Method | Path                        | Description                                |
| ------ | --------------------------- | ------------------------------------------ |
| POST   | `/agents/:id/stream`        | Start or stop a screen stream              |
| GET    | `/agents/:id/stream`        | MJPEG stream (`multipart/x-mixed-replace`) |
| GET    | `/agents/:id/stream/viewer` | HTML viewer page for the live stream       |

## Personas

| Method | Path                         | Description                                                                              |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/personas`                  | List available personas (`.dispatch/personas/` in the repo at `cwd`, plus the built-ins) |
| POST   | `/agents/:id/launch-persona` | Launch one or more persona agents as children of agent `:id`                             |

### `GET /personas`

Query params: `cwd=/path/to/repo`. The server tries the worktree root first, then the repo root.

Dispatch's built-in personas are appended after the repo's own, so the list is never empty — currently just `code-review` ("General Code Review"). A repo persona with the same slug replaces the built-in rather than appearing alongside it.

### `POST /agents/:id/launch-persona`

```json
{
  "personas": ["backend-security-review", "frontend-ux-review"],
  "agentType": "claude",
  "includeDiff": true,
  "model": "opus",
  "note": "focus on the auth changes"
}
```

Launches one child agent per slug with that persona's instructions, the same launch an agent makes with `launch_agent` and `persona`. `personas` is an array of 1–20 unique slugs, each matching `[a-zA-Z0-9_-]+` (max 100 chars); the legacy singular `persona` field is still accepted but deprecated. `agentType` must be one of the CLI types (`claude`, `codex`, `cursor`, `opencode`). `model` is optional and must come from the curated catalog for `agentType` (`GET /agent-models`); omit or pass `null` for the CLI default. `includeDiff` defaults to `true` and gives the reviewer a file-level map of the parent's changes against its base branch; set it to `false` for non-code reviews (PRDs, docs, media). `note` is optional free text (max 2,000 characters, `null` allowed) used as the briefing; without it the briefing is "Review the agent's current work in this worktree." Returns `{ ok: true, launched: [...] }`.

A reviewer persona finishes its pass by posting one `review` block (`{ verdict, summary, findings }`) to the parent; the parent (or a person, via `PATCH /streams/:rootId/blocks/:blockId/state`) resolves, disputes or reopens each finding in that block's `state`, and discussion is the block's thread. There is no separate review API.

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

`notifyEvents` and `webNotifyEvents` are arrays of event-type strings (`done`, `waiting_user`, `blocked`). When a notable agent event fires, Dispatch first attempts an in-app notification via the SSE event stream; if no browser client acks within ~3s it falls back to the Slack webhook (provided the event is enabled there). Agents belonging to a job run are excluded from that Slack fallback — their status events reach browser notifications only.

### `POST /notifications/ack`

```json
{ "notificationId": "<id from the SSE event>" }
```

Returns `204` regardless of whether the notification was still pending.

## Settings

| Method | Path                                 | Description                                                                               |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| GET    | `/agents/settings`                   | Get agent settings (worktree location, icon color, instance name)                         |
| POST   | `/agents/settings`                   | Update agent settings (all fields optional)                                               |
| GET    | `/app/settings/agent-types`          | Get enabled agent types                                                                   |
| POST   | `/app/settings/agent-types`          | Set enabled agent types (`claude`, `codex`, `cursor`, `opencode`, `terminal`)             |
| GET    | `/app/settings/ides`                 | Get enabled IDE integrations                                                              |
| POST   | `/app/settings/ides`                 | Set enabled IDE integrations                                                              |
| GET    | `/app/settings/launch-guidance-trim` | Whether launch guidance is trimmed to the short rules (the plugin skills carry the depth) |
| POST   | `/app/settings/launch-guidance-trim` | Enable or disable trimmed launch guidance                                                 |
| GET    | `/agent-models`                      | Curated per-type model catalog (`{ models: { claude: [...], ... } }`)                     |

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
  "agentType": "codex",
  "model": "gpt-5.6-sol"
}
```

All fields are optional. `args` fills `{{placeholder}}` values in the template prompt. `directory` overrides the template's default directory. `agentType` overrides the template's configured agent type.

`model` overrides the template's saved model for this launch only, and is three-state: omit it to keep the template's saved model, send `null` to force the CLI default, or send a model id from the catalog for the launched agent type. An id the launched agent type cannot run returns `400`.

**Multipart body (for startup files):**

When `allowMedia` is enabled on the template, the launch endpoint accepts `multipart/form-data` with:

- `args` — JSON-encoded string of template arguments
- `directory` — override directory
- `agentType` — override agent type
- `model` — override model; an empty string means the CLI default, and omitting the field keeps the template's saved model
- `startupFiles` — up to 10 file uploads (images, video, documents, or text files)
- `startupLinks` — JSON array of URLs, attached to the agent's launch post as links

Returns `{ agent }` with the newly created agent record.

## Brain (Shared Memory)

Repo-scoped shared memory for agents. Writes go through the MCP tools (`brain_store_object`, `brain_list_push`, `brain_append_event`, …) — this HTTP API is what the **Brains** tab on the Automations page uses, so it covers reads and deletes only.

Every endpoint requires a `repoRoot` query param naming the project; omitting it returns `400`. Listing endpoints accept `limit` (default 50, max 200).

| Method | Path                               | Description                                                                            |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/brain/projects`                  | List projects with Brain data and their per-type entry counts                          |
| DELETE | `/brain/projects`                  | Delete every object, list, and event for `repoRoot`                                    |
| GET    | `/brain/collections`               | List collections with `objectCount` / `listCount` / `eventCount`                       |
| DELETE | `/brain/collections/:collection`   | Delete every entry in one collection                                                   |
| GET    | `/brain/objects`                   | List objects; optional `collection`, `prefix`                                          |
| GET    | `/brain/objects/:collection/:name` | Read one object (`404` when missing)                                                   |
| DELETE | `/brain/objects/:collection/:name` | Delete one object                                                                      |
| DELETE | `/brain/objects`                   | Bulk-delete objects in one scope                                                       |
| GET    | `/brain/lists`                     | List lists; optional `collection`                                                      |
| GET    | `/brain/lists/:collection/:name`   | Read list items; `limit`, `offset`, `order` (`asc` / `desc`, default `desc`)           |
| DELETE | `/brain/lists/:collection/:name`   | Delete one list and its items                                                          |
| DELETE | `/brain/lists`                     | Bulk-delete lists in one scope                                                         |
| GET    | `/brain/events`                    | Query events; optional `collection`, `kind`, `subject`, `tags` (CSV), `since`, `until` |
| DELETE | `/brain/events/:id`                | Delete one event                                                                       |
| DELETE | `/brain/events`                    | Bulk-delete events in one scope                                                        |
| GET    | `/brain/agent-activity/:agentId`   | Objects, lists, and events one agent created or last updated                           |

Single-entry deletes return `{ "deleted": true | false }`. `DELETE /brain/collections/:collection` and `DELETE /brain/projects` return per-type counts: `{ "objects": 3, "lists": 1, "events": 42 }`.

### Bulk delete by entry type

`DELETE /brain/objects`, `/brain/lists`, and `/brain/events` each clear one entry type within one scope, selected with exactly one of `collection=<name>` or `allCollections=true`:

```
DELETE /api/v1/brain/events?repoRoot=/Users/me/dev/app&collection=docs-audit
DELETE /api/v1/brain/lists?repoRoot=/Users/me/dev/app&allCollections=true
```

Passing both, neither, or a blank `collection` returns `400` — a dropped `collection` must never widen a targeted prune into a project-wide one. Each query key takes a single value; a repeated key (`?collection=a&collection=b`) also returns `400`. The response is `{ "deleted": <count> }`, and deleting lists cascades to their items.

## MCP (Model Context Protocol)

These endpoints use the `/api/mcp` base path (not `/api/v1`).

| Method | Path                            | Description                                               |
| ------ | ------------------------------- | --------------------------------------------------------- |
| POST   | `/api/mcp`                      | Handle global MCP requests                                |
| POST   | `/api/mcp/:agentId`             | Handle agent-scoped MCP requests with repo context        |
| POST   | `/api/mcp/jobs/:runId/:agentId` | Handle job-scoped MCP requests (adds job lifecycle tools) |

Agent-scoped and job-scoped MCP both load repo tools from `.dispatch/tools.json` at the root of the agent's checkout — the worktree root when the agent has one, otherwise the repo root — resolved from `agent.cwd`. A tool's optional `scope` array decides which of the two routes exposes it (`agent` or `job`); the global `/api/mcp` route has no agent and loads none.

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
