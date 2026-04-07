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
> 5. Copy `.env.example` to `.env` and configure: set `AUTH_TOKEN` to a random value (use `openssl rand -hex 32`). The other defaults are usually fine.
> 6. Register as a system service:
>    - **macOS**: Run `bin/install-launchd` to create a launchd plist that starts on boot.
>    - **Linux**: Create a systemd user service for Xvfb (`~/.config/systemd/user/xvfb.service`) that runs `Xvfb :99 -screen 0 1024x768x24`. Enable with `systemctl --user enable --now xvfb`. Then create the Dispatch service (`~/.config/systemd/user/dispatch.service`) that runs `node apps/server/dist/server.js` with `EnvironmentFile=~/.dispatch/server/.env`. Add `DISPATCH_COPY_DISPLAY=:99` to the `.env` file for clipboard image support. Enable with `systemctl --user enable --now dispatch`.
> 7. Verify: `curl http://127.0.0.1:6767/api/v1/health`
> 8. Check which agent CLIs are installed (`claude --version`, `codex --version`, `opencode --version`). In the Dispatch UI under Settings, disable any agent types whose CLI is not installed.

## Features

- Start, monitor, and stop multiple long-running agents (Claude, Codex, OpenCode) remotely.
- Persist each agent in `tmux` so browser disconnects do not kill work.
- Give each agent an isolated iOS Simulator device assignment.
- Browser UI with:
  - interactive terminal access (xterm.js over WebSocket)
  - agent lifecycle controls (create, start, stop, delete)
  - media pane for screenshots/video
  - real-time agent status events via SSE

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

## Media Sharing

Agents share screenshots and media with the Dispatch UI via the `dispatch_share` MCP tool, which is automatically available to every agent through the Dispatch MCP server:

- `dispatch_share` with `filePath` and `description` — publish a Playwright screenshot
- `dispatch_share` with `source: "simulator"` and `description` — capture and publish an iOS Simulator screenshot

These tools only work inside running agent sessions (they require agent-scoped MCP context which Dispatch provides automatically). The browser Media panel auto-refreshes to show new images.

## Operations

- Release flow (build + restart + health check): `bin/dispatch-server update`
- Deploy a tag to production: `bin/dispatch-deploy --latest` or `bin/dispatch-deploy v0.2.30`
- Cut a new release: `bin/dispatch-release patch|minor|major`
- Interactive debug mode: `bin/dispatch-server start|stop|status|logs|attach`

## Docs

- [Product Requirements](docs/01-product-requirements.md)
- [System Architecture](docs/02-system-architecture.md)
- [API Specification](docs/03-api-spec.md)
- [Agent Lifecycle Model](docs/04-agent-lifecycle.md)
- [Simulator Isolation Strategy](docs/05-simulator-strategy.md)
- [Security Model](docs/06-security.md)
- [Implementation Plan](docs/07-implementation-plan.md)
- [New Machine Setup](docs/12-new-machine-setup.md)
- [Operations Runbook](docs/10-operations-runbook.md)

## Issue Tracking

- [GitHub Issues](https://github.com/selfcontained/dispatch/issues)
