# Design: Agent Messages — persistence, sidebar tab, and History

**Date:** 2026-06-30
**Status:** Approved (design phase)

## Problem

Agents can already message each other with the `dispatch_send_message` MCP tool, but
those messages are **ephemeral**: the send handler injects the message text straight
into the target agent's tmux session and keeps no record. There is no database row, no
SSE broadcast, and no UI. Unlike pins and brain artifacts — which persist and are surfaced
in the sidebar and History — messages leave no trace to view.

We want agent-to-agent messages to be viewable with a UX similar to pins/brain artifacts:
a dedicated **Messages** tab in the agent sidebar, and a **Messages** view in the History
section.

## Scope decisions (confirmed with the user)

1. **Persist + view only.** Build persistence, broadcast, and the two read surfaces. Keep
   the existing same-repo-only send rule. Design the schema so cross-repo becomes a later
   config flip rather than a migration — but do **not** unblock cross-repo sending now.
2. **Sidebar tab is per selected agent** and shows *that agent's* conversations (messages it
   sent or received), grouped by the other participant.
3. **History placement is a new tab in the per-agent detail view**, alongside
   Events / Media / Pins / Feedback.
4. **View-only from the UI.** Humans do not compose or reply to messages from the UI in this
   feature; agents continue to send via the MCP tool.

### Explicitly out of scope (YAGNI)

- Unblocking cross-repo *send* (schema is prepared for it; the send rule is unchanged).
- Composing / replying to messages from the UI.
- Message search / filtering within the sidebar tab.

## Current-state facts (from codebase exploration)

- **MCP tool:** `dispatch_send_message` — defined in
  `apps/server/src/shared/mcp/messaging-tools.ts` (registration) and handled by the
  `sendMessage` handler in `apps/server/src/server/mcp-handlers.ts` (~lines 847–947).
  It resolves the target (agent id `agt_*` or fuzzy name match), enforces
  same-repo-only via `senderRepoRoot` filtering, blocks self-send and non-running
  targets, then injects a delimited envelope through `sendAgentPrompt` →
  `injectAgentPrompt` (`apps/server/src/server/agent-prompts.ts`), which uses tmux
  `sendCommand`.
- **No persistence today.** No message table exists. `agent_events`
  (`apps/server/src/db/migrations/0001_baseline.sql`) logs state transitions only.
- **SSE:** `GET /api/v1/events` (`apps/server/src/routes/agents/events-routes.ts`)
  broadcasts UI events (`agent.upsert`, `feedback.created`, `brain.changed`, …) via the
  `publishUiEvent` broker. There is no message event type.
- **Sidebar tabs:** `apps/web/src/components/app/media-sidebar.tsx` renders the
  Pins / Media / Brain tab bar and panels. Panels stay mounted and toggle via a `hidden`
  class. Active tab is a per-agent Jotai atom family persisted to localStorage
  (`MediaSidebarTab` union in `apps/web/src/lib/store.ts`;
  `use-media-sidebar-state.ts`). Media shows an unseen-count badge.
- **History:** route `/activity/history[/:agentId]`. List in
  `apps/web/src/components/app/agent-history-tab.tsx`; detail in
  `agent-history-detail.tsx` with a `DetailTabs` component (Events / Media / Pins /
  Feedback, each with a count badge). Backed by `GET /api/v1/history/agents/:id`
  (`apps/server/src/routes/activity.ts`), which runs parallel queries for events, token
  usage, media, and feedback. Hooks in `apps/web/src/hooks/use-agent-history.ts`.

## Architecture

Messages become first-class **persisted artifacts**, mirroring pins/brain/feedback. Three
layers, all additive — the existing ephemeral tmux delivery is unchanged:

1. **Persistence** — a new `agent_messages` table. The `sendMessage` handler writes a row
   right after attempting tmux injection (injection-first, so a DB error never blocks
   delivery — see Error handling).
2. **Broadcast** — a new `message.created` SSE UI event, published through the same broker
   as existing events, so live UIs update without polling.
3. **Surfacing** — a `Messages` sidebar tab (per selected agent) and a `Messages` tab in the
   History detail view. Both read from the same API + query hooks.

## Data model — `agent_messages` (new migration)

New migration file under `apps/server/src/db/migrations/` following the existing numbering.

| column | type | notes |
|---|---|---|
| `id` | uuid / text PK | consistent with existing tables |
| `sender_agent_id` | text FK → `agents.id` | |
| `recipient_agent_id` | text FK → `agents.id` | |
| `sender_name` | text | denormalized snapshot — names change, agents get archived |
| `recipient_name` | text | denormalized snapshot |
| `content` | text | message body |
| `delivered` | boolean | whether tmux injection succeeded |
| `read_at` | timestamptz null | powers unread badges; null = unread |
| `sender_repo_root` | text | stored now even though equal to recipient's today — the "cross-repo later is a config flip, not a migration" hook |
| `recipient_repo_root` | text | as above |
| `created_at` | timestamptz | default now |

Indexes: `sender_agent_id`, `recipient_agent_id`, `created_at`.

Rationale for a dedicated table (vs. reusing `agent_events`): messages have distinct
semantics (two participants, read state, delivery state) and distinct read patterns
(grouped by conversation). Denormalizing names + repo roots keeps History correct after
either agent is deleted.

## Write path (server)

In the `sendMessage` handler (`apps/server/src/server/mcp-handlers.ts`), after the target is
resolved and tmux injection is attempted:

1. Insert one `agent_messages` row, capturing `delivered` from the injection result and the
   resolved sender/recipient names and repo roots.
2. Publish a `message.created` UI event via the existing broker.

Failed deliveries are still recorded (rendered as "not delivered"), so a message sent to a
stopped agent is not silently lost. The same-repo filter and all existing validation remain
in place ahead of this write.

## Sidebar tab (per selected agent)

- Add `"messages"` to the `MediaSidebarTab` union (`apps/web/src/lib/store.ts`).
- Add a fourth button to the tab bar in `media-sidebar.tsx`, with an **unread badge** reusing
  the Media tab's badge pattern (count of messages with `read_at IS NULL` for the selected
  agent).
- New `MessagesPanel` component: the selected agent's sent + received messages **grouped by
  the other participant** into collapsible conversation threads (mirrors Brain's
  Objects / Lists / Events sectioning). Each row shows direction (→ sent / ← received), the
  other agent's name, content, and relative time.
- New hook `useAgentMessages(agentId)` → `GET /api/v1/agents/:id/messages`, query key
  `["messages", agentId]`, invalidated on the `message.created` SSE event (wired in
  `apps/web/src/hooks/use-sse.ts`).
- Panel stays mounted via the `hidden` class, like the other panels.
- Opening the tab marks the agent's visible messages read (clears the badge), consistent
  with Media's "seen" behavior. This calls a small `POST`/`PATCH` mark-read endpoint that
  sets `read_at`.

### New server route

`GET /api/v1/agents/:id/messages` (under `apps/server/src/routes/`, alongside the media
route) — returns messages where the agent is sender or recipient, ordered by `created_at`.
Plus a mark-read endpoint to set `read_at` for the agent's received messages.

## History detail tab

- Extend `DetailTab` to include `"messages"` in `agent-history-detail.tsx`; add a `Messages`
  tab with a count badge next to Events / Media / Pins / Feedback.
- Extend `GET /api/v1/history/agents/:id` (`apps/server/src/routes/activity.ts`) to include a
  `messages` array via a new parallel query — no new endpoint.
- Extend the `HistoryAgentDetail` type + `useHistoryAgentDetail` hook
  (`apps/web/src/hooks/use-agent-history.ts`) to carry `messages`.
- New `MessageTimeline` component modeled on the existing `FeedbackTimeline` /
  `EventTimeline` (`agent-history-timeline.tsx`), rendering messages chronologically with
  sender → recipient labels and delivery state.

## Data flow summary

```
agent A calls dispatch_send_message
   -> sendMessage handler (same-repo filter, target resolution, self/running checks)
   -> tmux injection (unchanged)  ------------------> agent B's session
   -> INSERT agent_messages row (delivered=?)
   -> publishUiEvent("message.created")
        -> SSE /api/v1/events
             -> web: invalidate ["messages", agentId] and history detail query
                  -> MessagesPanel (sidebar) + MessageTimeline (history) re-render
```

## Error handling

- Tmux injection failure: still insert the row with `delivered = false`; the UI shows a
  "not delivered" affordance. The MCP tool response keeps its existing `delivered` field.
- DB insert failure must not break message delivery to the agent — injection happens first;
  a persistence error is logged and surfaced in the tool result but does not throw past
  delivery. (Confirm ordering during implementation so a running agent still receives the
  message even if the write fails.)
- Deleted/archived participants: History and sidebar render from denormalized names, so rows
  remain readable.

## Testing

- **Unit (vitest):**
  - `sendMessage` writes an `agent_messages` row and emits `message.created`.
  - `delivered` reflects injection success vs. failure (target stopped → row with
    `delivered = false`).
  - Same-repo filter still enforced (cross-repo target rejected as today).
  - `GET /api/v1/agents/:id/messages` returns sent + received, correct ordering.
  - History detail query includes messages.
  - Mark-read sets `read_at` only for the agent's received messages.
- **E2E (Playwright):**
  - Launch two agents in one repo, send a message between them.
  - Assert it appears in the sidebar Messages tab with an unread badge, and the badge clears
    on open.
  - Assert it appears in the History detail Messages tab.
  - Screenshot published via `dispatch_share`.

## Pre-completion checks

`pnpm run check`; `pnpm run finalize:web` (web changed); `pnpm run test:e2e`;
`pnpm run test` (backend logic changed).
