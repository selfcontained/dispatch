> **Note:** This document is a historical planning artifact. Playwright browser streaming has been implemented — see the current codebase for authoritative behavior.

# Playwright Browser Streaming — Implementation Plan

## Overview

Enable agents to stream their Playwright browser session as a live video feed in the Dispatch UI. The agent makes ONE call to register the stream source (`dispatch-stream start --playwright <port>`), then the backend handles everything — connecting to Chrome via CDP, subscribing to `Page.startScreencast`, and multiplexing JPEG frames to any number of browser tabs as an MJPEG HTTP stream.

## Validation Results

- Playwright MCP launches Chrome with `--remote-debugging-port` exposed
- CDP `Page.startScreencast` delivers push-based JPEG frames at **~37 FPS**
- Each frame is ~13KB JPEG — very manageable bandwidth
- CDP WebSocket URL is discoverable via `http://localhost:{port}/json`
- No config changes needed to the Playwright MCP server

## Architecture

```
Agent calls: dispatch-stream start --playwright 62816
                    │
                    ▼
         POST /api/v1/agents/{id}/stream
                    │
                    ▼
    StreamManager connects to CDP WebSocket
    subscribes to Page.startScreencast
                    │
                    ▼
    Frames pushed at ~37 FPS (JPEG, ~13KB each)
                    │
                    ▼
    Multiplexed to MJPEG HTTP clients
         GET /api/v1/agents/{id}/stream
                    │
                    ▼
    Frontend: <img src="/api/v1/agents/{id}/stream">
    (browsers render MJPEG natively, no JS needed)
```

## New Files

### `src/stream-manager.ts`

Self-contained class that manages CDP WebSocket connections and multiplexes JPEG frames to MJPEG HTTP viewer connections.

**State:** `Map<agentId, StreamSession>` where `StreamSession` holds:
- The CDP WebSocket connection
- A `Set<NodeJS.WritableStream>` of MJPEG viewer connections
- `status: 'connecting' | 'live' | 'stopped'`

**Public methods:**
- `startStream(agentId, port): Promise<void>` — discovers CDP target URL via `fetch('http://localhost:{port}/json')`, picks the first `page` target, opens native `WebSocket`, enables `Page.startScreencast({ format:'jpeg', quality:60, maxWidth:1280, maxHeight:800 })`, listens for `Page.screencastFrame` events. On each frame: ack via `Page.screencastFrameAck`, decode base64, push JPEG buffer to all subscriber streams.
- `stopStream(agentId): void` — sends `Page.stopScreencast`, closes CDP WebSocket, closes all viewer streams, deletes Map entry.
- `addViewer(agentId, stream): () => void` — adds a writable stream as an MJPEG subscriber, returns an unsubscribe function.
- `hasStream(agentId): boolean`
- `stopAll(): void` — for server shutdown cleanup.

**Callback:** Constructor accepts `onStateChange(agentId, event: 'started'|'stopped')` that `server.ts` uses to fire SSE events.

**CDP details:**
- Node 25 has native `WebSocket` — no `ws` package needed
- Must send `Page.screencastFrameAck` for every frame or Chrome throttles to 1 FPS
- If CDP WebSocket closes unexpectedly, call `stopStream` (no auto-reconnect in V1)

**MJPEG frame format:**
```
--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {n}\r\n\r\n{jpeg bytes}\r\n
```

**Backpressure:** Skip frames for slow viewers rather than blocking the CDP pump. Check `stream.writable` before writing.

### `bin/dispatch-stream`

Shell script modeled on `bin/dispatch-event`.

```
Usage:
  dispatch-stream start --playwright <port>
  dispatch-stream stop
```

- Reads `DISPATCH_AGENT_ID` (already set in agent env), `DISPATCH_PORT`, `DISPATCH_API_BASE`
- POSTs JSON to `${API_BASE}/api/v1/agents/${AGENT_ID}/stream`
- Uses `curl -fsS` like `dispatch-event`

## Backend Changes (`src/server.ts`)

### Instantiation

```ts
const streamManager = new StreamManager((agentId, event) => {
  uiEventBroker.publish(
    event === 'started'
      ? { type: 'stream.started', agentId }
      : { type: 'stream.stopped', agentId }
  );
});
```

### Extend `UiEvent` union

```ts
| { type: 'stream.started'; agentId: string }
| { type: 'stream.stopped'; agentId: string }
```

### `hasStream` injection

Create a helper to inject `hasStream` into agent records at serialization time:

```ts
function withStreamFlag(agent: AgentRecord): AgentRecord & { hasStream: boolean } {
  return { ...agent, hasStream: streamManager.hasStream(agent.id) };
}
```

Apply `withStreamFlag` wherever an `AgentRecord` is sent to the client (snapshots, `agent.upsert` events, etc.).

### New routes

**`POST /api/v1/agents/:id/stream`**
- Body: `{ type: 'playwright', port: number }` or `{ type: 'stop' }`
- For `playwright`: call `streamManager.startStream(id, port)`, return `{ ok: true }`
- For `stop`: call `streamManager.stopStream(id)`, return `{ ok: true }`
- 404 if agent not found, 409 if stream already active

**`GET /api/v1/agents/:id/stream`**
- Validate agent exists and `streamManager.hasStream(id)`
- `reply.hijack()`, then `reply.raw.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', ... })`
- Register with `streamManager.addViewer(id, reply.raw)`
- On `reply.raw` close: call unsubscribe

### Cleanup

- In `DELETE /api/v1/agents/:id` handler: call `streamManager.stopStream(id)`
- In `shutdown()`: call `streamManager.stopAll()`

## Frontend Changes

### `web/src/components/app/types.ts`

Add `hasStream?: boolean` to the `Agent` type.

### `web/src/App.tsx`

**State:**
```ts
const [streamingAgentIds, setStreamingAgentIds] = useState<Set<string>>(new Set());
```

**SSE event handling:**
- `snapshot`: init `streamingAgentIds` from agents where `hasStream === true`
- `stream.started`: add agentId to set
- `stream.stopped`: remove agentId from set
- `agent.upsert`: sync hasStream field

**Derived state:**
```ts
const selectedAgentHasStream = selectedAgentId ? streamingAgentIds.has(selectedAgentId) : false;
```

**Props to media sidebar:**
```tsx
hasStream={selectedAgentHasStream}
streamUrl={selectedAgentId ? `/api/v1/agents/${selectedAgentId}/stream` : null}
```

### `web/src/components/app/media-sidebar.tsx`

**New props:**
```ts
hasStream: boolean;
streamUrl: string | null;
```

**Local state:**
```ts
const [liveMode, setLiveMode] = useState(false);
```

**Auto-reset:** `useEffect` to set `liveMode = false` when `hasStream` becomes `false`.

**Header:** When `hasStream`, show a pulsing red dot + "LIVE" badge and a toggle button.

**Body:** When `liveMode && hasStream && streamUrl`:
```tsx
<div className="flex h-full items-center justify-center bg-black">
  <img
    src={streamUrl}
    alt="Live browser stream"
    className="max-h-full max-w-full object-contain"
  />
</div>
```

Otherwise, show existing thumbnail gallery.

## Design Decisions

- **No DB changes** — stream state is in-memory only (Map keyed by agentId)
- **MJPEG** over WebSocket-to-frontend — browsers render it natively in `<img>`, zero frontend complexity
- **Node 25 native WebSocket** — no extra npm dependencies for CDP
- **No auto-reconnect** in V1 — if CDP drops, stream stops cleanly
- **Single page target** — picks first `page` type from CDP `/json`. Multiple pages not supported in V1.

## Gotchas

1. **`Page.screencastFrameAck`** — must be sent for every frame or Chrome throttles to 1 FPS. Requires `sessionId` from the frame event.
2. **`reply.raw.writeHead()`** — must be used (not just `setHeader`) before MJPEG streaming after `reply.hijack()`.
3. **Viewer backpressure** — skip frames for slow viewers instead of blocking. Check `stream.writable` before writing.
4. **TypeScript** — Node 25's native WebSocket may need a type shim if `@types/node` doesn't declare it yet.
5. **`bin/dispatch-stream` permissions** — must be `chmod +x` and `git update-index --chmod=+x`.
6. **`hasStream` in SSE snapshots** — must be injected via `withStreamFlag` in the `sendSnapshot` path.

## File Change Summary

| File | Change | Description |
|---|---|---|
| `src/stream-manager.ts` | New | CDP WebSocket consumer + MJPEG multiplexer |
| `src/server.ts` | Modify | Stream routes, `hasStream` injection, cleanup |
| `bin/dispatch-stream` | New | Shell script for agents to register/stop streams |
| `web/src/components/app/types.ts` | Modify | Add `hasStream?: boolean` to `Agent` |
| `web/src/App.tsx` | Modify | Track `streamingAgentIds`, handle new SSE events |
| `web/src/components/app/media-sidebar.tsx` | Modify | Live mode toggle, MJPEG `<img>` view |

## Future: iOS Simulator Streaming

The same architecture applies, but with a subprocess loop instead of CDP:
- Backend runs `xcrun simctl io <udid> screenshot --type=jpeg -` in a tight loop (~4.5 FPS)
- Same MJPEG multiplexer serves the frames
- `dispatch-stream start --sim [udid]` variant
- StreamManager gains a second source type
