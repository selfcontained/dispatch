# New Machine Setup Guide

Instructions for setting up Dispatch on a fresh Mac (e.g. Mac Studio, Mac mini) as a dedicated agent host.

## Prerequisites

The new machine needs:

| Dependency | Purpose | Install |
|---|---|---|
| **Xcode CLI Tools** | Build tools for native npm modules (node-pty) | `xcode-select --install` |
| **Homebrew** | Package manager | https://brew.sh |
| **NVM** | Node version manager (Dispatch requires Node 22 LTS+) | `brew install nvm` or https://github.com/nvm-sh/nvm |
| **Docker Desktop** | PostgreSQL container | https://docker.com/products/docker-desktop/ |
| **tmux** | Agent session management | `brew install tmux` |
| **Git** | Source control | Included with Xcode CLI Tools |
| **GitHub CLI** | Release automation | `brew install gh` |
| **Tailscale** | Remote access (VPN mesh) | https://tailscale.com/download |

### Optional (for iOS Simulator features)

| Dependency | Purpose |
|---|---|
| **Xcode** (full) | iOS Simulator, `xcrun simctl` |
| **Claude CLI** | Agent runtime (`brew install claude` or npm) |

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
brew install tmux gh nvm

# Add NVM to shell profile (~/.zshrc)
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.zshrc
echo '[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"' >> ~/.zshrc
source ~/.zshrc

# Node
nvm install 22
nvm alias default 22
```

### 2. Docker & PostgreSQL

```bash
# Install Docker Desktop (GUI or via brew)
brew install --cask docker

# Start Docker Desktop, then verify
docker info

# Start Dispatch's Postgres (from repo root, after clone)
docker compose up -d postgres

# Verify
docker exec dispatch-postgres pg_isready -U dispatch -d dispatch
```

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

Edit `.env`:

```
HOST=0.0.0.0
DISPATCH_PORT=6767
DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:5432/dispatch
AUTH_TOKEN=<generate-a-real-token>
MEDIA_ROOT=~/.dispatch/media
DISPATCH_BIN_DIR=/Users/<you>/dev/apps/dispatch/bin
```

**Important:** `DISPATCH_BIN_DIR` must be an absolute path to the `bin/` directory. This is how agents get `dispatch-share`, `dispatch-event`, and `dispatch-stream` on their PATH.

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

### 7. Tailscale (remote access)

```bash
# Install and authenticate
brew install --cask tailscale
# Open Tailscale, sign in

# Access from other machines:
# http://<mac-studio-tailscale-ip>:6767
```

No special Dispatch configuration needed — it binds to `0.0.0.0` by default, so it's accessible on the Tailscale interface.

### 8. GitHub CLI auth (for releases)

```bash
gh auth login
```

This is needed for `bin/dispatch-release` to trigger GitHub Actions workflows.

### 9. Claude CLI setup (for agents)

Install Claude CLI so Dispatch can spawn Claude agents:

```bash
# Verify it's available
which claude
claude --version
```

The `claudeBin` config defaults to `claude` on PATH. If it's installed elsewhere, set `DISPATCH_CLAUDE_BIN` in `.env`.

## Post-Setup Verification Checklist

```bash
# Docker & Postgres running
docker compose ps

# Server healthy
curl -s http://127.0.0.1:6767/api/v1/health | jq

# tmux available
tmux -V

# Node version correct
node -v  # Should be v25.8.0+

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
docker compose ps                    # Is postgres running?
docker compose up -d postgres        # Start it
docker compose logs postgres         # Check logs
```

### node-pty build failures
```bash
xcode-select --install               # Ensure CLI tools
npm rebuild node-pty                  # Rebuild native module
```

### Agent can't find dispatch-share/dispatch-event
Check that `DISPATCH_BIN_DIR` in `~/.dispatch/server/.env` is an absolute path pointing to the production checkout's `bin/` directory (typically `~/.dispatch/server/bin`).

---

## Friction Points & Improvement Opportunities

Issues identified during this review that could make setup smoother:

### P1 — Should fix before new machine setup

1. ~~**Node 25.8.0 is bleeding-edge.**~~ **FIXED** — switched to Node 22 LTS.

2. **`DISPATCH_BIN_DIR` default is fragile.** The config falls back to `path.resolve(process.cwd(), "bin")` which works for dev but is error-prone in production. The `install-launchd` script doesn't explicitly set `DISPATCH_BIN_DIR` in the server `.env`, so it relies on the launchd wrapper's `cd` to make the relative path work. Should be explicitly set to an absolute path during install.

3. **No `npm run db:migrate` in the install flow.** Migrations run inside the server on boot (`migrate.ts` is imported by `server.ts`), but this isn't documented. If the server fails to start, it's unclear whether the DB is the issue. An explicit migration step would help debugging.

4. **Docker must be running before launchd starts the server.** There's no dependency ordering — if the Mac reboots and Docker Desktop hasn't started yet, the server will fail to connect to Postgres and crash-loop until Docker is ready. launchd's `KeepAlive: true` will eventually recover, but it's noisy.

5. **The `.env.example` has `DISPATCH_BIN_DIR=/path/to/dispatch/bin`** — a placeholder that's easy to miss. Should either default to something sensible or be set automatically by `install-launchd`.

### P2 — Nice to have

6. **Two separate git checkouts (dev + production) is intentional.** The `install-launchd` flow clones a second copy to `~/.dispatch/server/`. This keeps the live service isolated from the dev checkout so local development doesn't disrupt running agents. Updates reach production via `bin/dispatch-deploy <tag>`.

7. **Auth is not enforced.** `AUTH_TOKEN` exists in config but no middleware validates it. On a Tailscale network this is probably fine, but worth noting for the security-conscious.

8. **No health check on Docker/Postgres in server startup.** The server tries to connect to Postgres immediately. If Docker is slow to start, the server errors out rather than retrying.

9. **launchd log rotation.** `dispatch.log` grows forever. No logrotate or size cap.

10. **`install-launchd` uses `launchctl load` (deprecated).** Apple recommends `launchctl bootstrap` for modern macOS. Still works, but may warn.

11. **Media in `/tmp/` is ephemeral.** Default `MEDIA_ROOT=~/.dispatch/media` gets cleared on reboot. Fine for transient screenshots but surprising if you expect persistence. Should either document this clearly or default to `~/.dispatch/media/`.

12. **Lots of `tmp-*.mjs` files and screenshots in repo root.** Not in `.gitignore`'s tracked patterns but showing as untracked. Could use a cleanup or a broader gitignore pattern.
