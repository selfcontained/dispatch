# Rich agent-controlled UI: enrich the pins schema vs. a dedicated surface

**Status: research / decision-support. Nothing in this doc is implemented or decided.**

Brad wants agents to have a surface whose UI they can control with more flexibility
than today's pins allow. Two directions are on the table:

1. **Enrich the pins schema** toward something Block-Kit-like — more block/element
   types, layout composition, richer interactivity — still living in the sidebar
   pin surface.
2. **A dedicated tab/surface** with its own UI-definition schema, separate from
   pins — pins stay simple, the new surface carries the richer agent-controlled UI.

This doc lays out what each would actually take, grounded in (a) Slack Block Kit's
real, current schema (fetched from docs.slack.dev on 2026-08-16) and (b) Dispatch's
actual pin implementation as of `main` (post-#946/#945/#955/#964). It ends with an
"if I had to pick" — the decision is Brad's.

---

## 1. What Block Kit actually is

Block Kit is Slack's JSON UI-definition language. An app composes a `blocks` array
and posts it to a surface (message, modal, or App Home tab). Its expressive power
comes from three distinct things, and it's worth keeping them separate because they
have very different costs:

**(a) A containment tree, not a flat list.** Three layers: _layout blocks_ (21
types today: `section`, `actions`, `input`, `context`, `header`, `divider`,
`image`, `video`, `rich_text`, plus a newer family — `markdown`, `table`,
`data_table`, `data_visualization`, `card`, `carousel`, `container`, `alert`,
`plan`, `task_card`, `context_actions`) contain _block elements_ (~45 types:
buttons, 5 select variants + 5 multi-select variants, overflow menus, checkboxes,
radio buttons, date/time/datetime pickers, text/email/url/number/rich-text/file
inputs, workflow buttons, feedback buttons…), which are configured with
_composition objects_ (text objects, options, option groups, confirm dialogs…).
Which element may appear in which block is a per-pair containment matrix
(`datetimepicker`: actions/input only; `plain_text_input`: input only; `overflow`:
section/actions; `feedback_buttons`: `context_actions` only; …).

**(b) Rich leaf content.** Individual block types that render something a plain
string can't: tables (100 rows/20 cols), interactive data tables with pagination
and sorting, pie/bar/area/line charts (`data_visualization`), images, video,
cards, carousels, full markdown (12,000 chars), and — notably — `plan` /
`task_card`, purpose-built blocks for showing an AI agent's task progress
(pending/in_progress/complete/error status per task).

**(c) A structured interactivity contract.** Every interactive element carries an
`action_id`; every block a `block_id`. A user interaction POSTs a `block_actions`
payload (who, what, `state.values` for all stateful elements, `response_url`,
`trigger_id`) to the app's endpoint, which must ack with HTTP 200 **within 3
seconds**. The app then rewrites the UI wholesale: `chat.update` /
`response_url` + `replace_original` for messages, `views.update` (guarded by a
`hash` field against races) for modals, `views.publish` for home tabs. Forms are
modal-shaped: `input` blocks accumulate state client-side and deliver it in one
`view_submission` payload; validation errors are returned keyed by `block_id`,
also inside a 3-second window.

### What the docs reveal about its cost

- **Limits are arbitrary and everywhere.** Field caps of 24/30/50/75/100/150/
  200/255/300/2000/3000 chars depending on which field of which object; 50 blocks
  per message, 100 per modal; 25 elements per actions block, 10 per context, 5 per
  overflow menu, 10 per checkbox group; mutually-exclusive field pairs (`text` vs
  `fields`, `image_url` vs `slack_file`, `icon` vs `slack_icon`); cross-field rules
  (equal column counts, one `focus_on_load` per view, `file_input` incompatible
  with `dispatch_action`). Handwriting valid payloads is hard enough that Slack
  ships a dedicated visual tool (Block Kit Builder) to generate them.
- **No schema versioning.** There is no version field anywhere. Evolution is
  purely additive (new block types appear; older consumers just don't know them).
  What you send isn't always what you read back — `markdown` blocks may be split
  into multiple blocks server-side, and docs instruct generating _new_ `block_id`s
  on every message update.
- **Three overlapping text systems** (mrkdwn text objects, `rich_text`, the
  `markdown` block) with different capabilities — accumulated evolution, not
  design.
- **The interactivity contract is the expensive part.** It presumes an always-on
  app endpoint, sub-3-second acks, single-use `trigger_id`s, rate-limited
  `response_url`s (5 uses/30 min). That machinery exists because Slack's apps are
  remote third-party servers. None of that maps to Dispatch, where the "app" is a
  local agent session.

**Directional signal worth noting:** the blocks Slack added _for AI apps_ are
`markdown`, `table`, `data_table`, `data_visualization`, `plan`, `task_card`,
`card`/`carousel`. That is: richer _leaf content_ — markdown, tables, charts, task
progress — not richer _layout composition_. Slack's own answer to "what does an
agent need to show" converged on better leaves, not deeper trees.

---

## 2. What Dispatch pins actually are

### Storage and write model

Pins are a JSONB array on the `agents` row (`agents.pins`, migration
`0001`/`0036`), max **50 pins**, each a flat object:

```
{ id, label ≤100, value ≤2000, type ∈ {string,url,port,code,pr,filename,markdown,shortcut},
  caption ≤160 (single line, inline-markdown), group ≤100,
  icon/variant/confirm/disabled (shortcut-only) }
```

The write model is the defining design commitment: **pins are a label-addressed
key-value store with merge semantics**. `dispatch_pin` matches by id-or-label;
omitted fields keep their stored value; empty string clears a decoration; the
resolved type governs which decorations survive (`finalizePin` strips
shortcut-only fields from non-shortcuts). Updates never move a pin
(`applyPinSpec` keeps position); groups are anchored where their first member
sits; `dispatch_pins` adds atomic batches and a `replace` mode scoped to one
group. All of this exists so an agent can incrementally maintain a small board of
facts across a long session without restating or reshuffling anything.

### Rendering

One flat switch. `pin-item.tsx` branches shortcut vs. value; `pin-value-row.tsx`
resolves each type to one of: external link (url/pr, http(s)-validated), monospace
badge (port/code/filename), scrollable markdown body, or plain text. List-like
types split multi-values on commas/newlines. Groups render as collapsible
headings (auto-collapse past 8 members, collapse state persisted per-agent in
localStorage on the _user's_ side). The rail is ~400px; the caption cap of 160
chars is literally measured against its three-line clamp (`pins.ts` comment).

The ceiling is deliberate, not accidental: markdown pins **reject** headings,
links, images, raw HTML, tables, nested lists, and >20-line code blocks at write
time (`validateMarkdownPinValue`). Today's model can't do more because it was
designed not to — every pin is a glanceable fact or a button, sized to a sidebar.

### Interactivity

Exactly one primitive: a `shortcut` pin renders as a button; clicking POSTs the
**pin id** to `/terminal/inject-pin/:pinId`; the server resolves the stored
prompt server-side (`pin-run.ts` — the client never supplies content) and injects
it into the agent's session as if typed. Confirmation (`confirm: true`, forced on
touch), disabled state, variants, and 25 icons decorate this one primitive.
There is no state, no callback payload, no forms — the entire "interaction model"
is _user action → prompt injection_, and its trust boundary is one 30-line
function.

### The context-budget constraint (measured, recent)

The MCP tools/list payload is ~70KB / ~17.5K tokens across 64 tools, paid by
every agent every session (measured 2026-08-12, brain:
`mcp-tool-schema-size-audit`). `dispatch_pin` is already the **second-largest
entry** (4,686 chars: 1,783 description + 2,775 inputSchema). PR #946
deliberately kept the `dispatch_pins` batch entry schema terse ("restating them
here would double what every agent pays"); #945 trimmed response verbosity; #955
trimmed launch guidance. Growing the pin schema is not free — it is the axis the
project has been actively shrinking.

### The precedent that already answers half the question: the whiteboard

Dispatch already has a dedicated agent-controllable rich surface. The whiteboard
is: its own DB table (`whiteboards`: agent_id PK, `scene` JSONB, version,
updated_by), its own center-pane tab (Terminal / Changes / **Whiteboard**) with an
"agent drew" attention dot, and a tool trio — `whiteboard_get` /
`whiteboard_update` / `whiteboard_howto`. Two of its lessons are directly
load-bearing here:

1. **The rich schema lives outside tools/list.** `whiteboard_update`'s
   inputSchema is deliberately loose (`array of records with id+type`); the actual
   Excalidraw element format is served by the on-demand `whiteboard_howto` tool.
   That pattern was adopted precisely because the inline description (~7KB) was
   the single largest tools/list entry.
2. **A dedicated surface most agents never use still costs everyone.** Per the
   schema-size audit, whiteboard tools are the largest tools/list line item and
   most agents never call them. A surface's existence-cost is paid session-wide
   whether or not it's used.

---

## 3. Option A: Block-Kit-like pins

### What it would concretely look like

Taking Block Kit as the reference, "richer pins" means some subset of:

- **New leaf types** — e.g. `table`, `progress`/`tasks` (Slack's `plan` /
  `task_card`), `image` (referencing `dispatch_share` media), maybe `chart`.
- **Composition** — a pin whose value is a _tree_: a section with fields and an
  accessory button; a card with title/body/actions; a container of blocks.
- **More interactive elements** — selects, checkboxes, text inputs; i.e. forms in
  the sidebar.

### What maps cleanly — and how much of it pins already have

It's worth being honest that pins already contain a miniature of Block Kit's
most-used core, translated to sidebar idiom:

| Block Kit concept               | Pins today                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| button + style + confirm object | `shortcut` + `variant` + `confirm`                                                          |
| section (label + text)          | label + value                                                                               |
| header / divider grouping       | `group` headings                                                                            |
| context / small text            | `caption` (inline markdown)                                                                 |
| mrkdwn text                     | `markdown` pin (constrained)                                                                |
| static_select (pick one of N)   | a `group` of shortcut pins — already the idiomatic pattern for "answer a blocking question" |

The concepts that map cleanly as _additions_ are exactly the leaf-content blocks:
`table`, `plan`/`task_card`, `image`. Each fits the existing architecture as **one
more enum value + one more server-side validator + one more render branch** — the
`markdown` type already establishes the pattern of "structured value in a string,
validated at write time." Schema cost is near-zero (an enum value plus a sentence
of description); no storage change; no migration; existing callers unaffected.
This is the cheap 80% of "richer."

### What does not map — and why it fights the pin model

**Composition breaks merge semantics.** The pin write model's whole value is
field-level merge on a flat shape: omit = keep, empty string = clear, resolved
type governs decorations. None of that extends into a tree. Updating one cell of
a nested table, or one button in a card, needs either path addressing (a new
addressing language: ids at every level, à la Block Kit's block_id/action_id — and
note even Slack punts here, instructing wholesale replacement with _fresh_
block_ids on update) or replace-the-whole-pin semantics — at which point the pin
is no longer a merged KV entry but a wholesale-replaced document, i.e. a
different storage model wearing a pin costume. `mergePin` / `finalizePin` /
`clearBlankPinFields` / `applyPinSpec` all assume flatness; every one grows
special cases under nesting.

**Two layout owners conflict.** Block Kit assumes the app owns the entire layout
of its (single, bounded) message. The sidebar is a _multi-pin_ surface where
layout is computed: groups anchor at first member, updates never relocate,
auto-collapse and persisted collapse belong to the user. An agent composing
explicit layout (containers, widths, carousels) inside a rail whose macro-layout
it doesn't own produces two authorities over one column of pixels — and the rail
is ~400px, where "layout composition" mostly degenerates to a vertical stack
anyway. Block Kit is designed for a ~600px message body plus modals; its layout
vocabulary buys little in a narrow persistent rail.

**Forms need an interactivity contract Dispatch deliberately doesn't have.**
Slack's forms work because of `state.values`, submission payloads, and a
3-second-ack app endpoint. Dispatch's single primitive is prompt injection of
_agent-authored_ content, with a one-function trust boundary. Sidebar forms mean:
client-held form state, a submission payload shape, delivery semantics when the
agent is mid-turn or stopped (shortcuts already need `agentIsRunning` /
`disabled` / pending handling for the _simple_ case), and user-authored free text
flowing through the injection path. Each is solvable — serializing form state
into an injected prompt is the natural translation, and the user can already type
in the terminal, so it's not a new trust class — but it's a designed subsystem,
not a schema extension, and it's the single most expensive piece of Block Kit to
import.

**Schema/token cost lands on the hottest tool.** Encoding even a modest
composition subset in zod multiplies the already-#2 tools/list entry; the
containment matrix and per-field caps are exactly the kind of text that bloats
descriptions. The whiteboard escape hatch (loose schema + `pin_howto`) would cap
the tools/list cost but moves all validation to imperative server code and all
learning to an extra round-trip — and per the plugin-era constraint (#955), the
richer the payload language, the more agents mis-write it and burn turns on
validation errors. LLMs writing deep nested JSON against arbitrary limits is the
documented reason Block Kit Builder exists, and agents don't get a Builder.

### Migration cost

Flat new types: none. Composition: a storage-shape change on the most-used agent
surface (0036 already shows what normalizing legacy pin data costs), back-compat
for every existing pin and caller, and revalidation of the merge model. The
recent investment (#946, #964) is all in the _current_ model.

---

## 4. Option B: a dedicated tab/surface

### What it structurally needs

The whiteboard provides the exact skeleton, de-risked:

- **Storage**: its own table (`agent_surfaces`: agent_id, `doc` JSONB, version,
  updated_by, updated_at). Document-shaped, versioned, replaced or merged by
  top-level block id — _not_ entangled with the pin merge model.
- **Tool surface**: `surface_get` / `surface_update` / `surface_howto` (+ maybe
  `surface_clear`). Thin inputSchemas; the block language documented in the
  howto. Net tools/list cost can be held to a few hundred chars — but it is three
  or four _more_ tools in a 64-tool list the project wants smaller, plus a claim
  on the launch-guidance budget so agents know the surface exists.
- **Rendering**: one renderer component tree for the block language. This is the
  real cost center: a Block-Kit-class renderer is a small component library
  (tables, task lists, cards, forms…), plus empty states, error states for
  invalid docs, and mobile.
- **Navigation/discoverability**: a tab — realistically either a fourth
  center-pane tab beside Terminal/Changes/Whiteboard or a fifth right-rail tab
  beside Pins/Media/Reviews/Messages — with an attention indicator (the
  whiteboard's "agent drew" dot is the pattern). Center pane fits "dashboard"
  width; the rail does not.
- **Interactivity**: same primitive as shortcuts — user action → server resolves
  against the stored doc → prompt injection. `resolveShortcutRun` generalizes: the
  client sends element ids (plus form values if forms are in scope); content
  authority stays server-side.
- **Update semantics**: wholesale document replacement (or replace-by-block-id)
  per write, like `views.publish`. This is _much_ simpler than retrofitting trees
  into merge semantics — it's the natural grain for "agent renders a view."

### What it buys

- **Pins stay simple.** No migration, no risk to the one surface nearly every
  agent uses correctly today, no growth of the #2 schema entry.
- **The right grain for rich UI.** A document surface replaced wholesale matches
  how agents actually produce UI (render the current state of the world), and
  matches Block Kit's own update model, without inheriting its callback
  machinery.
- **Width.** A center-pane tab has room for tables/charts/dashboards; the rail
  never will.
- **Failure isolation.** A malformed rich doc breaks one tab, not the sidebar.

### What it costs

- **The whiteboard's cautionary half.** Dispatch would then have _two_ dedicated
  agent surfaces (whiteboard, rich surface) plus pins — three places agents can
  put things. Guidance burden goes up (the launch-guidance budget is a known,
  managed constraint), and the audit's data point is blunt: the existing dedicated
  surface is the biggest tools/list line item and most agents never use it. A
  second one starts life with the same risk profile.
- **Renderer surface.** By far the largest implementation item on either path —
  and it's all new code, where Option A's flat types reuse the existing pin
  rendering frame.
- **Discoverability is real work, not a footnote.** Pins are seen because the
  Pins tab is default-visible with a count badge. A new tab that agents rarely
  populate is a dead tab; one they populate without the user noticing is wasted
  agent effort. The attention-dot pattern helps but doesn't solve "when should an
  agent choose this over pins."

---

## 5. The honest over-engineering check

The stated goal is "agents controlling richer UI." Neither the goal statement nor
observed agent behavior demands _layout composition_ or _sidebar forms_:

- Today's expressed pressure is at the leaves: agents already emulate selects
  with shortcut groups (works well — the idea-inbox kanban is grouped pins),
  already hit the markdown pin's deliberate ceiling for structured summaries, and
  have no way to show a table, task-progress board, or image.
- Slack — with vastly more surface area and a decade of app feedback — answered
  the AI-app version of this exact question with richer leaves (markdown, tables,
  charts, plan/task cards), not richer nesting.
- The full Block Kit import (composition + forms + containment matrix) is the
  "cool to build" end. Its costs land on measured, actively-managed budgets
  (tools/list tokens, launch guidance, merge-model complexity) against
  speculative demand.

There is also a real middle path that the two-option framing hides: **new flat
pin types are Option A's cheap half, and they don't foreclose Option B.** The
architecture extends per-type at ~zero schema cost, and a later dedicated surface
would want the same leaf renderers anyway (a table renderer, a task-list
renderer) — that code transfers.

---

## 6. If I had to pick

Sequence it; don't pick a side wholesale:

1. **Now:** extend pins with 2–3 flat leaf types chosen against actual demand —
   the strongest candidates from both the Block Kit evidence and Dispatch usage
   are `tasks` (plan/task_card-style progress, status per line) and `table`
   (bounded, CSV-or-JSON-in-value, validated like markdown pins). Keep values as
   validated strings; keep the merge model untouched; schema cost is an enum
   value. This serves most of "richer" immediately and teaches which richness
   agents actually use.
2. **Hold composition and sidebar forms.** They fight the pin model's load-bearing
   commitments (flat merge, computed layout, one-function interactivity) and
   spend from the budgets the project just spent three PRs shrinking.
3. **If/when a genuinely free-form surface proves wanted** (an agent needs a
   dashboard, not facts), build it as the dedicated tab on the whiteboard
   skeleton — own table, document-replacement writes, `surface_howto` for the
   format, thin tool schemas — and treat the whiteboard's adoption numbers as the
   gate: if the existing dedicated surface can't earn its tools/list cost, the
   burden of proof for a second one is on demonstrated demand, not on what would
   be cool.

The one-line version: **Block Kit's richness = better leaves + composition +
callbacks. Pins can absorb the leaves for almost nothing; composition and
callbacks belong — if demand materializes — on a wholesale-replaced document
surface, never inside the pin merge store.**

---

## Appendix: source facts

- Block Kit: fetched 2026-08-16 from docs.slack.dev (api.slack.com now 302s
  there): `/reference/block-kit/blocks`, `/reference/block-kit/block-elements`,
  `/reference/block-kit/composition-objects`, `/interactivity/handling-user-interaction`,
  `/surfaces/modals`, `/surfaces/app-home`, per-block and per-element pages.
  Key limits: 50 blocks/message, 100/modal & home tab, 25 elements/actions block,
  3s interaction ack, single-use 3s `trigger_id`, `response_url` 5 uses/30 min,
  no schema version field anywhere.
- Dispatch: `apps/server/src/pins.ts` (types, caps, markdown restrictions),
  `apps/server/src/agents/pin-write.ts` / `pin-merge.ts` (merge model, MAX_PINS
  50, replace-mode anchoring), `pin-run.ts` (shortcut trust boundary),
  `apps/server/src/shared/mcp/server.ts` (tool registrations, schema-size
  comments), `apps/web/src/components/app/pin-*.tsx` (render switch, grouping,
  collapse), `apps/server/src/shared/mcp/whiteboard-tools.ts` +
  `0037_whiteboards.sql` (dedicated-surface precedent), brain object
  `mcp-tool-schema-size-audit` (measured 70,079-char tools/list; dispatch_pin
  4,686 chars), PRs #945/#946/#955/#964.
