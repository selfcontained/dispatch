# Streams and blocks

Every agent's product is a stream of blocks. Chat renders it; the sidebar,
notifications and the Activity page derive from it. This is the contract the
`acp-runtime` branch builds against, replacing the Chat tab's message table,
cross-agent messages, file posts, pins, surfaces, whiteboards and reviews
one step at a time. It is not a description of what `main` does today.

For the paused October 2026 discussion about communication across sessions,
threads and optional Tasks, see [Communication exploration](#communication-exploration-paused).
That section records findings and unsuccessful proposals, not a selected design.

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
thread  = the blocks that reply to one block: a top-level block, or a block
          another shows (a finding in a review). Collapsed in the stream to
          "3 replies", opened as a page in the right drawer.
shows   = a block may show other blocks inside it (`state.blocks`, ids in
          order): a launch card its agent's review, a review its findings.
          Each is a row of its own — its own state, its own thread — stored in
          the host's thread and drawn by the host, never listed as a reply.
          Read back resolved as `block.blocks`.
turn    = an agent's unit of work (prompt → steps → answer). The answer is a
          block (`origin: turn`) written empty when the turn opens and filled
          when it settles; the steps come from `agent_stream_events` and ride
          along as `block.turn` at read time. The stream is blocks only.
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
| `thread_id`       | uuid null   | the block whose thread this is in; null for a top-level block             |
| `reply_to`        | uuid null   | the specific block replied to (inside `thread_id`)                        |
| `text`            | text        | markdown; may be blank when `data` or `attachments` carry the content     |
| `data`            | jsonb       | kind-specific, immutable after post except through `update` by the author |
| `state`           | jsonb       | kind-specific, mutable: an answer, item states, a resolution              |
| `attachments`     | jsonb       | `[]`; file, link, code references (the file row is the source of truth)   |
| `origin`          | text null   | `turn` for a turn's answer; else null                                     |
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

| kind       | data                                                                            | state                                                                      | who posts                       |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| `text`     | —                                                                               | —                                                                          | anyone                          |
| `question` | `{ options: [{label, value?}], allowFreeform? }`                                | `{ answer?: {value, label?, by, blockId, at} }`                            | agent (to the user or an agent) |
| `form`     | `{ fields: [{id, label, type, options?, required?}] }`                          | `{ submission?: {values, by, blockId, at} }`                               | agent                           |
| `file`     | — (the file is an attachment)                                                   | —                                                                          | agent, user                     |
| `link`     | `{ url, title? }` (a PR is a link)                                              | —                                                                          | agent, user                     |
| `review`   | `{ summary }` (posted with `findings: [{severity, title, body, path?, line?}]`) | `{ blocks: [finding ids] }`                                                | agent, user                     |
| `finding`  | `{ severity, title, body, path?, line? }`                                       | `{ status: open\|resolved, resolution?: fixed\|dismissed, note?, by, at }` | written with its review         |
| `launch`   | — (`text` is the briefing, `to_agent_id` the agent it launched)                 | `{ startup?, instructions?, blocks? }`                                     | Dispatch, one per agent         |
| `tasks`    | `{ items: [{id, text}] }`                                                       | `{ items: { [id]: done\|now\|todo } }`                                     | agent                           |
| `board`    | later: kanban, table                                                            |                                                                            |                                 |
| `preview`  | later: lifecycle block (current previews use typed attachments)                 |                                                                            |                                 |

A `question` is a `form` with one field; it exists as its own kind because
it is the common case and renders as a row of buttons.

### Threads

`thread_id` is the id of the block a thread opens on: a top-level block, or
a block another shows (each finding is a thread of its own). A reply to a
reply carries the same `thread_id` and the parent in `reply_to`. The stream
shows a top-level block with a "_n_ replies" line; the drawer shows the
thread as a page (`?thread=<id>`), and a finding's thread as a page over its
review's (`&finding=<id>`). A reply goes to the agents on its thread's two
sides — the host's author (or launcher) and whoever the host is for: one
side's reply goes to the other; a person's goes to both; an answer to a
particular comment goes to that comment's author.

Every agent has a launch card, a `launch` block written when it starts: its
briefing, its startup steps and its instructions. Who it is (name, model,
persona, status) is read from the agent, so the card follows it. A child's
card is its one entry in its parent's stream and its default channel: a
child's posts and turns land in the card's thread unless they name another,
and so does a post addressed to the child with no `replyTo`. A child's
review goes on its card, which shows it.

Reviews: a review shows one `finding` block per item. A finding is `open`
until its reviewer (or a person) resolves it as `fixed` or `dismissed` (with
a note), and can be reopened, which tells the agent whose work it is; that
agent answers under the finding. Where a review stands — open, partially
resolved or resolved — comes from its findings alone.

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

### Current turn and attention

The sidebar reads the current step from the same ACP turn block shown in the
stream. It does not create a separate status label when the turn has no reported
step. An open `question` or `form` for the user and a failed turn trigger
attention notifications from those actions. A turn's error is recorded on its
block (`block.turn.error`).

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
`state` (a reviewer resolving its finding). `update` on a block addressed to
you may change `state` only. Nobody else may update. People do the same through the UI: answer a question, submit a form,
resolve a finding, tick a task.

These replace `chat_post`, `chat_update`, `chat_react`, `send_message`,
`share_file`, `notify`, `pin`, `pins`, `delete_pin`, `list_pins`,
`surface_*`, `whiteboard_*`, `review_*`, `create_pr`, `get_pr_status`, and
the `agent_message` feed entry. `launch_agent` gains `persona`;
`launch_persona` goes.

## Feed

`GET /agents/:id/chat` becomes `GET /streams/:rootId/blocks` plus a
per-agent filter, but the response stays a cursor-paged list of `block`
entries: the block with its reactions, its thread's reply count, who has
replied and how many replies are unread, and, on a turn's block, the turn
(`block.turn`) assembled from the agent's event log. A turn opened by a
reply in a thread answers in that thread: its block is a reply there, not
a row in the column. Thread contents come from
`GET /streams/:rootId/blocks/:id/thread`, turns attached the same way.
Write routes:

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
4. `tasks`, `board`, `preview` kinds; the Inbox derived from live blocks
   (open input, running preview, active board); pins, surfaces, whiteboards
   and the git tools deleted.

### Image captions

Post `text` is always a normal Markdown message body, including when attachments
fold into a turn. This rendering also applies to existing chats; body text is never
inferred or migrated into an image caption.

File attachments accept an optional plain text `caption` (up to 2,000 characters).
Captions display with their images in single-image cards, galleries, and the image
viewer. Omit `caption` for no visible caption; filenames still provide accessible
fallback labels. A caption belongs to one attachment occurrence: two posts can
attach the same `fileId` or `fileName` with different captions. `update` replaces
the attachment list, so supply captions again for the replacement attachments.
`description` remains file registry metadata set on upload and is independent of
these captions.

### Inbox resources

`post` and `update` accept `{ type: "preview", url, title }` attachments alongside
`pr`, `link`, file and code. Preview titles are required, trimmed and limited to
200 characters; URLs use the existing safe HTTP(S)/app-path contract. Preview
is explicit, never inferred from host, port, LAN address, text or Markdown.
Both stream cards and Inbox cards use distinct pull-request or monitor icons
with accessible type-and-title names; visible type labels are omitted. Generic links remain rich stream cards, excluded from Inbox;
legacy PR-shaped link attachments and link blocks remain compatible.

The first-page `threadLinks` field retains its wire name for compatibility but
now carries the newest **20 resource-bearing posts across direct and threaded
posts**, independent of the paginated feed. Filtering by type and stream/child
author happens before the server bound, so generic batches cannot evict direct
or thread resources. Inbox resolves newest `updatedAt` copies by block ID before
filtering, orders by creation time then ID descending, bounds to 20 resource
posts, deduplicates exact URLs and displays at most 8 resources. The post bound
is deliberate: more than 20 recent resource posts can age older results out,
including when several posts repeat one URL. This is a glance, not an index.

Resource scope preserves the previous Inbox contract: a root reads the whole
shared stream, including thread resources regardless of the feed's child toggle
or recipient routing. A child's page includes only that child's authored posts;
filtering before the bound prevents siblings consuming its resource history.
No resources from another stream are admitted. This differs intentionally from
checklist visibility, which follows the feed's quiet/full toggle.

SSE keeps the bounded supplement and loaded/shown copies current. Replacing
attachments can remove a resource; stale versions must not restore it. An event
racing a first fetch/refetch triggers a fresh snapshot, and reconnect refreshes
the first-page supplement. Questions, forms, reviews and checklists keep their
existing contracts. No preview lifecycle or automatic promotion is introduced.

For this repository's dev stacks, user previews contain only the web LAN URL as
a named preview attachment plus separate cleanup commands. API/DB addresses are
internal validation details; the generic preview contract supports other apps.

## Communication exploration (paused)

Recorded 2026-10-28. **Status: paused; problem unresolved; no solution selected or
implementation authorized.** Preserve these findings when revisiting the subject;
do not treat the exploratory mockups or alternatives as an approved roadmap.

This section is a discussion record, separate from the original design contract
above. The source audit used released v1.5.5, commit
`71c9bace78a7a208425cff17c0c233df4698ccbb`. It inspected implementation and existing
tests, not a new live reproduction or a measurement of production failure rates.

### Problem and constraints

The user finds it difficult to track where agents communicate: an agent's stream,
a thread, or a Task conversation. Tasks recently introduced another real place to
follow work. The problem may include discoverability, too many independent
speakers, unclear communication ownership, excessive narration and misplaced
answers; this discussion did not establish which is the dominant cause.

Constraints that must survive any future proposal:

- **Claude and Codex CLIs remain the engine layer.** Subscription-account access
  is essential; replacing them with API-key model orchestration is not an option.
  Changes may live above the CLIs/ACP rather than replacing execution engines.
- **Tasks are first-class but optional.** Consider standalone sessions, leads
  with children, and Tasks with participating agents. Neither requiring all work
  to have a Task nor ignoring Task conversations addresses the actual problem.
- **Normal engine prose is a legitimate answer.** Agents naturally answer and
  supply details through ordinary turn output. Requiring every useful answer to
  be repeated through `post` would be brittle and could strand or hide answers.
- Preserve inspectable execution history, provenance, direct conversations,
  permission boundaries and genuine user authorization. A new view or inferred
  summary must not manufacture an approval.

The user was interested in a global Inbox, but characterized it as more of a
consuming-side band-aid. Producing-side changes remain worth investigating. That
interest was not approval of a particular Inbox or communication architecture.

### What the audit found already exists

Several suggestions initially presented as new were existing capabilities. Check
the current source again before building on this dated audit.

| Capability                                   | Existing behavior at the audited commit                                                                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input provenance                             | `PromptSource` distinguishes chat/agent/system/engine origin and carries user-message, conversation, source-message, schedule and awaited-response information.                                                                                                                        |
| Source-aware response placement              | The server resolves originating stream/thread context; replies can answer in the conversation that prompted them. Background work has an agent home, with children normally under their launch-card thread.                                                                            |
| Batching and steering constraints            | Queue batching checks conversation and user/agent origin. Steering has same-conversation rules and explicit awaited-review/schedule exceptions. User messages receive queue priority.                                                                                                  |
| Response boundaries within an execution turn | Eligible user steering pickup receipts can establish a pending response. Subsequent assistant text can start a distinct response block without starting a new engine turn. This depends on receipt support and does not certify the semantic intent of each sentence.                  |
| Durable questions and forms                  | Existing blocks retain answer/submission/cancellation state, actor, timestamps, reply references and delivery handling. Forms and buttons themselves are not a new benefit.                                                                                                            |
| Parent-handled child requests                | Qualifying child questions/forms are automatically routed to the parent/root for handling; guidance tells the parent to answer from context or escalate when needed. Failed delivery remains discoverable. This is not a universal rule for all prose or independent top-level agents. |
| Thread requests in the session Inbox         | The session-scoped Inbox supplements the feed with open user questions/forms across threads. Agent-addressed questions are distinguished from user inputs. This is not global aggregation across independent sessions.                                                                 |
| Execution detail disclosure                  | Tool/thought activity is recorded separately and can be collapsed under answers. The empty-success filter hides only proven no-op turns, not all nonempty background prose.                                                                                                            |
| Explicit outcome contracts                   | Jobs already require completion/failure/needs-input reporting and structured reports; engine/session termination alone is not a successful job outcome. Reviews also have structured findings/resolutions.                                                                             |
| Mutable progress records                     | `update` and stateful checklists already exist. A consistent shared-status policy would extend these primitives rather than invent updating.                                                                                                                                           |
| Optional Task conversation                   | Task conversations are additional stream roots using shared feed machinery. They coexist with agent sessions and threads; Task membership does not automatically make every agent response a Task-conversation post.                                                                   |

An important distinction remains: **agent delivery is not the same as user-facing
presentation**. `post` with `to` delivers to an agent, but the tool contract says
the user still sees that post in the stream. Existing child containment and
filters are not a general classification of all communication into user dialogue
versus internal coordination.

### Directions explored, without selecting one

1. **Global Inbox.** Aggregate requests across sessions, with project/context
   filtering and links to the original discussion. Useful for finding things,
   but it does not by itself change what agents produce or where it lands. Reuse
   existing request records and lifecycle rather than creating duplicate asks.
2. **Reply where asked; bring consequential outcomes home.** Initially proposed
   as a simple rule. Much of source-aware routing already exists, and “home” is
   not a sufficient universal answer when sessions, threads and optional Tasks
   coexist. More instructions alone did not demonstrate an improvement.
3. **An accountable lead and explicit escalation.** Limit independent agents
   addressing the user; coordinate through a lead. Potentially impactful, but
   parent-handled structured child requests already provide part of this. The
   unresolved scope includes normal prose, top-level peers, user-to-child direct
   conversations and escalation when a lead is unavailable or wrong.
4. **Intentional output tools or assignment contracts.** Ask for progress,
   requests, findings and results instead of treating all CLI output alike. A
   tools-only answer channel was challenged because agents naturally use prose.
   Jobs provide an existing contract precedent; broader contracts would be an
   extension. Schema-valid output is not proof of successful work.
5. **Invocation purpose/audience and Conversation versus Activity.** Preserve
   natural output, but distinguish answers addressed to the user from internal
   processing. This may reduce ambiguity/noise, but hides useful information if
   inferred incorrectly. A system-triggered check can still owe the user a result
   requested earlier. Do not equate system origin with internal-only output.
6. **A: clearer destinations and linked consequences.** Keep a record in one
   stream/thread; explicitly surface consequential requests/results in a relevant
   session or Task. Risk: another convention agents must remember, without a
   demonstrated improvement over current routing.
7. **B: shared records across contextual views.** Keep one underlying request or
   result, but surface it in associated session/Task/Inbox views with the same ID
   and state. This does not inherently change where turns or posts land. The user
   correctly identified it as presenting important messages on multiple surfaces,
   another consuming-side change rather than the producing-side answer sought.
   Associations also require ownership, scope, unread, reply and relevance rules.
8. **Communication context persisting across delegation/wakeups.** Revisited as
   a producing-side alternative after B's limitation became clear. However,
   current provenance, routing and response-boundary machinery already cover
   substantial ground. No specific missing rule or better experience was proven.

Separate these design axes when resuming: **where a record lives**, **which agent
receives it**, **which context it belongs to**, **what the user sees by default**,
and **what requires the user's attention**. They are related but not identical.
“One underlying record” prevents state divergence; it does not establish that
showing that record in more places helps the user.

### What did not work in the exploration

- UI mockups were not helpful to the user; they requested IA/information-flow
  visuals instead. Merely changing tabs or drawing a cleaner feed obscured the
  architectural questions.
- The first before/after comparison gave the proposal structured forms/buttons
  while showing prose in the current experience. That was unfair: those controls
  already exist, and the same producer actions must be held constant.
- The discussion repeatedly drifted toward mandatory Task ownership, then
  overcorrected toward treating Tasks as peripheral. Both miss the constraint.
- The shared-record replay isolated association from activity filtering, but
  still mainly demonstrated cross-surface presentation rather than improving
  production or initial placement of communication.
- IA diagrams clarified what B meant, but the user did not find the proposals
  convincing. The final assessment was that none had yet demonstrated enough
  benefit to justify the complexity. Do not record B, the global Inbox, or the
  Conversation/Activity split as the chosen direction.

### Open questions and a possible restart

The last suggested restart was to examine a **real confusing exchange** before
designing another mechanism. No representative incident was selected or traced
end to end before pausing. Possible examples mentioned were website approvals
and builder updates; these are candidates, not established reproductions.

A useful future audit of such an exchange would capture:

1. What the user expected to hear, from whom, and where they were looking.
2. Every input, invocation, ordinary response, explicit post, question/form and
   continuation involved, with stable IDs and source context.
3. The actual storage location, delivery recipient, response/pickup boundary,
   visible surfaces, open-request state and notifications for each record.
4. Whether the failure was routing, missing context, producer behavior,
   independent speakers, excessive narration or discovery. Multiple causes may
   coexist; do not assume a new entity or view fixes them all.
5. The smallest counterfactual change that would have helped, using the same
   existing controls and identifying any changed agent behavior explicitly.
6. Its effects in all three settings: standalone session, session with children,
   and Task with participating agents. Include mixed inputs, scheduled obligations,
   direct side conversations, unavailable agents and conservative legacy fallbacks.

Questions that remain unanswered:

- What should make an ordinary output an answer to the user rather than a report
  or internal processing, and how can that be established reliably?
- When do execution events preserve communication context, and when should they
  deliberately open a new conversation? Which actual failures remain after the
  existing routing and pickup rules?
- Which consequences can Dispatch identify from explicit metadata, and which
  require an agent's judgment? Do not assume semantic attribution from ACP chunks.
- How should Task conversations and agent sessions coexist without competing as
  places the user must follow? How does direct child conversation remain usable?
- Would one accountable speaker, fewer generated updates, or an explicit request
  obligation improve more than rearranging or aggregating messages?
- Does a global Inbox provide sufficient standalone value even if it leaves the
  producing-side problem unresolved?

Resume only as a deliberate product/design investigation. This note does not
authorize changes to runtime routing, tools, Tasks, Inbox, output visibility,
steering or the CLI engines.

### Audit entry points

These are source pointers, not a promise that the implementation will remain
unchanged after the audited commit:

- [Prompt source/provenance](../../apps/server/src/agents/acp/prompt-source.ts)
  and [queue/steering policy](../../apps/server/src/agents/acp/runtime.ts).
- [ACP driver](../../apps/server/src/agents/acp/driver.ts): prompted settlement
  follows the prompt response; quiet-time fallback applies to self-started turns
  missing an end signal, not all normal turns.
- [Stream recorder](../../apps/server/src/agents/acp/stream-recorder.ts):
  `steering_picked_up`, pending response and `startResponse`.
- [Stream service](../../apps/server/src/chat/service.ts): `homeOf`, `writePost`,
  parent-handled requests, `recordTurnStarted`, `recordResponseStarted`,
  `resolvePromptSource`, question/form answer and cancellation handling.
- [Post/update contracts](../../apps/server/src/shared/mcp/stream-tools.ts),
  [request data/state](../../packages/shared/src/block-types.ts), and
  [session Inbox derivation](../../apps/web/src/hooks/use-inbox.ts).
- [Task conversation](../../apps/web/src/components/app/tasks/task-conversation.tsx),
  [turn rendering](../../apps/web/src/components/app/chat/turn/turn-entry-view.tsx),
  and [empty-turn projection](../../apps/web/src/components/app/chat/turn/visible-feed.ts).
- [Jobs outcome lifecycle](../../apps/server/src/jobs/service.ts):
  `buildJobPrompt` and monitoring termination without a reported outcome.
- [Stream service tests](../../apps/server/test/stream-service.test.ts) and
  [ACP queue tests](../../apps/server/test/acp-runtime-queue.test.ts) cover existing
  parent-request, conversation and response-boundary behavior.
