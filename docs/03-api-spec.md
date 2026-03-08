# API Specification (MVP)

## Conventions

- Base path: `/api/v1`
- Auth: bearer token header (MVP) or Tailscale IP allowlist + token
- Response: JSON unless binary image endpoint

## Agent Model

```json
{
  "id": "agt_01J...",
  "name": "ios-fix-1",
  "status": "running",
  "cwd": "/Users/bharris/dev/apps/foo",
  "tmuxSession": "hostess_agt_01J...",
  "pid": 12345,
  "simulatorUdid": "A1B2C3...",
  "createdAt": "2026-03-07T19:20:00Z",
  "updatedAt": "2026-03-07T19:22:00Z"
}
```

## Endpoints

### `POST /agents`

Create a new agent.

Request body:

```json
{
  "name": "ios-fix-1",
  "cwd": "/Users/bharris/dev/apps/foo",
  "codexArgs": [],
  "allocateSimulator": true
}
```

Response `201`:

```json
{
  "agent": { "...": "..." }
}
```

### `GET /agents`

List all agents.

Response `200`:

```json
{
  "agents": []
}
```

### `GET /agents/:id`

Get one agent.

### `POST /agents/:id/start`

Start stopped agent (recreate tmux session and process if absent).

### `POST /agents/:id/stop`

Stop running agent.

Request body:

```json
{
  "force": false,
  "releaseSimulator": true
}
```

### `DELETE /agents/:id`

Delete agent metadata (only when stopped unless `force=true`).

### `POST /agents/:id/terminal/token`

Issue short-lived token for terminal websocket session.

Response:

```json
{
  "wsUrl": "/api/v1/agents/agt_01J/terminal/ws?token=..."
}
```

### `GET /agents/:id/screenshot`

Return latest screenshot as `image/png`.

Query params:

- `fresh=true|false` (if true, capture now; else return cached last screenshot if available)

### `GET /simulators`

List available simulators and reservation status.

### `POST /agents/:id/simulator/reassign`

Reassign simulator.

## WebSocket

### `WS /agents/:id/terminal/ws?token=...`

- Bi-directional terminal I/O stream.
- Server handles tmux attach bridge.
- Heartbeat/ping every 20s.

### `WS /agents/:id/media/ws` (optional in phase 2)

- Push screenshot update metadata or stream frames.

## Error Codes

- `400` invalid request/body
- `401` unauthenticated
- `403` unauthorized
- `404` agent/simulator not found
- `409` lifecycle conflict (e.g., start running agent)
- `500` internal runtime failure
