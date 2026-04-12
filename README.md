# Dispatch

Dispatch is a local-first control plane for running and managing multiple AI coding agents, with browser-based terminal access and media sharing. It runs on macOS and Linux.

## Quick Install

Give this prompt to a coding agent to get Dispatch installed as a persistent service:

> Clone https://github.com/selfcontained/dispatch.git and install it as a persistent service on this machine. Steps:
>
> 1. Clone the repo to `~/.dispatch/server`.
> 2. Install system dependencies: **Node.js 22+**, **PostgreSQL** (14+), **tmux**, **pnpm**, and build tools for native npm modules (Xcode CLI Tools on macOS, `build-essential`/`python3`/`xclip`/`xvfb` on Linux).
> 3. Start PostgreSQL and create the database: `createdb dispatch && psql dispatch -c "CREATE ROLE dispatch WITH LOGIN PASSWORD 'dispatch'; GRANT ALL ON DATABASE dispatch TO dispatch; GRANT ALL ON SCHEMA public TO dispatch;"`.
> 4. `pnpm install && pnpm run build`
> 5. Copy `.env.example` to `.env` and configure: set `AUTH_TOKEN` to a random value (use `openssl rand -hex 32`). The default host binds to localhost; set `DISPATCH_HOST=0.0.0.0` only when this machine should accept remote connections.
> 6. Register as a system service:
>    - **macOS**: Run `bin/install-launchd` to create a launchd plist that starts on boot.
>    - **Linux**: Create a systemd user service for Xvfb (`~/.config/systemd/user/xvfb.service`) that runs `Xvfb :99 -screen 0 1024x768x24`. Enable with `systemctl --user enable --now xvfb`. Then create the Dispatch service (`~/.config/systemd/user/dispatch.service`) that runs `node apps/server/dist/server.js` with `EnvironmentFile=~/.dispatch/server/.env`. Add `DISPATCH_COPY_DISPLAY=:99` to the `.env` file for clipboard image support. Enable with `systemctl --user enable --now dispatch`.
> 7. Verify: `curl http://127.0.0.1:6767/api/v1/health`
> 8. Check which agent CLIs are installed (`claude --version`, `codex --version`, `opencode --version`). In the Dispatch UI under Settings, disable any agent types whose CLI is not installed.

<img width="1440" height="900" alt="image" src="https://github.com/user-attachments/assets/efb154d9-7d4c-411a-861b-d460cb0816d6" />

## Features

- Start, monitor, and stop multiple long-running agents (Claude, Codex, OpenCode) remotely.
- Persist each agent in `tmux` so browser disconnects do not kill work.
- Git worktree isolation for parallel agent work on separate branches.
- MCP-based tooling with repo-specific custom tools (`.dispatch/tools.json`).
- Jobs — scheduled, repo-scoped agent tasks with structured reporting and interactive recovery (`.dispatch/jobs/`).
- Personas — reusable agent roles for automated code review with structured feedback (`.dispatch/personas/`).
- GitHub integration — PR creation and CI status checks via MCP tools.
- Slack notifications with focus-aware suppression.
- Activity analytics — heatmaps, daily status charts, working time by project.
- Token usage tracking by day, project, and model.
- Agent history with soft-delete preservation, filtering, and per-agent detail views.
- Release management — cut releases, deploy tags, and self-update from the UI.
- Theming with multiple color themes and per-theme terminal palettes.
- Browser UI with:
  - interactive terminal access (xterm.js over WebSocket)
  - agent lifecycle controls (create, start, stop, delete)
  - media pane for screenshots, video, and live Playwright browser streaming
  - real-time agent status events via SSE
  - agent pins for surfacing key info (URLs, ports, PRs, files) in the sidebar
  - iOS Simulator device assignment per agent

## Prerequisites

| Dependency | Purpose | macOS | Linux |
|---|---|---|---|
| **Build tools** | Compile native npm modules (node-pty) | `xcode-select --install` | `apt install build-essential python3` |
| **Node.js 22+** | Runtime | `nvm install 22` | `nvm install 22` |
| **pnpm** | Package manager | `npm i -g pnpm` | `npm i -g pnpm` |
| **PostgreSQL 14+** | Database | `brew install postgresql@17` | `apt install postgresql` |
| **tmux** | Agent session management | `brew install tmux` | `apt install tmux` |
| **At least one agent CLI** | The agents Dispatch runs | See below | See below |

### Optional

| Dependency | Purpose | Install |
|---|---|---|
| **Docker** | Isolated dev databases via `dispatch-dev` | macOS: `brew install --cask docker` / Linux: [docs.docker.com](https://docs.docker.com/engine/install/) |
| **Xcode** (full) | iOS Simulator, `xcrun simctl` (macOS only) | App Store |
| **xclip + Xvfb** | Clipboard image paste (Linux only) | `apt install xclip xvfb` |

### Agent CLIs

Dispatch spawns agents via their CLI tools. Install at least one:

| Agent | Install | Authenticate |
|---|---|---|
| **Claude** | `npm install -g @anthropic-ai/claude-code` | `claude` (follow login prompts) |
| **Codex** | `npm install -g codex` | Set `OPENAI_API_KEY` in your shell profile |
| **OpenCode** | `npm install -g opencode` | Set `ANTHROPIC_API_KEY` in your shell profile |

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

# 2. Use the correct Node version
nvm install && nvm use

# 3. Install dependencies
pnpm install

# 4. Copy the example env file
cp .env.example .env

# 5. Start Dispatch
bin/dispatch-dev up --live
```

> **Important:** Docker Desktop must be running (not just installed). If you see
> *"Error: docker compose is not available"*, open Docker.app first.

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

Every agent launched by Dispatch gets access to MCP tools via an agent-scoped endpoint. These tools are available automatically — no configuration needed:

| Tool | Description |
|------|-------------|
| `dispatch_event` | Report agent status (working, blocked, waiting_user, done, idle) |
| `dispatch_rename_session` | Update the current session's display name |
| `dispatch_pin` | Surface key info in the sidebar (URLs, ports, PRs, files) |
| `dispatch_share` | Upload screenshots and media to the agent's media pane |
| `dispatch_feedback` | Submit structured review findings (severity, file refs, suggestions) |
| `dispatch_get_feedback` | Retrieve feedback findings for review |
| `dispatch_resolve_feedback` | Mark a feedback item as fixed or ignored |
| `dispatch_launch_persona` | Launch a persona child agent for automated review |
| `create_pr` | Create a GitHub pull request |
| `get_pr_status` | Check PR CI status and reviews |

Persona agents additionally get: `review_status`, `get_parent_context`.

Job agents additionally get: `job_complete`, `job_failed`, `job_needs_input`, `job_log`, `list_agents`, `list_recent_persona_reviews`, `list_recent_feedback`.

Repos can define custom tools in `.dispatch/tools.json` — these are exposed to agents with a `repo_` prefix.

These tools only work inside running agent sessions (they require agent-scoped MCP context which Dispatch provides automatically).

## Operations

- Release flow (build + restart + health check): `bin/dispatch-server update`
- Deploy a tag to production: `bin/dispatch-deploy --latest` or `bin/dispatch-deploy v0.2.30`
- Cut a new release: `bin/dispatch-release patch|minor|major`
- Service management: `bin/dispatch-server start|stop|restart|status|logs|build`

## Docs

- [API Specification](docs/03-api-spec.md) — complete API endpoint reference
- [Agent Lifecycle Model](docs/04-agent-lifecycle.md) — states, transitions, tmux contract
- [Operations Runbook](docs/10-operations-runbook.md) — service management, releases, diagnostics
- [Backend Compatibility Checklist](docs/11-backend-compatibility-checklist.md) — guidelines for safe backend changes
- [New Machine Setup](docs/12-new-machine-setup.md) — first-time macOS setup guide
- [Theming](docs/14-theming.md) — how to add and customize color themes
- [Personas and Feedback](docs/15-personas-and-feedback.md) — automated code review via persona agents
- [Notifications](docs/16-notifications.md) — Slack webhook integration

## Issue Tracking

- [GitHub Issues](https://github.com/selfcontained/dispatch/issues)
