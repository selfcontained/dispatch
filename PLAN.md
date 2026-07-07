# Whiteboard Integration Plan

> **Status (2026-07-07): MVP (Phases 1+2) + Phase 3 (agent drawing) implemented and validated.**
> Board draws/persists/reloads; agent sees it via `whiteboard_get` + PNG snapshot and
> draws back via `whiteboard_update` (server-side builder, live sync, "agent drew" tab dot).
> Environment surprises + insinuated decisions: see `.unknowns/journal.md` (gitignored, local).

A shared, agent-interactive whiteboard (Excalidraw-based) as a third center-pane tab
alongside **Terminal** and **Changes**. The user draws; the agent can _see_ the board
(scene JSON + rendered PNG snapshot) and _draw back_ via MCP tools, enabling a visual
back-and-forth about architecture and design.

## Decisions (flagged assumptions — cheap to veto now)

| #   | Decision                                                                                                                                                                       | Rationale / alternative                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Excalidraw** (`@excalidraw/excalidraw`, MIT)                                                                                                                                 | tldraw needs a license key / watermark. User asked for "Excalidraw-esque".                                                                                                                                                                                                                                         |
| D2  | **Board is per-agent** (keyed by `agent_id`)                                                                                                                                   | Matches the tab's location. Repo-scoped shared boards are a natural follow-up (brain-style), not MVP.                                                                                                                                                                                                              |
| D3  | **Scene JSON is the source of truth, stored server-side** (Postgres `jsonb`)                                                                                                   | Survives reloads; agent can read/write with no browser attached.                                                                                                                                                                                                                                                   |
| D4  | **Agent sees the board two ways**: simplified scene JSON _and_ a PNG snapshot exported by the client on save                                                                   | JSON alone is hard to interpret for freeform sketches; PNG leverages vision. ~~Snapshot reuses the existing media pipeline~~ **Killed by blindspot #2**: media seen-key is `name:updatedAt`, so update-in-place re-badges unseen on every save. Store snapshot on the whiteboard row / dedicated endpoint instead. |
| D5  | **Agent draws via a simplified element schema**, expanded server-side by our own builder (~200 LOC) — not by importing Excalidraw's browser-only `convertToExcalidrawElements` | Raw Excalidraw elements are verbose and fragile (seeds, versionNonce, bindings). Browser-lib-on-server is a trap. **Spike this first** (see risks).                                                                                                                                                                |
| D6  | **Merge, don't lock**: element-level last-writer-wins using Excalidraw's built-in `version`/`versionNonce` reconciliation                                                      | Excalidraw elements are designed for this; full CRDT is overkill for 1 human + 1 agent.                                                                                                                                                                                                                            |
| D7  | Agent is only _prompted_ when the user explicitly asks (send-to-agent button or typing in terminal)                                                                            | No auto-interrupt per stroke; agent pulls board state when it wants via MCP.                                                                                                                                                                                                                                       |

## Grilled decisions (2026-07-07, user-confirmed)

| #   | Decision                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | **Snapshot = plain file on disk**: server writes `whiteboard.png` into the agent's media dir with **no `media` DB row** — agent vision-Reads the path from `whiteboard_get`; invisible to media list/badge. Verify while building that media listing is DB-backed (exclude by filename if any disk-listing path exists). |
| G2  | **Keep-mounted once opened** (Terminal pattern, deviates from route-mounted Changes copy): lazy-mount Excalidraw on first visit to `/agents/:id/whiteboard`, then CSS-hide on tab switch. Undo/zoom/unsaved strokes survive in memory; no localStorage view-state machinery.                                             |
| G3  | **Tool access**: `AGENT_TOOLS` get `whiteboard_get` + `whiteboard_update`; `PERSONA_TOOLS` get `whiteboard_get` only; `JOB_TOOLS` get neither.                                                                                                                                                                           |
| G4  | **Draw schema**: simplified ops only (add/update/delete over rect/ellipse/diamond/arrow/line/text/frame with label/from/to/color). No raw-element passthrough, no mermaid in MVP.                                                                                                                                        |
| G5  | **Live sync**: agent edits auto-apply via `updateScene()`, queued while the user's pointer is down and flushed on pointer-up; subtle "agent drew" indicator.                                                                                                                                                             |
| G6  | **Ping path**: "Ask agent" button with optional note → injects a DISPATCH MESSAGE envelope telling the agent to call `whiteboard_get` (pull-based; no scene JSON in the prompt).                                                                                                                                         |
| G7  | **Delivery**: PR 1 = Phases 1+2 (MVP: board + agent can _view_, incl. spikes). Later PRs: agent drawing (Phase 3), ask-button/polish (Phase 4).                                                                                                                                                                          |

## Architecture

```
┌─ web (React) ────────────────┐        ┌─ server (Fastify) ─────────────┐
│ WhiteboardTab (lazy)         │  PUT   │ /agents/:id/whiteboard          │
│  └ <Excalidraw/>             │───────▶│  reconcile + save (jsonb)       │
│  debounced save + PNG export │        │  publish SSE whiteboard.changed │
│  SSE → updateScene()         │◀───────│                                 │
└──────────────────────────────┘  SSE   │ MCP: whiteboard_get /           │
                                        │      whiteboard_update ◀────────┼── agent
                                        └─────────────────────────────────┘
```

## Phase 1 — Whiteboard tab + persistence (no agent yet)

**Frontend** (patterns from the Changes tab):

- `center-pane-tab-bar.tsx:6` — extend `CenterTab` union with `"whiteboard"`, add tab button.
- `use-agents-view-routing.ts` — add `useMatch("/agents/:agentId/whiteboard")` + nav branch; helper in `lib/agent-routes.ts`.
- `agents-view.tsx` (~563–595) — mount as a nested `<Route path="whiteboard">` like ChangesTab.
- New `components/app/whiteboard-tab.tsx`, **`React.lazy`-loaded on first visit, then kept mounted + CSS-hidden** (Terminal pattern per G2, not route-mounted like Changes).
- Load scene via React Query (`GET /agents/:id/whiteboard`), save with ~1s debounced `PUT` on `onChange`.
- Theme: pass app dark/light to Excalidraw's `theme` prop.

**Backend**:

- Migration `0029_whiteboards.sql`: `whiteboards(agent_id PK, scene jsonb, version bigint, updated_by text, updated_at)`.
- Routes: `GET`/`PUT /api/v1/agents/:id/whiteboard` (PUT takes `{elements, baseVersion}`; reconciles by element `version`/`versionNonce`, bumps board version).
- New `UiEvent`: `whiteboard.changed {agentId, version, source: "user"|"agent"}` in `ui-events.ts`; client handler in `use-sse.ts` → refetch + `excalidrawAPI.updateScene()` when `source === "agent"`.

## Phase 2 — Agent can see the board (ships with Phase 1 as the MVP PR, per G7)

- Client exports a PNG (`exportToBlob`) on save (heavier debounce, ~5s idle) and POSTs it separately (not inside the JSON PUT — bodyLimit); server writes `whiteboard.png` into the agent's media dir **without a `media` DB row** (G1) → agent vision-`Read`s it, media badge untouched.
- New MCP tool `whiteboard_get` (add to `AGENT_TOOLS` in `shared/mcp/server.ts:82`; new registrar `whiteboard-tools.ts`): returns simplified scene JSON (ids, types, positions, text, arrow endpoints — style noise stripped) + the snapshot file path.

## Phase 3 — Agent can draw

### Product pass (2026-07-07) — what "drawing well" means

Directions artifact (4 options, steal/skip picks): https://claude.ai/code/artifact/a2ffacda-cf55-436c-a16c-a48b1e5b790e
Recommended + building against (veto via artifact): **Signature Ink with the Annotator's manners**.

User stories:

1. _Annotate mine_: I sketch services and ask "which of these talk to Postgres?" —
   the agent draws bound arrows + short labels pointing at MY boxes, near them, never over them.
2. _Draw fresh_: I ask "draw the auth flow of this repo" — the agent lays out a
   boxes-and-arrows diagram in empty board space; I rearrange it and the agent sees my
   corrections on the next `whiteboard_get`.
3. _Critique visually_: I ask for a review of my architecture sketch — the agent circles
   the problem area (dashed ellipse) and leaves a short margin note with a connector arrow,
   instead of a wall of terminal text.
4. _Away from the tab_: the agent draws while I'm on Terminal — the whiteboard tab shows a
   badge; when I click through, the agent's ink is visually distinct so I see what's new.
5. _Iterate_: the agent refines its own diagram (move/relabel/delete by id) without
   duplicating elements — the tool result echoes created ids so it can keep working.

Product decisions (P-series, this session — flagged, cheap to veto):

| #   | Decision                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Soft attribution**: agent strokes default to Excalidraw violet (`#6741d9`) + `customData.author: "agent"` stamped on elements. No hard UI layer; user restyles freely.                                                                                  |
| P2  | **Etiquette in the tool description**: place near, never cover; annotate by pointing (arrow + short label); prefer updating own elements by id over redrawing.                                                                                            |
| P3  | **Tool result echoes the board**: `whiteboard_update` returns created ids + new version (and errors per-op), so the agent iterates without a second `whiteboard_get`. Agent may supply its own readable ids on add (needed for same-call arrow bindings). |
| P4  | **Stale snapshot handled two ways**: `whiteboard_get` marks `snapshotStale: true` when scene `updated_at` > PNG mtime; an open client re-exports the PNG after applying a remote agent scene (closing the loop when a browser is attached).               |

### Build

- MCP tool `whiteboard_update`: ops `add | update | delete` over a **simplified schema**:
  `{type: rect|ellipse|diamond|arrow|line|text|frame, id?, x, y, w, h, label?, from?, to?, color?}`
  (`from`/`to` are element ids → server creates proper arrow bindings).
- Server-side builder expands ops into valid Excalidraw elements (id/seed/versionNonce/boundElements), merges into the scene, bumps versions, publishes `whiteboard.changed(source: agent)` → open clients update live.
- "Agent drew" tab indicator (G5 minimum) — mirror the diff-stats badge in `center-pane-tab-bar.tsx`.
- Round-trip vitest: builder output → `restoreElements` in an E2E to prove Excalidraw accepts it.

## Phase 4 — Conversational loop polish

- "Ask agent" button on the whiteboard: injects a prompt via the existing injector (`agent-prompts.ts:10`, tmux bracketed paste) with a `--- DISPATCH MESSAGE ---` envelope: _"the user updated the whiteboard, see whiteboard_get"_ + optional user note.
- Agent-drawing indicator (small badge on the tab when a `whiteboard.changed(agent)` event arrives while on another tab — mirror the diff-stats badge).
- Tool-usage guidance in the agent system prompt/CLAUDE.md so agents know the whiteboard exists.
- Later / out of scope for now: repo-scoped shared boards, multi-user cursors, mermaid→board import, board history/versions.

## Risks & spikes (do first)

1. **Spike A (Phase 3 risk, ~half day):** hand-generate Excalidraw elements server-side (incl. arrow bindings + text containers) and confirm the editor accepts them cleanly. If fragile, fallback: client-side conversion of queued agent ops using `convertToExcalidrawElements` (requires an open client; ops queue when none attached).
2. **Spike B:** confirm Excalidraw plays well with **React 18.3** (app is not on 19) + Vite 5, measure chunk size, and check whether it fetches fonts/assets from a CDN at runtime (`EXCALIDRAW_ASSET_PATH` + embedded runtime-assets codegen if so).
3. Element-level LWW can drop a concurrent user edit to the _same_ element the agent touched — acceptable for MVP; note in UI ("agent updated the board").

## Blindspot pass (2026-07-07) — confirmed constraints to build against

Full cards: see the "Whiteboard Integration — Blindspots" artifact. Confirmed from code:

- **Body limit**: Fastify default 1 MB, never overridden (`server.ts:149`). PUT whiteboard needs a per-route `bodyLimit` (~10 MB); send PNG separately/multipart.
- **Snapshot ≠ media pipeline** (kills old D4 detail): store PNG outside the media list or the unseen badge pulses on every save.
- **Tab unmount**: whiteboard tab (Changes pattern) fully unmounts on switch — flush debounced save on unmount; persist zoom/scroll in a localStorage `atomFamily` (`store.ts:208` precedent).
- **SSE reconnect**: connection closes on hidden tab; `snapshot` handler (`use-sse.ts:89`) must also invalidate the whiteboard query. Defer `updateScene()` while pointer is down.
- **Tool gating**: add `whiteboard_get`/`whiteboard_update` to each of `AGENT_TOOLS`/`JOB_TOOLS`/`PERSONA_TOOLS` deliberately — absent = invisible per type.
- **PWA precache**: workbox drops files > 4 MiB silently (`vite.config.ts:81`); this is the app's first `React.lazy` chunk — check built size in `finalize:web`.
- **Lifecycle**: agent deletion is soft (`deleted_at`); CASCADE never fires, no retention job — whiteboard rows/PNGs persist past deletion by design (decided, and it strengthens future repo-scoped boards).

## Checks per phase

`pnpm run check` · `pnpm run finalize:web` · `pnpm run test` (builder/reconcile units) · `pnpm run test:e2e` (new spec: open tab, draw rect via pointer events, reload persists; Phase 3: MCP update appears live).
