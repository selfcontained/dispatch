# New Machine Setup Guide

Instructions for setting up Dispatch on a fresh Mac (e.g. Mac Studio, Mac mini) as a dedicated agent host.

## Prerequisites

The new machine needs:

| Dependency | Purpose | Install |
|---|---|---|
| **Xcode CLI Tools** | Build tools for native npm modules (node-pty) | `xcode-select --install` |
| **Homebrew** | Package manager | https://brew.sh |
| **NVM** | Node version manager (Dispatch requires Node 22 LTS+) | `brew install nvm` or https://github.com/nvm-sh/nvm |
| **PostgreSQL 17** | Database (via Homebrew, native — no Docker needed) | `brew install postgresql@17` |
| **tmux** | Agent session management | `brew install tmux` |
| **Git** | Source control | Included with Xcode CLI Tools |
| **GitHub CLI** | Release automation | `brew install gh` |
| **At least one agent CLI** | Agent runtime — install any you plan to use | See [Agent CLIs](#8-agent-clis) |
| **Playwright browsers** | Headless Chrome for agent UI validation | `npx playwright install chromium` |

### Optional

| Dependency | Purpose | Install |
|---|---|---|
| **Docker Desktop** | Isolated dev databases via docker-compose | `brew install --cask docker` |
| **Xcode** (full) | iOS Simulator, `xcrun simctl` | App Store |

## Agent Setup Prompt

Copy and paste this prompt to a Claude agent on the new machine to kick off setup:

```
Set up Dispatch on this machine. The repo is at https://github.com/selfcontained/dispatch.git

1. Install system dependencies if missing: Homebrew, nvm, Node 22 LTS, tmux, PostgreSQL 17 (via brew), GitHub CLI, Playwright browsers.
2. Install agent CLIs: check which of claude, codex, and opencode are available (claude --version, codex --version, opencode --version). Install any that are needed (npm install -g @anthropic-ai/claude-code, npm install -g codex, npm install -g opencode).
3. Clone the repo to ~/dev/apps/dispatch.
4. Run bin/preflight and fix any failures it reports.
5. Start Postgres: brew services start postgresql@17
6. Create the dispatch database: createdb dispatch && psql dispatch -c "CREATE ROLE dispatch WITH LOGIN PASSWORD 'dispatch'; GRANT ALL ON DATABASE dispatch TO dispatch; GRANT ALL ON SCHEMA public TO dispatch;"
7. Copy .env.example to .env. Generate a random AUTH_TOKEN (use openssl rand -hex 32).
8. Run: nvm use && npm ci && npm --prefix web ci && npm run build
9. Verify locally: npm run start, then curl http://127.0.0.1:6767/api/v1/health — confirm it returns ok, then stop the server.
10. Install the launchd service: bin/install-launchd --port 6767
11. Verify production: curl http://127.0.0.1:6767/api/v1/health and launchctl list com.dispatch.server
12. Configure enabled agent types: check which agent CLIs are actually installed, then use the API to set only those types as enabled: curl -X POST http://127.0.0.1:6767/api/v1/app/settings/agent-types -H 'Content-Type: application/json' -d '{"enabledAgentTypes": ["claude"]}' (adjust the array to include only installed CLIs).
13. Run gh auth login to authenticate GitHub CLI for releases.

Read docs/12-new-machine-setup.md for full details and troubleshooting. Report any issues you hit.
```

## Preflight Check

Run this first to see what's missing:

```bash
bin/preflight
```

It checks for all required and optional dependencies and tells you exactly what to install.

## Step-by-step Setup

### 1. System dependencies

```bash
# Xcode CLI tools (if not already present)
xcode-select --install

# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Core tools
brew install tmux gh nvm postgresql@17

# Add NVM to shell profile (~/.zshrc)
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
echo '[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"' >> ~/.zshrc
source ~/.zshrc

# Node
nvm install 22
nvm alias default 22
```

### 2. PostgreSQL

Production uses Homebrew Postgres (native, no Docker VM overhead, starts at boot):

```bash
brew install postgresql@17
brew services start postgresql@17

# Create database and role
createdb dispatch
psql dispatch -c "CREATE ROLE dispatch WITH LOGIN PASSWORD 'dispatch'; GRANT ALL ON DATABASE dispatch TO dispatch; GRANT ALL ON SCHEMA public TO dispatch;"

# Verify
pg_isready
psql dispatch -c "SELECT 1"
```

For development, you can also use `docker compose up -d postgres` for isolated dev databases.

### 3. Clone the repo

```bash
mkdir -p ~/dev/apps
cd ~/dev/apps
git clone git@github.com:selfcontained/dispatch.git
cd dispatch
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — the only value you must change is `AUTH_TOKEN`:

```
HOST=0.0.0.0
DISPATCH_PORT=6767
DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:5432/dispatch
AUTH_TOKEN=<generate-a-real-token>
MEDIA_ROOT=~/.dispatch/media
```

Generate a token with `openssl rand -hex 32`.

### 5. Build & verify locally

```bash
nvm use
npm ci
npm --prefix web ci
npm run build

# Quick smoke test
npm run start
# In another terminal:
curl -s http://127.0.0.1:6767/api/v1/health | jq
# Ctrl-C to stop
```

### 6. Install as launchd service (production)

```bash
bin/install-launchd --port 6767
```

This:
- Clones the repo to `~/.dispatch/server/` (separate checkout for production)
- Copies your `.env` to `~/.dispatch/server/.env`
- Builds the project
- Creates and loads a launchd plist (`~/Library/LaunchAgents/com.dispatch.server.plist`)
- Server starts automatically on login, restarts on crash

**Verify:**

```bash
launchctl list com.dispatch.server
curl -s http://127.0.0.1:6767/api/v1/health | jq
tail -20 ~/.dispatch/logs/dispatch.log
```

### 7. GitHub CLI auth (for releases)

```bash
gh auth login
```

This is needed for `bin/dispatch-release` to trigger GitHub Actions workflows.

### 8. Agent CLIs

Dispatch spawns agents via their CLI tools. Install whichever you plan to use:

```bash
# Claude CLI
npm install -g @anthropic-ai/claude-code
claude --version

# Codex CLI
npm install -g codex
codex --version

# OpenCode CLI
npm install -g opencode
opencode --version
```

The config defaults to `claude`, `codex`, and `opencode` on PATH. To override, set `DISPATCH_CLAUDE_BIN`, `DISPATCH_CODEX_BIN`, or `DISPATCH_OPENCODE_BIN` in `.env`.

After setup, configure which agent types are available in the create-agent dialog. In the Dispatch UI go to **Settings > Agent Types** and enable only the CLIs you have installed. Or use the API:

```bash
# Example: only Claude and Codex are installed
curl -X POST http://127.0.0.1:6767/api/v1/app/settings/agent-types \
  -H 'Content-Type: application/json' \
  -d '{"enabledAgentTypes": ["claude", "codex"]}'
```

### 9. Playwright browsers

Agents use Playwright for headless UI validation. Install the browser once — it's shared across all agents:

```bash
npx playwright install chromium
```

## Post-Setup Verification Checklist

```bash
# Postgres running
pg_isready

# Server healthy
curl -s http://127.0.0.1:6767/api/v1/health | jq

# tmux available
tmux -V

# Node version correct
node -v  # Should be v22+

# Create a test agent via API
curl -s -X POST http://127.0.0.1:6767/api/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"cwd": "/tmp", "type": "claude"}' | jq

# List agents
curl -s http://127.0.0.1:6767/api/v1/agents | jq

# Open UI in browser
open http://127.0.0.1:6767
```

## Deploying Updates

```bash
# From the dev checkout (not ~/.dispatch/server):

# Option A: Deploy latest tag
bin/dispatch-deploy --latest

# Option B: Cut a new release and deploy
bin/dispatch-release patch   # or minor/major

# Option C: Deploy specific tag
bin/dispatch-deploy v0.2.4
```

Deploy includes automatic rollback on health check failure.

## Key Paths Reference

| Path | Purpose |
|---|---|
| `~/dev/apps/dispatch/` | Development checkout |
| `~/.dispatch/server/` | Production checkout (managed by deploy scripts) |
| `~/.dispatch/server/.env` | Production environment config |
| `~/.dispatch/logs/dispatch.log` | Server stdout/stderr |
| `~/.dispatch/logs/last-release-failure.log` | Deploy failure details |
| `~/.dispatch/release.json` | Current release metadata |
| `~/Library/LaunchAgents/com.dispatch.server.plist` | launchd service definition |
| `~/.dispatch/media/` | Agent media storage (default) |

## Troubleshooting

### Server won't start
```bash
tail -50 ~/.dispatch/logs/dispatch.log
launchctl list com.dispatch.server   # Check exit code
```

### Database connection errors
```bash
pg_isready                           # Is postgres running?
brew services start postgresql@17    # Start it
tail -20 /opt/homebrew/var/log/postgresql@17.log  # Check logs
```

### node-pty build failures
```bash
xcode-select --install               # Ensure CLI tools
npm rebuild node-pty                  # Rebuild native module
```

### Agent can't use dispatch_event/dispatch_share MCP tools
These tools are served via the Dispatch MCP server at `/api/mcp/:agentId`. They are available automatically to agents launched by Dispatch — no PATH or bin directory needed. If the tools are missing, verify that the Dispatch server is running and the agent's MCP config points to the correct URL.

> **Legacy**: The old `dispatch-share` and `dispatch-event` shell scripts in `bin/` still exist for backward compatibility but agents should use the MCP tools instead.

---

## Design Decisions

- **Two separate git checkouts** (dev at `~/dev/apps/dispatch/`, production at `~/.dispatch/server/`): Intentional — keeps live service isolated from development. Updates reach production via `bin/dispatch-deploy <tag>`.
- **Migrations run on boot**: No explicit `db:migrate` step needed. The server runs migrations automatically on startup.
- **Database retry on boot**: Server retries the Postgres connection up to 15 times (30s) on startup. With Homebrew Postgres (starts via launchd at boot), this is rarely needed but provides resilience.
- **Homebrew Postgres for production, Docker for dev**: Production uses native Homebrew Postgres — no VM overhead, starts at boot via `brew services`, one fewer moving part. Docker Compose is available for isolated dev databases when needed.
