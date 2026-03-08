# System Architecture

## Components

1. Web UI
- Agent list and controls.
- Terminal panel using xterm.js.
- Media panel for screenshots/stream.

2. API Server
- REST endpoints for lifecycle and metadata.
- WebSocket gateway for terminal and media updates.
- Authentication middleware.

3. Agent Runtime Manager
- Creates and supervises tmux sessions.
- Launches Codex CLI in session.
- Tracks runtime state and heartbeats.

4. Simulator Manager
- Discovers available iOS simulators.
- Reserves device per agent.
- Captures screenshots/video from assigned UDID.

5. State Store (PostgreSQL)
- Agent registry.
- Simulator reservations.
- Event/audit trail (optional in MVP, recommended).

## Data Flow

1. Create agent
- UI -> `POST /agents`
- API validates `cwd`.
- Agent Manager creates `tmux` session + starts Codex CLI.
- Simulator Manager allocates UDID (optional/required based on request).
- State persisted in PostgreSQL.

2. Attach terminal
- UI opens WS `ws://.../agents/:id/terminal`.
- Server binds WS to tmux attach/read-write stream.
- Disconnect closes WS only, not tmux session.

3. Screenshot fetch
- UI calls `GET /agents/:id/screenshot`.
- Server runs `xcrun simctl io <udid> screenshot --type=png <tmpfile>`.
- Returns PNG bytes or signed local URL.

## Failure Handling

- Backend crash/restart:
  - reload agent records from DB
  - reconcile with live tmux sessions
  - mark stale agents as `unknown` then `stopped` if session absent
- Simulator unavailable:
  - mark `sim_status=error`
  - keep agent terminal operational

## Minimal Deployment Topology

- Single process backend on host Mac.
- Local reverse proxy optional.
- Access restricted to Tailscale/VPN network.
