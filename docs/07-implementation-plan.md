# Implementation Plan

## Phase 0: Bootstrap

Deliverables:

- Node + TypeScript project scaffold.
- Fastify server with health route.
- PostgreSQL wiring and migrations.
- Basic frontend scaffold (React + Vite, or server-rendered minimal app).

Exit criteria:

- `npm run dev` starts API and UI.

## Phase 1: Core Agent Control

Deliverables:

- DB schema for agents.
- Agent Manager module.
- Endpoints:
  - `POST /agents`
  - `GET /agents`
  - `GET /agents/:id`
  - `POST /agents/:id/stop`
- tmux session create/stop and state reconciliation.

Exit criteria:

- Can create, list, and stop agents.
- Agent remains alive if client disconnects.

## Phase 2: Browser Terminal

Deliverables:

- WebSocket terminal endpoint.
- xterm.js UI integration.
- Attach/detach behavior with reconnection.
- Terminal auth token endpoint.

Exit criteria:

- Interactive browser terminal for each agent works reliably.

## Phase 3: Simulator Isolation + Screenshots

Deliverables:

- Simulator discovery/reservation tables.
- Allocation during agent create.
- `GET /agents/:id/screenshot` endpoint.
- UI media pane for screenshot preview/refresh.

Exit criteria:

- Each agent can display screenshot from its assigned simulator.

## Phase 4: Hardening

Deliverables:

- Auth middleware across HTTP and WS.
- Input validation + allowed cwd roots.
- Structured logs and action audit records.
- Operational limits (max agents, request rate limits).

Exit criteria:

- Private deployment usable over Tailscale/VPN with sane safety controls.

## Phase 5: Quality of Life

Deliverables:

- Agent restart/reassign simulator operations.
- Search/filter agents in UI.
- Optional thumbnail stream (periodic screenshot push).
- Health diagnostics page (tmux/simctl status).

## Suggested Initial Milestone

Implement phases 0 and 1 first, verify lifecycle stability, then add terminal and media. Lifecycle correctness is the core risk reducer.
