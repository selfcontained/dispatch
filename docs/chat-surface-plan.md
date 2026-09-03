# Chat surface plan

A native chat-style view of an agent session that sits above the terminal.
The user reads and writes in a **Chat** tab; the terminal stays one click away
as a lower-level **Console**. Feature-flagged; off by default.

This document is the contract between the backend and frontend work. The wire
types live in `packages/shared/src/chat-types.ts` and are authoritative where
the two disagree.

## Decisions already made (do not relitigate)

- **Agent replies come from an MCP tool, never from the CLI transcript.** An
  agent that does not call `dispatch_chat_post` simply has no reply in the feed.
  No transcript scraping, no hooks, no "missed reply" detection.
- **Status events (`dispatch_event`) are display-only.** They render as compact
  feed entries and drive the presence line. Nothing about the chat surface
  depends on agents calling `dispatch_event` correctly.
- **Permission prompts and other terminal-only interactions are out of scope.**
  No detection, no banner.
- **User → agent still goes through pane injection** (`injectAgentPrompt`),
  wrapped in an envelope carrying the message id.
- **Feature flag** `chat_surface_enabled`, following the existing one-module-
  per-flag pattern (`injection-hold-settings.ts` et al.). Toggle lives under
  Settings → Agents. When off, nothing in the app changes.
- **Naming:** center tab is **Chat**. When the flag is on, the terminal tab is
  labelled **Console**. When off, labels are unchanged.
- **Migration number is `0044`** (0043 shipped in v0.37.7).

## Data model

### `agent_chat_messages` (new table, migration `0044_agent-chat-messages.sql`)

| column      | type        | notes                                                                            |
| ----------- | ----------- | -------------------------------------------------------------------------------- |
| id          | uuid pk     |                                                                                  |
| agent_id    | text        | FK-ish to agents.id (no constraint, matches agent_events)                        |
| author_kind | text        | `agent` \| `user`                                                                |
| kind        | text        | `reply` \| `update` \| `question` \| `summary`; user messages are always `reply` |
| text        | text        | markdown body, ≤ 20 000 chars                                                    |
| reply_to    | uuid null   | id of the message being answered                                                 |
| question    | jsonb null  | `ChatQuestion` — only when kind = question                                       |
| answer      | jsonb null  | `ChatAnswer` — set when the user answers a question                              |
| attachments | jsonb       | `ChatAttachment[]`, default `[]`                                                 |
| delivered   | boolean     | user messages only: pane injection succeeded                                     |
| read_at     | timestamptz | agent messages only: when the user saw it                                        |
| created_at  | timestamptz |                                                                                  |
| updated_at  | timestamptz | bumped by `dispatch_chat_update`                                                 |

Indexes: `(agent_id, created_at DESC)`; partial `(agent_id) WHERE author_kind = 'agent' AND read_at IS NULL`.

### Feed composition

The feed is composed **at read time** on the server. Nothing else is
dual-written. Sources, all scoped to one agent, merged by timestamp ascending:

| entry type      | source                              | notes                                  |
| --------------- | ----------------------------------- | -------------------------------------- |
| `chat`          | `agent_chat_messages`               | agent and user messages                |
| `status`        | `agent_events`                      | one entry per event row                |
| `agent_message` | `agent_messages` (either direction) | cross-agent messages, sender/recipient |
| `media`         | `media`                             | files shared via `dispatch_share_file` |

Pins are **not** in the feed for v1 (no per-pin timestamp history). Notifications
are not persisted and are not in the feed.

## Server API

All routes are agent-scoped and require the flag only for the UI; the routes
and tools themselves work regardless of the flag so the toggle is purely a UI
switch and a launch-guidance switch.

```
GET  /api/v1/agents/:id/chat?before=<iso>&limit=<n>
     → { entries: ChatFeedEntry[], hasMore: boolean, unreadCount: number }
     Default limit 200, max 500. `before` pages backwards.

POST /api/v1/agents/:id/chat/messages
     body { text: string }
     → { message: ChatMessage, delivered: boolean, held: boolean }
     Persists a user message, then injects it (see envelope). 409 when the
     agent has no deliverable terminal (same rule as inject-text).

POST /api/v1/agents/:id/chat/messages/:messageId/answer
     body { value: string, label?: string }
     → { question: ChatMessage, reply: ChatMessage, delivered: boolean }
     Records `answer` on the question message, persists a user message whose
     text is the chosen label (or value), injects it with replyTo = question id.
     409 if already answered.

POST /api/v1/agents/:id/chat/read
     body { upTo?: string (message id) }
     → { unreadCount: number }
     Marks agent messages read.

GET  /api/v1/app/settings/chat-surface   → { enabled }
POST /api/v1/app/settings/chat-surface   body { enabled }
```

SSE: new member `{ type: "chat.changed"; agentId: string }` published on any
write to `agent_chat_messages`. The web also invalidates the feed on
`agent.upsert` (status), `message.created`, and `media.changed`.

### Injection envelope (user → agent)

```
--- DISPATCH CHAT (id: <uuid>) ---
<text>
--- END DISPATCH CHAT ---
The user is reading the Chat tab, not this terminal — they only see what you post with dispatch_chat_post. Reply there (replyTo: "<uuid>"); terminal output alone will not reach them.
```

Answers to a question use the same envelope with the chosen label as text.
The id in the envelope is the user's reply message (which itself carries
`replyTo` = the question id), so the agent answers the reply like any other
user message.

## MCP tools

Registered for every agent (no flag check). The tool descriptions carry the
schema so the launch-guidance rule can stay short.

### `dispatch_chat_post`

```
text          string   required, markdown, ≤ 20 000 chars
kind          "reply" | "update" | "question" | "summary"   default "reply"
replyTo       string   optional message id being answered
question      { options: { label: string; value?: string }[]; allowFreeform?: boolean }
              required when kind = "question", rejected otherwise
attachments   ChatAttachment[]   optional, ≤ 20
→ { id, createdAt }
```

`ChatAttachment` is a discriminated union:

```
{ type: "file";  path: string }                 an absolute path already shared via dispatch_share_file;
                                                the server resolves it to the media row and returns 400 if unknown
{ type: "link";  url: string; title?: string }
{ type: "pr";    url: string; title?: string }
{ type: "code";  code: string; language?: string; path?: string }
{ type: "pin";   pinId: string }                the server verifies the pin exists on this agent
```

### `dispatch_chat_update`

```
messageId     string   required, must be an agent message on this agent
text          string   optional
kind          optional
question      optional
attachments   optional (replaces)
→ { id, updatedAt }
```

### Launch guidance rule

Added to `buildLaunchGuidance` only when the flag is on, in both trimmed and
full variants (same text):

> The user reads the Chat tab, not the terminal. Post your reply with
> dispatch_chat_post whenever you finish a turn or have something to tell them,
> and ask questions through it (kind: question, with options when the choice is
> finite) instead of asking in the terminal.

Keep it to that one rule. The tool description carries the schema.

## Web

### Tab and routing

- `CenterTab` gains `"chat"`. Route `/agents/:id/chat`; helper `agentChatRoute`.
  Touch `lib/store.ts`, `lib/agent-routes.ts`, `hooks/use-agents-view-routing.ts`,
  `center-pane-tab-bar.tsx`, and the split-pane rendering.
- Flag on: tab order is Chat, Console, Changes, Whiteboard; Chat is the default
  tab for an agent with no persisted tab choice. Flag off: the Chat tab is not
  offered and the terminal label stays "Terminal"; a persisted `"chat"` tab
  falls back to `"terminal"`.

### Chat pane

- **Feed** (scrollable, newest at bottom, auto-follow unless the user has
  scrolled up; "Load older" at the top when `hasMore`).
  - User message: right-aligned bubble. Shows a "held" hint while the injection
    hold state says it is waiting, and a delivery-failed marker when
    `delivered` is false.
  - Agent message: left-aligned bubble, body rendered with the existing
    `@/components/ui/markdown` `Markdown` component. `kind` drives styling:
    `summary` renders as a card with a heading; `update` is visually lighter;
    `question` gets the "needs your reply" accent until answered.
  - Question options render as buttons under the bubble. Clicking posts to the
    answer route. After answering, the options are disabled and the chosen one
    is marked. `allowFreeform` shows a hint that the composer also works.
  - Attachments: `file` → thumbnail for images, name+size otherwise, opening the
    existing media lightbox; `link`/`pr` → link chip; `code` → code block with
    optional path caption; `pin` → the existing pin row rendering.
  - `status` entries: compact, centered, muted single line with the event
    colour dot from `agent-event-utils.ts`. Consecutive `working` entries from
    the same agent collapse into one line showing the latest.
  - `agent_message` entries: bubble with the other agent's name as sender,
    reusing `MessageBubble` from `messages-panel.tsx` where practical.
  - `media` entries: attachment card; reuse the media thumbnail and lightbox.
- **Presence line** above the composer: the agent's latest event type and
  message (e.g. "Working · Running tests"), same colour scheme as the agent
  card. This replaces spamming the feed with every working event.
- **Composer**: textarea, Enter sends, Shift+Enter inserts a newline. Disabled
  with an explanation when the terminal is inert. Optimistic append of the user
  message, reconciled on the next fetch.
- **Console link**: a small "Open Console" affordance in the pane header that
  switches to the terminal tab.
- **Unread**: mark read when the Chat tab is visible and the window is focused.
  Show an unread count on the Chat tab label when it is not the active tab.
- **Settings**: toggle "Chat surface (beta)" under Settings → Agents using
  `useOptimisticToggleSetting` with endpoint `/api/v1/app/settings/chat-surface`.
- Mobile: the Chat tab must work in the mobile layout. The fullscreen textarea
  toolbar is unchanged.

State ownership: feed and unread are React Query. Follow/scroll state is local
to the pane. The active tab already lives in the URL and split-pane atom.

## Testing expectations

- Backend: vitest coverage for the store (insert/list/paging/read), the feed
  composer (ordering, mixing sources), both routes' validation and 409 paths,
  the answer flow, the tool handlers' zod validation (question required for
  kind=question, attachment resolution), and the guidance rule toggle.
- Web: component tests for the feed renderer (each entry type, question
  answered/unanswered) and the composer key handling. One Playwright flow with
  the flag on: enable the setting, open an agent, see the Chat tab, seed
  messages through the API, verify rendering, take a screenshot.

## Out of scope for v1

Pins in the feed, notification entries, threading UI beyond `replyTo`,
reactions, search, cross-agent posting through the chat tool, replacing the
mobile fullscreen textarea, transcript reading, hooks, permission-prompt
detection.
