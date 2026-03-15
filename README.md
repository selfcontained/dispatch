# Dispatch

Dispatch is a local-first control plane for running and managing multiple AI coding agents on a Mac host (including headless Mac mini setups), with browser-based terminal access and high-quality iOS Simulator media.

## Features

- Start, monitor, and stop multiple long-running agents (Claude, Codex, OpenCode) remotely.
- Persist each agent in `tmux` so browser disconnects do not kill work.
- Give each agent an isolated iOS Simulator device assignment.
- Browser UI with:
  - interactive terminal access (xterm.js over WebSocket)
  - agent lifecycle controls (create, start, stop, delete)
  - media pane for screenshots/video with `dispatch-share`
  - real-time agent status events via SSE

## Tech Stack

- Backend: Node.js + TypeScript + Fastify
- Frontend: React + Vite + Tailwind CSS
- Realtime: WebSocket (terminals), SSE (agent events)
- Terminal UI: xterm.js
- State store: PostgreSQL
- Process control: `tmux`, `xcrun simctl`, PTY process management

## Local Development Setup

### Prerequisites

| Dependency | Purpose | Install |
|---|---|---|
| **Node.js 22+** | Runtime | `nvm install 22` (see `.nvmrc`) |
| **Docker** | Dev database (Postgres) | `brew install --cask docker` |
| **tmux** | Agent session management | `brew install tmux` |

Run `bin/preflight` to check what's installed and what's missing.

### Quick Start

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

# 5. Start the dev environment (isolated DB + API server + Vite frontend)
bin/dispatch-dev up --vite
```

`dispatch-dev` automatically:
- Spins up an isolated Postgres container on a free port
- Runs database migrations on server start
- Starts the API server on a free port
- Starts the Vite frontend dev server (with `--vite`)
- Prints the URLs when ready

```bash
# Check what's running
bin/dispatch-dev status

# View API server logs
bin/dispatch-dev logs

# View Vite logs
bin/dispatch-dev logs --vite

# Get the API server URL
bin/dispatch-dev url

# Tear it all down
bin/dispatch-dev down
```

To enable live agent spawning (tmux-backed), add `--live`:

```bash
bin/dispatch-dev up --vite --live
```

### Verify

Once `dispatch-dev up --vite` reports ready:
- **UI**: open the Vite URL printed in the output
- **Health**: `curl -s $(bin/dispatch-dev url)/api/v1/health | jq`

## Production Setup (New Machine)

For setting up Dispatch as a persistent service on a dedicated Mac, see [docs/12-new-machine-setup.md](docs/12-new-machine-setup.md). That guide covers:

- Full dependency installation (Homebrew Postgres, tmux, agent CLIs, Playwright)
- Database and environment configuration
- `bin/install-launchd` for auto-start on boot
- Deploy and update workflow

## Operations Quick Commands

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
- [Current State Handoff](docs/08-current-state-handoff.md)
- [Agent Attention Phase 2 Plan](docs/09-agent-attention-phase-2.md)
- [Operations Runbook](docs/10-operations-runbook.md)
- [Backend Compatibility Checklist](docs/11-backend-compatibility-checklist.md)
- [New Machine Setup](docs/12-new-machine-setup.md)

## Media Sharing

- Each newly created agent gets a media directory exposed as `DISPATCH_MEDIA_DIR` in its shell environment.
- Each newly created agent also gets `dispatch-share` in `PATH` for explicit media publishing.
- `dispatch-share` commands:
  - `dispatch-share <image-path> [name]`
  - `dispatch-share --sim [udid] [name]`
- Save `.png`, `.jpg`, `.jpeg`, `.gif`, or `.webp` files into that directory from within the agent session.
- The browser Media panel auto-refreshes and renders those images.

## Agent Guidance

- Dispatch launches new agents with a startup guidance prompt instructing them to use `dispatch-share` for Playwright and iOS Simulator screenshot sharing.
- Agents run Playwright in headless mode by default unless the user explicitly requests headed mode.

## Issue Tracking

- Linear routing for this repo is stored in `.dispatch/config.json` under the `linear` key.
- Current target:
  - team: `CrumbStream` (`CRU`)
  - project: `Dispatch`
  - project URL: `https://linear.app/crumbstream/project/dispatch-ad9a26f53856`

## Non-Goals

- Multi-tenant SaaS deployment
- Internet-exposed unauthenticated access
- Full RBAC and enterprise identity integration
