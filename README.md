# Dispatch

Dispatch is a local-first control plane for running and managing multiple AI coding agents on a Mac host (including headless Mac mini setups), with browser-based terminal access and high-quality iOS Simulator media.

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

| Dependency | Purpose | Install |
|---|---|---|
| **Xcode CLI Tools** | Build tools for native npm modules (node-pty) | `xcode-select --install` |
| **Homebrew** | Package manager | [brew.sh](https://brew.sh) |
| **Node.js 22+** | Runtime | `nvm install 22` (see `.nvmrc`) |
| **Docker Desktop** | Postgres database | `brew install --cask docker` |
| **tmux** | Agent session management | `brew install tmux` |
| **At least one agent CLI** | The agents Dispatch runs | See below |

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

# 3. Install dependencies (backend + frontend)
npm install && npm --prefix web install

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

For setting up Dispatch as a persistent service on a dedicated Mac (e.g. Mac mini), see [docs/12-new-machine-setup.md](docs/12-new-machine-setup.md). That guide covers:

- Full dependency installation (Homebrew Postgres, agent CLIs, Playwright)
- Database and environment configuration
- `bin/install-launchd` for auto-start on boot
- Deploy and update workflow

## Media Sharing

Agents share screenshots and media with the Dispatch UI via `dispatch-share`, which is automatically available in every agent's `PATH`:

- `dispatch-share <image-path> "description"` — publish a Playwright screenshot
- `dispatch-share --sim "description" [udid]` — capture and publish an iOS Simulator screenshot

These commands only work inside running agent sessions (they require `DISPATCH_AGENT_ID` which Dispatch sets automatically). The browser Media panel auto-refreshes to show new images.

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

- Linear project: [Dispatch](https://linear.app/crumbstream/project/dispatch-ad9a26f53856)
- Routing config: `.dispatch/config.json` under the `linear` key
