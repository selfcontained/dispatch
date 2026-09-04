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
- **Migration number is `0045`** (0044 is surfaces v2, shipped in v0.37.10).

## Data model

### `agent_chat_messages` (new table, migration `0045_agent-chat-messages.sql`)

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
Reply with dispatch_chat_post (replyTo: "<uuid>").
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

## Follow-ups (round 2, one PR)

Decided 2026-09-03 after #1042 merged. Surfaces v2 integration is deferred
until v2 matures. Everything below ships in one PR, feature-flag unchanged.

### A. User-side attachments in the composer

Wire contract (`packages/shared/src/chat-types.ts`):

```
ChatUserAttachmentInput =
  | { type: "file"; mediaId: number }        // uploaded first via POST /agents/:id/media
  | { type: "pin";  pinId: string }          // accepted by the server; the web composer never sends one
  | { type: "link"; url: string; title?: string }

POST /api/v1/agents/:id/chat/messages
  body { text: string; attachments?: ChatUserAttachmentInput[] }   // ≤ 20 attachments
  → ChatSendResponse (unchanged)
```

- User attachments are **files and links only**. The composer has no pin
  picker (dropped 2026-09-04: "I don't need to include already pinned things
  in a message"). Agents can still attach pins via `dispatch_chat_post`, and
  the feed renders those; the server's schema keeps accepting a user-side
  `pin` for compatibility, but nothing in the web app sends one.
- The stored user message carries `ChatAttachment[]` in the same shape agent
  posts use (`file` resolved from the media row, `pin` verified on the agent,
  `link` as given). The feed renderer is unchanged.
- `text` may be empty when at least one attachment is present.
- Upload path: the web uploads each file with `uploadAgentMedia(agentId, file,
{ source: "user", inject: false })`, then sends the message with the returned
  media ids. Server-wide 20 MB cap and `isMediaFile` gate apply.
- Envelope: after the text and before the closing marker, list attachments so
  the agent can act on them:

```
--- DISPATCH CHAT (id: <uuid>) ---
<text>

Attachments:
- file: /abs/path/to/media/<fileName> (image/png, 120 KB)
- pin: <label> — <value>
- link: <url>
--- END DISPATCH CHAT ---
<existing trailer>
```

- Composer UX (mirror the create-agent context input): paperclip button →
  file picker (accept from `STARTUP_FILE_ACCEPT`); drag-and-drop onto the
  composer; paste handling: clipboard
  files → file attachments, a pasted URL alone → link attachment, pasted text
  longer than 4 000 characters or 80 lines → offered as a `pasted.txt` file
  attachment (chip with "keep inline" undo). Attachment chips above the
  textarea with remove buttons; image chips show a thumbnail. Send stays
  disabled while uploads are in flight; upload failures keep the draft.

### B. Shared injector enqueue API

- `createPromptInjector` gains `enqueueAgentPrompt(agentId, prompt, { gate? })
→ { held: boolean; delivery: Promise<void> }` which throws on a non-tmux
  agent; `injectAgentPrompt` becomes a wrapper over it.
- The chat `ChatDeliveryAdapter` in `server.ts` is built from `enqueueAgentPrompt`
  (no more inline `new TmuxTerminal`).
- `dispatch_send_message` (`server/mcp-handlers.ts handleSendMessage`) uses it
  too and records real delivery: migration `0046_agent-messages-delivered-null.sql`
  drops NOT NULL/DEFAULT on `agent_messages.delivered`; rows insert with `null`
  (pending), settle to true/false when the write completes, and republish
  `message.created` for the pair so clients refetch. The startup recovery sweep
  marks stale `null` agent_messages false, like chat. `StoredMessage.delivered`
  and the web `AgentMessage.delivered` become `boolean | null`; the messages
  panel and the chat feed render null as "Sending".

### C. Presence strip

Replaces the static presence line above the composer. Only observed signals,
no pane-text parsing.

- **Server:** ephemeral SSE member `{ type: "agent.tool_invoked"; agentId; tool:
string; at: string }`, published from one wrapper around `registerTool` in
  `createDispatchMcpServer` (covers dynamic repo tools too). `McpRequestContext`
  gains `publishUiEvent` threaded from `routes/mcp.ts`. Not persisted, not
  fetched. Skip `dispatch_event` itself (it already drives the phase).
- **Web:** `terminalOutputActivityAtomFamily(agentId)` in `lib/store.ts`
  (`{ lastOutputAt: number; bytesPerSecond: number }`), written from the
  terminal socket `onOutput` path in `use-terminal.ts` (throttled to ≤ 4
  writes/s), readable while the pane is mounted but hidden under Chat.
- **Strip states:** working + output in the last 3 s → animated dots + phase
  text (`latestEvent.message`); working + no output for ≥ 60 s → "quiet for
  Nm" in the muted tone; `waiting_user`/`blocked` → their existing colours and
  message; not running → existing status text. A tool blip ("sharing a file",
  "pinning", "posting to chat", "launching an agent", "saving notes", default:
  humanised tool name) overlays for 4 s after `agent.tool_invoked`.
- Tool descriptions for `dispatch_chat_post`/`dispatch_chat_update` mention
  that an `update` post edited in place is the durable form of progress.

### D. Small refactors (only if they stay small)

- `CENTER_TABS` registry (`{ id, label(flagOn), route, available(flagOn) }`)
  replacing the per-file `CenterTab` switches and the `chatEnabled` prop drill.
- `useServerFlag(endpoint, hintAtom)` extracted from `use-chat-surface-enabled.ts`
  and reused by it.

## Round 3 (web only): the Agent pane

Decided 2026-09-03 after Brad reviewed round 2. No server or shared-type
changes; the flag, routes and tools are unchanged.

### One "Agent" tab with a Chat | Console toggle

- Flag on, the center tabs are **Agent · Changes · Whiteboard**. The Agent
  tab (`CenterTab` id `"agent"`, `lib/center-tabs.ts`) hosts both the Chat
  feed and the Console (the terminal); a segmented **Chat | Console** toggle
  (shadcn `ToggleGroup`, `AgentViewToggle` in `agent-pane.tsx`) in the pane
  header flips between them. Flag off, the tab is still **Terminal** (id
  `"terminal"`) with no toggle; nothing else changes.
- The view is a per-agent preference, not a place: `agentPaneViewAtomFamily`
  in `lib/store.ts` (localStorage, default Chat), never in the URL.
  `/agents/:id` is the Agent tab. `/agents/:id/chat` survives only as a
  redirect to `/agents/:id` that sets the view to Chat (old links; flag off
  it still falls back to the terminal). The no-console-flash guarantee
  stands: `centerTabResolved` holds the pane until the flag is known and any
  redirect has landed, and the terminal is only armed after that.
- Both views stay mounted. The terminal is the same portaled pane as before,
  hidden with CSS under Chat; the Chat pane (and its composer) stays mounted
  under the Console, so flipping is instant and nothing typed is lost.
  `AgentPane` always renders the terminal slot at the same tree position,
  flag on or off, so the reparented terminal DOM is never stranded.
- Unread: the badge sits on the **Agent** tab label while another tab is
  active, and on the **Chat** segment of the toggle while the Console is up.
- Split panes: `"agent"` replaces `"chat"`/`"terminal"` as a pane choice.
  `normalizeSplitPaneState` folds persisted `chat`/`terminal` values into
  `agent` with the flag on (and `agent`/`chat` into `terminal` with it off);
  a split that collapses onto the same pane twice shows as a single pane.
  The split pane's header carries the toggle.
- Mobile: the terminal toolbar shows only while the Agent pane is in Console
  view (flag on); flag off it shows on every tab as before.

### Peer posts and arrivals

- A post from another agent (`agent_message`, direction `in`) shows that
  agent's own type icon and, after its name, a relation chip computed on the
  client from the sidebar's agent list: **child agent** when this agent
  launched it, **parent** when it launched this agent, **sibling** when both
  share a parent, otherwise **agent** — also the fallback when the sender is
  no longer in the list (generic bot icon). `agentRelation` in
  `lib/agent-lineage.ts`; the same chip sits on the Messages panel's thread
  headers so the two agree. The muted side-conversation treatment and the outgoing "to <name>"
  line stay.
- Entries that arrive after the feed first rendered — new posts, status
  lines, media, and posts edited in place — fade in (200 ms opacity with a
  3 px rise, `animate-chat-enter`); the initial page and anything paged in
  with "Load older" never do. `prefers-reduced-motion` drops the animation
  entirely. The row animates, not the scroll, so auto-follow is unaffected.
- The Chat | Console segments grow to 44 px on coarse pointers, and the
  Agent-pane / split headers grow with them; split headers keep their
  divider-side padding wider than the unsplit button's overhang so it never
  covers the toggle.

### Composer draft persistence

- `chatDraftAtomFamily(agentId)` (`lib/store.ts`, shape in
  `lib/chat-draft.ts`) keeps the unsent draft per agent in localStorage:
  text, link chips, and file chips. Restored on mount; what was sent is
  cleared on a successful send; a failed send keeps everything. Drafts
  written before the pin picker was dropped may still carry a `pinIds`
  list; it is tolerated and ignored, never restored or written back.
- Files cannot survive a reload (they upload at send time), so only their
  name/size/type is kept and they come back as a disabled "needs
  re-attaching" placeholder chip with a remove button. The send is held
  until placeholders are re-attached or removed. Pasted-text chips keep
  their text and come back whole.
- Size cap: 64 KB per agent (`CHAT_DRAFT_MAX_BYTES`). The atom holds the
  full draft; what it writes to storage is `fitChatDraft`'s lossy snapshot,
  bounded for any input: pasted-text bodies go first, largest-first (such a
  chip comes back as a "too large to keep — paste again" placeholder), then
  links longest-first, then the text is cut at a code-point boundary with a
  visible marker on the end. A write that storage refuses (quota) keeps the
  in-memory draft and is simply not persisted.
- Cross-tab: the draft follows `storage` events like any other persisted
  atom, files included — descriptors are reconciled into the tab's live
  chips (a file this tab holds stays live, one it lacks is a placeholder, a
  pasted body comes back whole). Re-attaching a placeholder's file replaces
  the placeholder.
- Within a session a Chat → Console → Chat flip keeps live files too, since
  the composer stays mounted.

## Round 4: launch context in the feed

Decided 2026-09-03. Brad's ask: when someone launches an agent with context
(an initial message, startup files, links, pins), show it in the Chat right
when the agent starts — otherwise it is only visible in the Console.

- **One post per launch with user-visible context.** `AgentManager.createAgent` records the context
  through a `LaunchContextRecorder` attached post-construction
  (`ChatService.recordLaunchContext`), after the agent row and its media
  rows exist and alongside the runtime launch, so every launch path (create
  dialog, `dispatch_launch_agent`, templates, jobs) gets it. The write is
  best-effort: it never blocks the runtime launch, and `createAgent` waits
  for it at most 5s before returning (a late write still lands). The post is a user
  message, kind `reply`, `delivered: true` (the prompt reaches the CLI by the
  normal launch path; nothing is injected), text = the explicitly supplied
  user-authored launch context (never generated/internal startup guidance), and
  attachments = a `file` per startup media row (resolved by `mediaId`), a
  `link` per startup link, and a `pin` per initial pin — except a url pin
  the route made from one of the links, so the URL is not shown twice. A
  launch with none of these records nothing. Terminal agents never do. A
  recorder failure is logged and never fails the launch. `chat.changed` is
  published like any write.
- **Contract.** Migration `0047_agent-chat-messages-origin.sql` adds
  `origin text CHECK (origin IN ('launch'))` and `launched_by_agent_id text`,
  both nullable. `ChatMessage` gains `origin?: "launch"` and
  `launchedByAgentId?: string`; both are absent (not null) on every other
  message, and the store only emits the keys when set.
- **Agent-launched agents.** When another agent launched this one,
  `launched_by_agent_id` is the launcher — only the explicit
  `CreateAgentInput.launchedByAgentId` the agent-authenticated launch paths
  (`dispatch_launch_agent`, persona launches) set, never a body-supplied
  `parentAgentId`, so a create-route caller cannot make the post read as
  another agent's. The post stays `authorKind:
"user"` so unread and pending-question counts are unaffected; the web
  renders the author from `launchedByAgentId`. The MCP launch path wraps the
  prompt in a "You were launched by…" header for the CLI; the post keeps the
  prompt as the launcher wrote it (`CreateAgentInput.launchContext.prompt`).
- **Web.** A user post with `origin: "launch"` shows a small muted
  "Launch context" label (rocket icon) above the body; attachments render as
  usual, and no delivery marker is shown. With `launchedByAgentId` the post
  is attributed to that agent: its name from the agents list, its type icon
  as avatar, and the relation chip (parent / sibling / agent), falling back
  to "Agent" with the generic icon when the launcher is gone. `PeerInfo` now
  carries the peer's `name`. Feed grouping treats the post like any other
  from that author (`chatMessageAuthor` in `chat-entries.tsx` is the one
  place that decides who a chat message reads as).

## Round 5: the launch prompt as a Chat message

Decided 2026-09-03. Brad's ask: a session started with an initial prompt
should arrive in the CLI the same way a Chat message does, so an agent
launched from the Chat tab knows to answer there.

- **The first turn is the envelope.** With the flag on and a launch post
  recorded, the CLI's first user turn is `buildChatEnvelope(postId, prompt,
attachmentLines)` — the `--- DISPATCH CHAT (id: …) ---` block, the
  `Attachments:` lines for the startup files (absolute media path, mime,
  size), links and pins, and the trailer telling the agent the user reads
  the Chat tab and to reply with `dispatch_chat_post` (`replyTo` the launch
  post). The reply therefore threads onto the launch post. Composed by
  `buildStartupTurn` (`agents/tmux/command-builder.ts`) and delivered
  through each CLI's existing first-turn channel: a positional arg for
  Claude and Codex, `--prompt` for opencode, the trailing prompt for cursor.
- **Unwrapped otherwise.** Flag off, no launch context, a job run (its
  prompt is a system-prompt append), or a terminal agent: the plain
  `buildStartupPrompt` as before, with its pins and attached-files sections.
- **One id, one set of attachment lines.** `createAgent` mints the post id
  before the command is built and hands it to
  `ChatService.prepareLaunchContext`, which resolves the attachments and
  returns both the envelope lines it will store and a `record()` that writes
  the row (`ChatStore.insert` now accepts an explicit id). The recorder and
  the pane therefore describe the same attachments, and the id in the
  envelope is the id of the post in the feed. `recordLaunchContext` is kept
  as `prepare` + `record` for callers that do not need the id up front.
- **A written row is the precondition for the envelope.** The envelope names
  a message id, so the message has to exist first: on the wrapped path
  `createAgent` awaits both the resolve (bounded by
  `LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS`) and the write (bounded by
  `LAUNCH_CONTEXT_WRITE_TIMEOUT_MS`) before the CLI command is built.
  Anything short of a durable insert — a rejection, either timeout, or an id
  already taken (`ChatStore.insertIfAbsent` is `ON CONFLICT DO NOTHING`, and
  a non-insert rejects) — drops the envelope, and the agent launches with the
  plain startup prompt and no post. That pair can never disagree; an envelope
  naming a row that was never written would point every reply at nothing.
- **Only a wrapped launch pays for the post.** The chat-surface and
  trimmed-guidance flags are read once in `createAgent`, before any Chat
  work, and handed down to the command builder. A launch that will not carry
  an envelope — flag off, a job run, a terminal agent, an inert runtime —
  keeps the round-4 shape: resolve and write both run alongside the runtime
  start and are waited on (bounded) only after it, so a slow or hung recorder
  cannot delay a launch that was never going to name the post anyway.
- **Agent-launched agents.** `dispatch_launch_agent` wraps the launcher's
  prompt in a "You were launched by…" header for the CLI; the envelope wraps
  that whole thing, header included, while the feed post keeps the prompt as
  the launcher wrote it.

### The envelope is a frame around text Dispatch does not control

`buildChatEnvelope` is the one place any text is wrapped — the composer path
and the launch path both go through it — and it escapes its own markers
before wrapping. Every line of the body that matches the marker grammar
(`---` or longer, optional `END`, `DISPATCH CHAT`, leading whitespace
allowed) is prefixed with `> `. Without that, a prompt or an attachment could
carry `--- END DISPATCH CHAT ---` followed by a forged
`--- DISPATCH CHAT (id: …) ---` and make the agent thread its replies onto a
message id of the author's choosing — newly reachable through
`dispatch_launch_agent`, whose launcher knows real message ids. `> ` was
chosen over a look-alike code point so the line stays readable, survives
copy/paste, and needs nothing zero-width. The second half of that fix is on
the write side: `ChatService.post` rejects a `replyTo` that is not an
existing message on the posting agent's own feed, so a syntactically valid
UUID from another feed is a 400 rather than a silent cross-feed thread.

### The post may show less than the turn, and says so

`prepareLaunchContext` normalizes the post's text once, so the row and the
first turn cannot quietly diverge. Two caps apply to the row and to neither
the CLI turn nor the launch itself:

- A prompt longer than `CHAT_MESSAGE_MAX_CHARS` (20 000) is trimmed for the
  row and gets an explicit "truncated for Chat" line;
  `dispatch_launch_agent` accepts five times that, and the CLI's first turn
  still carries all of it.
- More than `CHAT_ATTACHMENTS_MAX` (20) startup files, links and pins are
  resolved and described in full for the turn, stored capped on the row, and
  the row gets a line naming how many it left off. A launch may legitimately
  seed 10 files and 50 pins, and before round 5 `buildStartupPrompt`
  delivered all of them — the envelope must not lose that context.

### Terminal sessions never offer Chat (web)

A terminal-type session is a shell with no CLI to chat with, so the chat
surface does not apply to it however the flag is set: `agentSupportsChat`
(`lib/center-tabs.ts`) is ANDed with the flag once, in `agents-view.tsx`,
and the narrowed value is what the tab bar, the Agent pane, the split-pane
normaliser and the center-pane layout receive. The tab is labelled
**Terminal**, the pane is Console-only with no Chat | Console toggle, the
remembered view is ignored, no unread badge is shown, a persisted `chat` or
`agent` split value folds onto the Console, `/agents/:id/chat` redirects to
the bare route without touching the view, and the mobile terminal toolbar
shows as it always did.
