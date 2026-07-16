# Dispatch

Dispatch is a local-first control plane for running and managing multiple AI coding agents, with browser-based terminal access and media sharing. It runs on macOS and Linux.

## Quick Install

Give this prompt to a coding agent to get Dispatch installed as a persistent service:

> Clone https://github.com/selfcontained/dispatch.git and install it as a persistent service on this machine. Steps:
>
> 1. Clone the repo to `~/.dispatch/server`.
> 2. Install system dependencies: **PostgreSQL** (14+), **tmux**, and the agent CLI binaries you want Dispatch to launch.
> 3. Start PostgreSQL and create the database: `createdb dispatch && psql dispatch -c "CREATE ROLE dispatch WITH LOGIN PASSWORD 'dispatch'; GRANT ALL ON DATABASE dispatch TO dispatch; GRANT ALL ON SCHEMA public TO dispatch;"`.
> 4. Copy `.env.example` to `.env`. The defaults work for local-only use. Set `DISPATCH_HOST=0.0.0.0` only when this machine should accept remote connections. On first visit to the web UI you will be prompted to set a password; sessions are stored as signed HTTP cookies.
> 5. Register as a system service:
>    - **macOS**: Run `bin/install-launchd` to create a launchd plist that starts on boot.
>    - **Linux**: Create a systemd user service for Xvfb (`~/.config/systemd/user/xvfb.service`) that runs `Xvfb :99 -screen 0 1024x768x24`. Enable with `systemctl --user enable --now xvfb`. Then create the Dispatch service (`~/.config/systemd/user/dispatch.service`) that runs the compiled `dist/bun/dispatch-<version>-bun-linux-x64` or `dist/bun/dispatch-<version>-bun-linux-arm64` binary with `EnvironmentFile=~/.dispatch/server/.env`. Add `DISPATCH_COPY_DISPLAY=:99` to the `.env` file for clipboard image support. Enable with `systemctl --user enable --now dispatch`.
> 6. Verify: `curl http://127.0.0.1:6767/api/v1/health`
> 7. Check which agent CLIs are installed (`claude --version`, `codex --version`, `agent --version`, `opencode --version`). In the Dispatch UI under Settings, disable any agent types whose CLI is not installed.

<img width="1440" height="900" alt="image" src="https://github.com/user-attachments/assets/efb154d9-7d4c-411a-861b-d460cb0816d6" />

## Features

- Start, monitor, and stop multiple long-running agents (Claude, Codex, Cursor, OpenCode, or a plain tmux terminal) remotely.
- Persist each agent in `tmux` so browser disconnects do not kill work.
- Git worktree isolation for parallel agent work on separate branches.
- MCP-based tooling with repo-specific custom tools (`.dispatch/tools.json`).
- Jobs — scheduled, repo-scoped agent tasks with structured reporting and interactive recovery.
- Personas — reusable agent roles for automated code review with structured feedback (`.dispatch/personas/`).
- Personalities — short system-prompt blocks appended to every agent for voice or standing preferences.
- Keyboard shortcuts and a command palette (`Mod+K`) for fast navigation and actions.
- GitHub integration — PR creation and CI status checks via MCP tools.
- Slack notifications with focus-aware suppression.
- Activity analytics — heatmaps, daily status charts, working time by project.
- Token usage tracking by day, project, and model.
- Agent history with soft-delete preservation, filtering, and per-agent detail views.
- Release management — cut releases, deploy tags, and self-update from the UI.
- Theming with multiple color themes and per-theme terminal palettes.
- Password-based login with first-run setup and per-device session cookies.
- Browser UI with:
  - quick phrases — reusable text snippets with template variables, injectable into agent terminals
  - interactive terminal access (xterm.js over WebSocket, resumable after browser reconnect)
  - agent lifecycle controls (create, start, stop, delete — with background archive cleanup)
  - media pane for screenshots, video, text snippets, and live Playwright browser streaming (MJPEG over CDP)
  - real-time agent status events via SSE
  - agent pins for surfacing key info (URLs, ports, PRs, files) in the sidebar
  - in-app browser notifications (with Slack fallback if no browser client acks)
  - in-app docs pane covering features and MCP tools

## Prerequisites

| Dependency                 | Purpose                  | macOS                        | Linux                    |
| -------------------------- | ------------------------ | ---------------------------- | ------------------------ |
| **PostgreSQL 14+**         | Database                 | `brew install postgresql@17` | `apt install postgresql` |
| **tmux**                   | Agent session management | `brew install tmux`          | `apt install tmux`       |
| **At least one agent CLI** | The agents Dispatch runs | See below                    | See below                |

Dispatch currently uses an artifact-first deploy path, and production installs run the compiled Bun binary from `dist/bun/`; the host does not need Node just to run Dispatch.

### Optional

| Dependency       | Purpose                                   | Install                                                                                                 |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **GitHub CLI**   | Help agents work with GitHub and open PRs | `brew install gh` / `apt install gh`                                                                    |
| **Docker**       | Isolated dev databases via `dispatch-dev` | macOS: `brew install --cask docker` / Linux: [docs.docker.com](https://docs.docker.com/engine/install/) |
| **xclip + Xvfb** | Clipboard image paste (Linux only)        | `apt install xclip xvfb`                                                                                |

### Agent CLIs

Dispatch spawns agents via their CLI tools. Install at least one:

| Agent        | Install                                    | Authenticate                                  |
| ------------ | ------------------------------------------ | --------------------------------------------- |
| **Claude**   | `npm install -g @anthropic-ai/claude-code` | `claude` (follow login prompts)               |
| **Codex**    | `npm install -g codex`                     | Set `OPENAI_API_KEY` in your shell profile    |
| **Cursor**   | Install [Cursor](https://www.cursor.com/)  | Configure in Cursor settings                  |
| **OpenCode** | `npm install -g opencode`                  | Set `ANTHROPIC_API_KEY` in your shell profile |

The agent CLI must be authenticated before Dispatch can spawn agents of that type. Dispatch invokes the CLI directly, so any API keys or login state in your shell environment are inherited automatically.

### Preflight Check

Run `bin/preflight` to see what's installed and what's missing:

```bash
bin/preflight
```

## Setup

```bash
# 1. Clone and enter the repo
git clone git@github.com:selfcontained/dispatch.git
cd dispatch

# 2. Install dependencies
pnpm install

# 3. Copy the example env file
cp .env.example .env

# 4. Start Dispatch
bin/dispatch-dev up --live
```

For day-to-day backend work, the server itself runs under Bun. `pnpm` is still used at the repo root for dependency installation and workspace-level scripts.

> **Important:** Docker Desktop must be running (not just installed). If you see
> _"Error: docker compose is not available"_, open Docker.app first.

`dispatch-dev` automatically:

- Spins up an isolated Postgres container on a free port
- Runs database migrations on server start
- Starts the API server on a free port
- Starts the Vite frontend dev server
- Enables live agent spawning via tmux (with `--live`)
- Prints the URLs when ready

Open the Vite URL printed in the output to access the UI.

### Managing the Dev Environment

```bash
bin/dispatch-dev status             # check what's running
bin/dispatch-dev logs               # API server logs
bin/dispatch-dev logs --vite        # Vite server logs
bin/dispatch-dev url                # print the API server URL
bin/dispatch-dev down               # tear everything down
bin/dispatch-dev restart             # restart the environment
```

### Verify

```bash
# Health check
curl -s $(bin/dispatch-dev url)/api/v1/health | jq

# Create a test agent
curl -s -X POST $(bin/dispatch-dev url)/api/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"cwd": "/tmp", "type": "claude"}' | jq
```

## Production Setup (Dedicated Machine)

For setting up Dispatch as a persistent service on a dedicated machine, see [docs/12-new-machine-setup.md](docs/12-new-machine-setup.md). That guide covers macOS with launchd. For Linux, the Quick Install prompt above provides systemd instructions that an agent can follow.

## MCP Tools

Every agent launched by Dispatch gets access to MCP tools via an agent-scoped endpoint. The tool set depends on the agent type — interactive agents, persona reviewers, and job runners each expose a different set, all configured automatically with no setup.

### Interactive agents

| Tool                            | Description                                                                |
| ------------------------------- | -------------------------------------------------------------------------- |
| `create_pr`                     | Create a GitHub pull request                                               |
| `get_pr_status`                 | Check PR CI status and reviews                                             |
| `dispatch_event`                | Report agent status (`working`, `blocked`, `waiting_user`, `done`, `idle`) |
| `dispatch_rename_session`       | Update the current session's display name                                  |
| `dispatch_notify`               | Send a Slack notification from the agent                                   |
| `dispatch_pin`                  | Surface key info in the sidebar (URLs, ports, PRs, files)                  |
| `dispatch_share`                | Upload screenshots and media to the agent's media pane                     |
| `dispatch_list_media`           | List media files shared with or by this agent                              |
| `list_personas`                 | List available persona reviewers for this project                          |
| `dispatch_launch_persona`       | Launch a persona child agent for automated review                          |
| `dispatch_review_list_feedback` | List human review feedback items with statuses and threads                 |
| `dispatch_review_resolve`       | Resolve a review feedback item as fixed or dismissed                       |
| `dispatch_review_reopen`        | Reopen a resolved review feedback item                                     |
| `dispatch_review_add_message`   | Reply to a review feedback thread                                          |
| `dispatch_launch_agent`         | Launch a new child agent to work on a subtask                              |
| `list_agents`                   | List other agents in the same repo with IDs, names, statuses, and activity |
| `dispatch_send_message`         | Send a message to another running agent by ID or name                      |
| `get_activity_summary`          | Summarize agent activity over a time range                                 |
| `get_agent_history`             | Get detailed agent session history                                         |
| `get_feedback_summary`          | Aggregate persona review feedback for pattern detection                    |
| `brain_get_object`              | Read a shared object from the repo-scoped Brain                            |
| `brain_store_object`            | Create or update a shared Brain object (optimistic concurrency)            |
| `brain_list_objects`            | List Brain objects, optionally filtered by collection or prefix            |
| `brain_delete_object`           | Delete a shared Brain object                                               |
| `brain_list_push`               | Append one or more items to a shared Brain list                            |
| `brain_list_remove`             | Remove one item from a shared Brain list by index or field match           |
| `brain_list_get`                | Read items from a shared Brain list with paging and ordering               |
| `brain_list_set`                | Replace one item in a shared Brain list by index                           |
| `brain_list_delete`             | Delete a shared Brain list and all of its items                            |
| `brain_append_event`            | Append a structured event to the Brain's immutable event log               |
| `brain_query_events`            | Query Brain events by collection, kind, subject, tags, and time range      |
| `list_jobs`                     | List jobs scoped to a directory                                            |
| `get_job`                       | Get a single job by ID or name                                             |
| `create_job`                    | Create a new job                                                           |
| `update_job`                    | Update an existing job's configuration                                     |
| `delete_job`                    | Delete a job                                                               |
| `run_job`                       | Trigger an immediate run of a job                                          |
| `list_templates`                | List templates scoped to a directory                                       |
| `get_template`                  | Get a single template by ID or name                                        |
| `create_template`               | Create a new reusable agent launch template                                |
| `update_template`               | Update an existing template                                                |
| `delete_template`               | Delete a template                                                          |

### Persona agents

Persona review agents get a narrower set focused on reviewing their parent's work: `dispatch_review_submit`, `dispatch_review_add_feedback`, `dispatch_review_list_feedback`, `dispatch_review_add_message`, `dispatch_event`, `dispatch_pin`, `dispatch_share`, and `get_parent_context`.

### Job agents

Job agents get lifecycle and reporting tools: `job_complete`, `job_failed`, `job_needs_input`, `job_log`, plus the interactive collaboration, unified review, analytics, Brain, job, and template tools listed above.

### Repo-specific tools

Repos can define custom tools in `.dispatch/tools.json` — these are exposed to agents with a `repo_` prefix. The same file also defines lifecycle hooks (for example `stop` to tear down per-agent dev environments).

These tools only work inside running agent sessions (they require agent-scoped MCP context which Dispatch provides automatically).

## Operations

- Update production from the Dispatch UI: **Settings → Updates**
- Cut releases from the Dispatch UI: **Settings → Releases** (release admin only)
- CLI/API path for updates and releases: `bin/dispatch-server update`
- Service management: `bin/dispatch-server start|stop|restart|status|logs|build`
- Production runtime note: the launchd/systemd service runs the compiled Bun binary, so Node/npx is not required on the host just to run Dispatch.

## Docs

User-facing documentation (agents, keyboard shortcuts, personalities, repo tools, jobs, worktrees, reviewers, status events, media, notifications, updates) lives in the app itself — open the **Docs** pane from the sidebar. The files below are developer-facing references that aren't duplicated in the UI:

- [API Specification](docs/03-api-spec.md) — complete API endpoint reference
- [Agent Lifecycle Model](docs/04-agent-lifecycle.md) — states, transitions, tmux contract
- [Operations Runbook](docs/10-operations-runbook.md) — service management, releases, diagnostics
- [Backend Compatibility Checklist](docs/11-backend-compatibility-checklist.md) — guidelines for safe backend changes
- [New Machine Setup](docs/12-new-machine-setup.md) — first-time macOS setup guide
- [Theming](docs/14-theming.md) — how to add and customize color themes
- [Jobs](docs/17-jobs.md) — scheduled/on-demand agent tasks with structured reports

## Issue Tracking

- [GitHub Issues](https://github.com/selfcontained/dispatch/issues)
