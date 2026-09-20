# Streams and blocks

Every agent's product is a stream of blocks. Chat renders it; the sidebar,
notifications and the Activity page derive from it. This is the contract the
`acp-runtime` branch builds against, replacing the Chat tab's message table,
cross-agent messages, media posts, pins, surfaces, whiteboards and reviews
one step at a time. It is not a description of what `main` does today.

## Goals

- One verb. An agent talks to the user, to another agent, and to the record
  the same way: it **posts a block into a stream**. There is no second
  channel for peers, no third for reviews.
- One stream per root agent. Children post into their parent's stream, so
  everything related to a piece of work reads in one place; threads keep the
  agent-to-agent traffic out of the main column.
- Blocks are typed and stateful. New feature = new block kind, not a new
  table, tool family or sidebar.
- Status is derived. Working is an open turn; Waiting is an open input block
  addressed to the user; Idle is neither; Blocked is a failed turn, an engine
  exit or a failed setup. Nothing is reported by the agent.
- Hard cutover. Each step deletes the tools, tables, routes and guidance it
  replaces. No aliases, no compatibility reads.

## Model

```
stream  = the root agent's id. A child has no stream of its own; its page is
          the parent's stream filtered to it.
block   = one post in a stream: who wrote it, whom it is for, what kind, its
          text and typed data, its mutable state, its thread.
thread  = the blocks that reply to one top-level block. Collapsed in the
          stream to "3 replies", opened as a page in the right drawer.
turn    = an agent's unit of work (prompt → steps → answer), rendered from
          `agent_stream_events` as before. Turns are not blocks; a stream
          interleaves both by time.
```

### `blocks`

| column            | type        | meaning                                                                   |
| ----------------- | ----------- | ------------------------------------------------------------------------- |
| `id`              | uuid        | client-mintable, so an optimistic row and the stored row are one          |
| `stream_id`       | text        | the root agent                                                            |
| `author_kind`     | text        | `agent` \| `user`                                                         |
| `author_agent_id` | text null   | which agent, when `author_kind = agent`                                   |
| `to_agent_id`     | text null   | the agent that must receive this as a prompt; null = for people           |
| `kind`            | text        | see block kinds                                                           |
| `thread_id`       | uuid null   | the top-level block this replies under; null for a top-level block        |
| `reply_to`        | uuid null   | the specific block replied to (inside `thread_id`)                        |
| `text`            | text        | markdown; may be blank when `data` or `attachments` carry the content     |
| `data`            | jsonb       | kind-specific, immutable after post except through `update` by the author |
| `state`           | jsonb       | kind-specific, mutable: an answer, item states, a resolution              |
| `attachments`     | jsonb       | `[]`; file, link, code references (the media row is the source of truth)  |
| `origin`          | text null   | `launch` for the launch-context post; otherwise null                      |
| `delivered`       | bool null   | blocks with `to_agent_id`: prompt delivery outcome, null while pending    |
| `read_at`         | timestamptz | when the user saw it (agent-authored, `to_agent_id` null)                 |
| `created_at`      | timestamptz |                                                                           |
| `updated_at`      | timestamptz |                                                                           |

`block_reactions (id, block_id, stream_id, author_kind, author_agent_id,
emoji, delivered, created_at)`, one row per (block, author, emoji).

Indexes: `(stream_id, created_at desc)`, `(thread_id, created_at)`,
`(stream_id) where author_kind = 'agent' and to_agent_id is null and read_at
is null` (unread), `(stream_id, to_agent_id) where delivered is null`
(recovery), and `(stream_id) where kind in ('question','form') and state
->> 'answered' is null` (waiting).

`agent_chat_messages`, `agent_chat_reactions` and `agent_messages` are
dropped. Rows are not migrated.

### Block kinds

| kind       | data                                                                          | state                                                                  | who posts                       |
| ---------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| `text`     | —                                                                             | —                                                                      | anyone                          |
| `question` | `{ options: [{label, value?}], allowFreeform? }`                              | `{ answer?: {value, label?, by, blockId, at} }`                        | agent (to the user or an agent) |
| `form`     | `{ fields: [{id, label, type, options?, required?}] }`                        | `{ submission?: {values, by, blockId, at} }`                           | agent                           |
| `file`     | — (the file is an attachment)                                                 | —                                                                      | agent, user                     |
| `link`     | `{ url, title? }` (a PR is a link)                                            | —                                                                      | agent, user                     |
| `review`   | `{ verdict, summary, findings: [{id, severity, title, body, path?, line?}] }` | `{ findings: { [id]: { status: open\|resolved, resolution?: fixed\|dismissed, note?, by, at } } }` | agent, user                     |
| `tasks`    | `{ items: [{id, text}] }`                                                     | `{ items: { [id]: done\|now\|todo } }`                                 | agent                           |
| `board`    | later: kanban, table                                                          |                                                                        |                                 |
| `preview`  | later: a served URL with a live status                                        |                                                                        |                                 |

A `question` is a `form` with one field; it exists as its own kind because
it is the common case and renders as a row of buttons.

### Threads

`thread_id` is the id of a top-level block; a reply to a reply still carries
the top-level id in `thread_id` and the parent in `reply_to`. The stream
shows a top-level block with a "_n_ replies" line; the drawer shows the
thread as a page (`?thread=<id>`), and a review's finding as a page over
that (`&finding=<id>`). A reply reaches exactly one agent, never everyone
in the thread: the root's author and the agent it was addressed to are the
two sides (on a review, the reviewer and the builder); one side's reply goes
to the other, a person's reply goes to whoever's move it is (the builder on
an open finding, the reviewer on a resolved one), and an answer to a
particular comment goes to that comment's author. A plain reply under a
finding's comment is about that finding too. Reviews: a finding is `open`
until resolved as `fixed` or `dismissed` (with a note), and can be reopened;
the review is open, partially resolved or resolved by its findings.

### Delivery

A block with `to_agent_id` is a prompt for that agent, queued behind its
current turn like any other. The envelope is one shape for every author:

```
--- DISPATCH POST (id: <uuid>, from: user | <agent name> (<agent id>)) ---
<text>

Attachments:
- file: shot.png (/abs/path) · 12 KB
--- END DISPATCH POST ---
<one routing line: how to reply, if a reply is needed>
```

The routing line says: your reply appears in the stream as you write it;
`post` only for a question with options, a file, a link, a review, or to
reach another agent. A reply to a thread says `replyTo: <id>`.

A user's message is a block with `author_kind = user` and `to_agent_id` =
the agent: the same row and the same delivery path as an agent-to-agent
post. An answer to a `question` or `form` is a user block with `replyTo`
the input block, and the input block's `state` records it.

Reactions deliver as `--- DISPATCH REACTION ---` naming the block, as today.

### Status

Derived on the server and written as system status events (`phase: turn`):

- turn started → `working`, message = the prompt's gist
- turn settled → `idle`, unless the agent has an open `question`/`form`
  with `to_agent_id` null → `waiting_user` with the question's text
- turn error, unexpected exit, setup failure → `blocked`
- an input block posted for the user → `waiting_user` at once

The feed hides these; the presence line and sidebar show them.

## Tools

Agents get these, and only these, for the stream:

| tool     | input                                                                                              | returns             |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| `post`   | `{ to?, kind?, text?, replyTo?, question?, form?, review?, tasks?, link?, attachments?, notify? }` | `{ id, createdAt }` |
| `update` | `{ id, text?, data?, state?, attachments? }`                                                       | `{ id, updatedAt }` |
| `react`  | `{ id, emoji, remove? }`                                                                           | reactions           |

`post` without `to` posts to your own stream (a child's goes to the parent's
stream, attributed to the child). `to: <agentId>` addresses another agent;
any agent may address any agent. `kind` defaults from the data given
(`question` present → question, `review` → review, …) and to `text`.
`notify: true` sends the browser/Slack notification a `notify` call used to.

`update` on your own block may change `text`, `data`, `attachments` and
`state`. `update` on a block addressed to you may change `state` only (a
builder resolving a finding on a review it received). Nobody else may
update. People do the same through the UI: answer a question, submit a form,
resolve a finding, tick a task.

These replace `chat_post`, `chat_update`, `chat_react`, `send_message`,
`share_file`, `notify`, `pin`, `pins`, `delete_pin`, `list_pins`,
`surface_*`, `whiteboard_*`, `review_*`, `create_pr`, `get_pr_status`, and
the `agent_message` feed entry. `launch_agent` gains `persona`;
`launch_persona` goes.

## Feed

`GET /agents/:id/chat` becomes `GET /streams/:rootId/blocks` plus a
per-agent filter, but the response stays a cursor-paged list of entries:
`block`, `turn`, `status` (system marks only). A `block` entry is the block
with its reactions and its thread's reply count. Thread contents come from
`GET /streams/:rootId/blocks/:id/thread`. Write routes:

- `POST /streams/:rootId/blocks` — a user post (to the agent, or a reply in
  a thread)
- `POST /streams/:rootId/blocks/:id/answer` — answer a question / submit a
  form (creates the reply block, sets `state`)
- `PATCH /streams/:rootId/blocks/:id/state` — resolve, reopen, tick
- `POST | DELETE /streams/:rootId/blocks/:id/reactions`
- `POST /streams/:rootId/read`

SSE events: `stream.entry` (upsert one entry), `stream.changed` (refetch),
`stream.read`.

## Steps

1. `blocks` and `block_reactions`; `post`/`update`/`react`; `text`,
   `question`, `form`, `file`, `link` kinds; threads in the side panel; feed
   and routes as above for the root agent's own stream; `chat_*`,
   `share_file` and `notify` deleted; the launch post is a block.
2. `to_agent_id` delivery for peers; children post into the parent's stream
   and their turns render folded there; `agent_messages`, the Messages tab
   and `send_message` deleted.
3. Personas as profiles on `launch_agent`; the `review` block with finding
   threads and resolve/reopen; the review tables, tools, injection prompts
   and sidebar deleted.
4. `tasks`, `board`, `preview` kinds; the rail derived from live blocks
   (open input, running preview, active board); pins, surfaces, whiteboards
   and the git tools deleted.
