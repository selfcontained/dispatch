# Current State Handoff (March 2026)

This doc is for a new agent picking up work on Hostess. It describes what the tool currently is, how it runs, what is implemented vs planned, and where to make changes.

## What Hostess Is

Hostess is a local-first control plane for managing long-running Codex CLI agents on a Mac host.

Core value today:
- Start and manage multiple Codex agents backed by `tmux`.
- Open a browser UI for agent control and terminal interaction.
- Keep agent sessions alive when browser clients disconnect.
- Let agents share high-quality screenshots into a media stream via `hostess-share`.

## Implementation Snapshot

### Backend
- Runtime: Node.js + TypeScript + Fastify.
- Entry point: `/Users/bharris/dev/apps/hostess/src/server.ts`.
- DB: PostgreSQL (Docker Compose), migrations in `/Users/bharris/dev/apps/hostess/src/db/migrate.ts`.
- Process/runtime manager: `/Users/bharris/dev/apps/hostess/src/agents/manager.ts`.
- Terminal bridge: WebSocket + `node-pty` attaching to `tmux`.

### Frontend
- React + Vite + Tailwind + shadcn-style components.
- Source: `/Users/bharris/dev/apps/hostess/web`.
- Main screen: collapsible left agent rail, center terminal, right media drawer (`Sheet`).
- Terminal rendering: xterm.js.

### Static serving
- Backend serves `web/dist` if built.
- Falls back to legacy `public/` only if `web/dist` is missing.

## Data and Services

### Database schema in use
`agents` table stores:
- lifecycle status
- `cwd`
- `tmux_session`
- `media_dir`
- `codex_args`
- `last_error`
- optional `simulator_udid` (not fully wired yet)

`simulator_reservations` table exists from migration, but simulator allocation service is not fully implemented.

### Docker-backed persistence
- File: `/Users/bharris/dev/apps/hostess/docker-compose.yml`
- Service: `postgres` (`postgres:17-alpine`)
- Persistent volume: `hostess_pgdata`

## Current User Flow

1. Create agent from modal (`name`, absolute `cwd`).
2. Hostess creates DB record, starts `tmux` session, launches `codex`.
3. UI selects agent and can attach terminal (or auto-attach after create/open).
4. Terminal disconnect/reconnect does not kill agent because `tmux` persists.
5. Agent shares media with:
   - `hostess-share <image-path> [name]`
   - `hostess-share --sim [udid] [name]`
6. Media drawer shows files from that selected agent’s media directory.
7. Stop sends Ctrl-C then kills tmux session if needed.
8. Delete removes agent record (and can force-stop running session first).

## Agent Runtime Contract

- Session name format: `hostess_<agent-id>`.
- Agent ID format: `agt_<12 hex>`.
- Each agent gets:
  - `HOSTESS_AGENT_ID`
  - `HOSTESS_MEDIA_DIR`
  - typo-compat alias `HOSTESS_MDEIA_DIR`
  - `PATH` including `HOSTESS_BIN_DIR` for `hostess-share`.
- Codex launch includes startup instructions telling agents:
  - use `hostess-share` for Playwright and iOS screenshots
  - default Playwright to headless unless user asks for headed.

## API Surface Implemented

Implemented in `src/server.ts`:
- `GET /api/v1/health`
- `GET /api/v1/agents`
- `GET /api/v1/agents/:id`
- `POST /api/v1/agents`
- `POST /api/v1/agents/:id/start`
- `POST /api/v1/agents/:id/stop`
- `DELETE /api/v1/agents/:id`
- `GET /api/v1/agents/:id/media`
- `GET /api/v1/agents/:id/media/:file`
- `POST /api/v1/agents/:id/terminal/token`
- `WS /api/v1/agents/:id/terminal/ws?token=...`

Not yet implemented from older planning docs:
- full simulator reservation/allocation workflow
- dedicated screenshot endpoint like `/agents/:id/screenshot`
- media websocket push stream (media is currently polled by UI)

## Frontend Behavior Today

Main app: `/Users/bharris/dev/apps/hostess/web/src/App.tsx`

- Left panel:
  - collapsible rail, not fully hidden
  - list agents
  - attention indicator for agents in backend-reported error state
  - open/start, stop, delete actions per agent
- Center:
  - selected agent context
  - attach/detach terminal controls
  - auto reconnect when tab regains focus/visibility
- Right:
  - media drawer opened by `Media` button
  - refresh button and per-agent media list
  - image lightbox for full-size preview

## Known Friction / Gaps

- No auth enforcement is wired into request handlers yet (`AUTH_TOKEN` exists in config only).
- Media polling is interval-based (4s), not event-driven.
- Agent attention is currently narrow: it only reflects backend-reported agent error state, not detached tmux activity or richer app-level response events.
- Simulator orchestration is partially scaffolded but not end-to-end.
- Some planned docs still describe endpoints/features not shipped yet.
- Existing running agents may have old state from previous UI/runtime iterations.

## Operations Quickstart

From `/Users/bharris/dev/apps/hostess`:

1. `nvm use default`
2. `docker compose up -d postgres`
3. `npm install`
4. `npm run build`
5. `npm run start`
6. Open `http://127.0.0.1:8787`

For development:
- `npm run dev` (backend watch mode)
- `npm --prefix web run dev` (if iterating frontend separately)

## Validation Checklist for New Work

- Run `npm run check`.
- Run `npm run build`.
- Verify UI can:
  - create agent
  - attach terminal and send input
  - detach and reattach without killing tmux session
  - show media from `hostess-share`
  - stop and delete agent
- Stop any throwaway test agents you create.

## Most Relevant Files

- Backend API: `/Users/bharris/dev/apps/hostess/src/server.ts`
- Agent lifecycle/runtime: `/Users/bharris/dev/apps/hostess/src/agents/manager.ts`
- Terminal attach bridge: `/Users/bharris/dev/apps/hostess/src/terminal/tmux-terminal.ts`
- Media helper CLI: `/Users/bharris/dev/apps/hostess/bin/hostess-share`
- React app: `/Users/bharris/dev/apps/hostess/web/src/App.tsx`
- UI primitives: `/Users/bharris/dev/apps/hostess/web/src/components/ui`
- Main README: `/Users/bharris/dev/apps/hostess/README.md`
- Attention follow-up plan: `/Users/bharris/dev/apps/hostess/docs/09-agent-attention-phase-2.md`
