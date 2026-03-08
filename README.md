# Hostess

Hostess is a local-first control plane for running and managing multiple Codex CLI agents on a Mac host (including headless Mac mini setups), with browser-based terminal access and high-quality iOS Simulator media.

## Goals

- Start, monitor, and stop multiple long-running agents remotely.
- Persist each agent in `tmux` so browser disconnects do not kill work.
- Give each agent an isolated iOS Simulator device assignment.
- Provide a browser UI with:
  - interactive terminal access
  - agent lifecycle controls
  - media pane for screenshots/video

## MVP Scope

- Backend service running on the host machine.
- Browser UI served by backend.
- Agent manager with `tmux` integration.
- Web terminal attached/detached to agent `tmux` sessions.
- Per-agent simulator allocation and screenshot capture endpoint.
- Minimal auth for remote access over Tailscale/VPN.

## Current Status

- Phase 0 complete:
  - Fastify server + static UI shell
  - Docker Compose Postgres with persistent volume
  - TypeScript build/check scripts
- Phase 1 in progress:
  - implemented agent lifecycle API for create/list/get/start/stop/delete
  - implemented tmux-backed agent runtime management and startup reconciliation
- Phase 2 implemented:
  - PTY-backed browser terminal over WebSocket (`tmux attach-session`)
  - detach/reattach terminal support while agent keeps running
  - per-agent media panel for image rendering
  - images loaded from each agent media directory (`$HOSTESS_MEDIA_DIR`)

## Docs

- [Product Requirements](/Users/bharris/dev/apps/hostess/docs/01-product-requirements.md)
- [System Architecture](/Users/bharris/dev/apps/hostess/docs/02-system-architecture.md)
- [API Specification](/Users/bharris/dev/apps/hostess/docs/03-api-spec.md)
- [Agent Lifecycle Model](/Users/bharris/dev/apps/hostess/docs/04-agent-lifecycle.md)
- [Simulator Isolation Strategy](/Users/bharris/dev/apps/hostess/docs/05-simulator-strategy.md)
- [Security Model](/Users/bharris/dev/apps/hostess/docs/06-security.md)
- [Implementation Plan](/Users/bharris/dev/apps/hostess/docs/07-implementation-plan.md)
- [Current State Handoff](/Users/bharris/dev/apps/hostess/docs/08-current-state-handoff.md)
- [Agent Attention Phase 2 Plan](/Users/bharris/dev/apps/hostess/docs/09-agent-attention-phase-2.md)

## Proposed Tech Stack (MVP)

- Backend: Node.js + TypeScript + Fastify
- Realtime: WebSocket
- Terminal UI: xterm.js
- State store: PostgreSQL (Docker Compose volume-backed)
- Process control: `tmux`, `xcrun simctl`, PTY process management

## Local Setup (Current Scaffold)

1. Use the project Node version:
   - `nvm install`
   - `nvm use`
2. Start persistence services:
   - `docker compose up -d postgres`
3. Start the app:
   - `cp .env.example .env`
   - `npm install`
   - `npm run dev`
4. Verify:
   - UI: `http://127.0.0.1:8787`
   - Health: `http://127.0.0.1:8787/api/v1/health`

## Media Sharing

- Each newly created agent gets a media directory exposed as `HOSTESS_MEDIA_DIR` in its shell environment.
- Each newly created agent also gets `hostess-share` in `PATH` for explicit media publishing.
- `hostess-share` commands:
  - `hostess-share <image-path> [name]`
  - `hostess-share --sim [udid] [name]`
- Save `.png`, `.jpg`, `.jpeg`, `.gif`, or `.webp` files into that directory from within the agent session.
- The browser Media panel auto-refreshes and renders those images.
- For older agents created before media support, Hostess falls back to `/tmp/hostess-media/<agent-id>`.

## Agent Guidance

- Hostess launches new Codex agents with a startup guidance prompt instructing them to use `hostess-share` for Playwright and iOS Simulator screenshot sharing.
- Hostess startup guidance also instructs agents to run Playwright in headless mode by default unless the user explicitly requests headed mode.

## Non-Goals (MVP)

- Multi-tenant SaaS deployment
- Internet-exposed unauthenticated access
- Full RBAC and enterprise identity integration
- Pixel-perfect simulator remote control (view-focused first)
