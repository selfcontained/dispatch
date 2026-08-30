# Brain-Bound Surfaces — Design

Status: **designed, not scheduled**. This document captures the full design and
the decisions behind it so the work can be picked up later without re-deriving
context. Research and discussion history lives in the brain idea
`dispatch-ideas/surface-brain-bound-state` (revisions 1–5, 2026-08-28/29).

## Problem

Agent surfaces are static documents. A surface that mirrors live data — the
motivating case is the Idea Inbox's "Ideas Kanban" tab mirroring the brain's
`dispatch-ideas` collection — is a snapshot: every change to the underlying
data requires the owning agent to wake up and rewrite the whole block list via
`dispatch_surface_update`. Content drifts whenever the owner isn't running, and
writes from _other_ agents to the same brain collection never reach the surface
at all.

The feature: let a block declare that its content is **bound** to brain state
(an object, a collection of objects, or a brain list), so the rendered surface
stays current automatically — from any writer, with no owner involvement.

## What the current architecture already provides

The design leans heavily on plumbing that exists today. Verify these still hold
before building:

- **Brain writes already broadcast.** Every brain MCP write path calls
  `publishBrainChanged` (`apps/server/src/shared/mcp/brain-tools.ts`), which
  publishes `{type: "brain.changed", repoRoot}` on the UI SSE stream
  (`apps/server/src/server.ts`, member declared in
  `packages/shared/src/ui-event-types.ts`). The web client already handles it
  (`apps/web/src/hooks/use-sse.ts`, invalidates `["brain"]` queries).
- **Surfaces are refetch-driven, not patch-driven.** `surface.changed` SSE is a
  thin signal; the web client invalidates and re-fetches the whole surfaces
  payload (`use-sse.ts`, `use-agent-surfaces.ts` — `staleTime: 0`,
  refetch on mount/focus/reconnect). Anything the server computes at read time
  is automatically "live" under this model.
- **agentId → repoRoot is canonical.** The MCP route resolves each agent's
  brain scope via `resolveRepoRoot(agent.cwd)`
  (`apps/server/src/routes/mcp.ts`), which normalizes worktrees to the main
  repo root via `git-common-dir`
  (`apps/server/src/shared/git/git-context.ts`). A surface's owning agent
  unambiguously determines which brain its bindings read.
- **The stored surface document is whole-blocks JSONB + revision**
  (`apps/server/src/db/migrations/0043_agent-surfaces.sql`), updated only by
  owner whole-document replace with `expectedRevision`
  (`apps/server/src/surfaces/service.ts`).
- **Schema v2 (#1017) shipped the item-level machinery.** List items carry
  freeform `status` + `tone`, `checked`, `url`, `group`, and a per-item
  `action`; table rows carry per-row actions; interactions address
  `blockId + itemId + actionId`, and `validateAndCapture` snapshots
  `{block, item, action}`. Sections (titled containers, ≤4 deep, ≤20 children)
  exist; caps are 100 top-level + 100 nested blocks.
- **BrainStore's query surface is the menu of bindable sources**
  (`apps/server/src/brain/store.ts`): `getObject`, `listObjects`
  (collection + namePrefix + updatedAfter + limit ≤ 200), `getListItems`.

## Core decisions

### 1. Pull, not push: hydrate at read time

A block with a `binding` stores only the binding **spec**. Hydration happens
server-side in `SurfaceService.list()/get()`: the service queries BrainStore
with the owner's repoRoot and returns the block with hydrated items on the
wire. The stored document never contains bound content.

Freshness rides the existing event: extend the `brain.changed` handler in
`use-sse.ts` to also invalidate the `["agent-surfaces"]` query prefix. React
Query refetches only actively-observed queries (the open sidebar), so this is
one line of client code and no new server plumbing. Net effect is push-shaped
liveness with pull mechanics.

**Push (materializing bound content into the stored document) was considered
and rejected.** Materialization rewrites `blocks` outside the owner's
`expectedRevision` loop: either every brain write bumps the surface revision
(the owner's next update perpetually 409s against revisions it never saw) or
materialized writes skip the revision check (silently clobberable). Pull keeps
the invariant _stored document = authored spec; revision = authored revision_,
which is what makes the ownership question disappear entirely. Since the client
re-fetches whole payloads anyway, push buys nothing except that broken
contract.

### 2. Server-side hydration, not client-side

The web client _can_ read brain data directly (`routes/brain.ts` backs the
brain browser UI), so this is not an access question. Server-side wins because
the server must run the transform anyway for three consumers:

- **Interaction validation** — a click on a bound item must be validated
  against the hydrated document; the client cannot be trusted to assert which
  ids exist.
- **Non-owner/agent readers** — `dispatch_surface_get` on a child's surface
  should show what the user sees.
- **Freeze snapshots** (below).

Client-side binding would be a second implementation of the same transform
whose drift shows up as interaction failures, and worktree → repoRoot
normalization is server-side knowledge (`git-common-dir`).

### 3. Ownership: the owner authors the spec, never the bound content

Bound content is a read-time view. Brain data changing does not touch the
surface revision; `dispatch_surface_update`'s whole-document replace +
`expectedRevision` works unchanged. Because bound content never enters the
revision stream, a user acting on a live board never hits spurious
"surface changed, reload" conflicts — `baseRevision` only trips on actual
spec edits.

### 4. Read-path rule: owners read the template; renderers read the hydration

The owner's edit loop (`get` → modify → `update`) must be read-your-writes on
the _authored spec_: `dispatch_surface_get`/`list` for the owner return the
stored template — the thing `revision` refers to and the only thing `update`
accepts. Otherwise the natural get→edit→update cycle would round-trip
_hydrated_ content back in as authored spec, silently destroying the binding.

- Web GET route: always hydrates.
- Non-owner MCP reads: hydrated by default (read-only consumers).
- Owner MCP reads: template by default; `hydrated: true` opts into a render
  preview; the template response carries cheap per-block hydration metadata
  (record count, last source update) for sanity-checking without a full
  render.
- Backstop: instantiated ids (phase 2) use a separator reserved out of the
  authored id grammar, so feeding a hydrated document back into
  `update`/`create` fails schema validation loudly instead of being stored.

Tool descriptions should teach the source-vs-compiled-output mental model:
you edit the template; you don't decompile the render.

### 5. Write-back through interactions: deferred, deliberately

The existing loop already closes the circle with correct attribution:
interaction → owning agent claims → agent writes brain with its own tools +
`expectedRevision` → `brain.changed` → bound surface refreshes. Direct
browser→brain write-back would need a new authorization story (brain writes
are attributed to an agentId; the browser has none) and would bypass the
optimistic-concurrency contract other agents rely on. Not needed for
auto-update; revisit as its own idea if demand appears.

## Phase 1: item-level binding on list and table blocks

An optional `binding` field on `list` and `table` blocks. Not a new block
type — presentation stays the block's; binding replaces the authored
`items`/`rows` as the data origin.

```jsonc
{
  "id": "backlog",
  "type": "list",
  "title": "Backlog",
  "binding": {
    "source": { "kind": "objects", "collection": "dispatch-ideas" },
    // also {kind: "object", collection, name} and {kind: "list", collection, name}
    "where": [{ "path": "value.status", "equals": "idea" }],
    "map": {
      "id": "name",
      "text": "value.title",
      "detail": "value.summary",
      "status": "value.status",
      "url": "value.pr",
      "group": "value.status",
    },
    "tones": { "idea": "info", "shipped": "success" },
    "itemAction": {
      "id": "promote",
      "label": "Promote",
      "intent": "promote-idea",
    },
    "orderBy": { "path": "updatedAt", "direction": "desc" },
    "limit": 50,
  },
  "items": [],
}
```

### Mapping semantics

- **Dot-path extraction only.** Paths are split on `.` and walked by plain
  property access against the record as BrainStore returns it — metadata
  columns included (`name`, `updatedAt`, `value.title`, `value.meta.owner`).
  No expressions, no conditionals, no string templates. Anything the map
  cannot express is solved by reshaping the brain data (the agent has full
  code-level power there); the transform pressure goes into the data, not
  into a template language.
- **Defined by the owning agent at bind time.** Brain values are freeform
  JSON; fixed per-shape conventions would be guesswork.
- **Coercion and clamping.** Extracted strings pass through; numbers/booleans
  stringify; objects/arrays are treated as a miss. Values clamp to the block
  schema's existing caps (500-char item text, etc.). A record whose `text`
  path misses renders as a degraded fallback item (e.g. its name) rather than
  being dropped — a record that didn't map should be visible, not lost.
- **Ids.** Brain object `name` is the natural stable item id (sanitized to the
  surface id grammar). For list sources, see "brain list item ids" below.
- **Filtering/ordering.** `where` is equality-only on dot-paths, applied
  post-fetch in server JS (≤200 rows). `orderBy` is a dot-path + direction.
  The kanban case is several blocks binding the same collection with different
  `where` values — or one block using `map.group` for v2's in-block
  sub-headings. The hydrator fetches each distinct source once per request and
  filters per block.
- **Tones.** `tones` is a `{statusValue: tone}` lookup, deliberately the same
  shape as the table column `badgeVariants` idiom.

### Interactions on bound items

`binding.itemAction` declares one static action applied to every hydrated
item. A click arrives through the existing v2 path with `itemId` = the brain
record id — no composed-id machinery needed. `validateAndCapture` must run
against the **hydrated** document (render and validation are both server-side
reads of the same `get()`), and the hydrator stamps the record's brain
identity (collection, name/itemId, brain revision) into the
`definition_snapshot` so the resolving agent knows exactly which record was
acted on and can detect staleness. Race behavior: record deleted between
render and click → item absent from fresh hydration → clean 400 → client
refetches.

### Lifecycle

- **Frozen surfaces** (`freezeForArchive`): at freeze time, materialize bound
  blocks into the stored JSONB as a one-time snapshot. Frozen = static
  archive; this is the only moment materialization is correct. Without it, a
  frozen surface would keep tracking live data or read a dead agent's brain.

### Companion changes shipped with phase 1

- **BrainStore change notification unification.** `publishBrainChanged`
  currently fires only on the agent-MCP path; the web brain-browser's delete
  endpoints (`routes/brain.ts`) and future writers (jobs) bypass it. Move
  notification into `BrainStore` itself (optional onChange callback on the
  constructor) so every write path notifies uniformly.
- **Stable ids for brain list items.** List items have only `item_index`, and
  removal compacts/renumbers the list (`store.ts` reindex), so index is
  identity-by-position — unusable as a bound record id and racy for
  `brain_list_remove`/`set` even today. Add `item_id` to `brain_list_items`
  (`itm_<uuid>`, server-generated on insert, migration backfills), exposed as
  `id` on reads and accepted as an addressing option in remove/set. Agents
  never specify or manage it. Without this, list sources are display-only.
- **repoRoot resolution caching.** The surfaces GET needs agent.cwd →
  repoRoot; `resolveRepoRoot` spawns git, so cache per agentId. This is the
  one real perf wrinkle of pull hydration.

## Phase 2: repeated card templates (`repeat` on section blocks)

For records that deserve a true multi-block card (progress bars, several
fields, mixed block types), a `section` block may carry
`repeat: { source, where, orderBy, limit }`; its authored children are a
**template subtree**, each child carrying an optional `map` of
field-name → dot-path evaluated per record. Hydration instantiates the subtree
once per record, entirely server-side — the client receives a plain section
with N ordinary child subtrees and needs no templating awareness.

Rules that make this safe:

- **Instance ids** compose deterministically:
  `<sectionId>__<recordId>__<templateChildId>`, with the separator reserved
  out of the authored id grammar (the read-path backstop above).
- **Caps**: authored-block caps apply to authored blocks; instantiated volume
  is bounded separately (repeat limit ≤ 50 × template children ≤ ~6, total
  instantiated ceiling ~300 per surface, enforced at hydration).
- **Section titles** are required and always visible in v2, so a repeat
  section's per-instance title must be mappable.
- Interaction validation against the hydrated document covers instantiated
  cards the same way as bound items.

Phase 2 is demoted (not dropped) because v2's richer list items — status,
tone, url, group, per-item action — cover most board-shaped cases with plain
item binding.

## Deferred (out of scope until demand is real)

- Interaction write-back directly to brain data (see decision 5).
- Event-log bindings (`queryEvents` with the same map shape is viable later).
- Markdown template interpolation inside text bodies.
- Arbitrary query predicates pushed into SQL.
- Cross-repo binding.
- Precise per-surface server-side invalidation (repoRoot → bound-surface
  index publishing `surface.changed`); the coarse client-side invalidation is
  fine at current scale.

## Expected user-visible behavior (summary)

A bound surface looks identical to an authored one, but: any agent's brain
write moves the board within a beat (SSE → invalidate → refetch → re-render),
including while the owning agent sleeps; clicking a bound item's action shows
the normal pending → resolved interaction flow, and the card visibly moves
when the owning agent's brain write lands; data churn never causes
"reload before submitting" conflicts; archiving freezes the board into a
static snapshot with actions disabled.

## Implementation shape (rough)

- Zod `binding` (+ phase 2 `repeat`) schemas in `apps/server/src/surfaces/types.ts`
  and shared wire types in `packages/shared`.
- A hydrator module in `apps/server/src/surfaces/` taking `BrainStore` + a
  cached agentId→repoRoot resolver; wired into `SurfaceService.list/get` and
  `submitInteraction`.
- Read-path plumbing: owner-vs-renderer document selection, `hydrated: true`
  option, per-block hydration metadata.
- ~1 line in `apps/web/src/hooks/use-sse.ts` (invalidate `["agent-surfaces"]`
  on `brain.changed`).
- `BrainStore` onChange callback; publish call sites simplified.
- Freeze-time materialization in `freezeForArchive`.
- One brain migration: `item_id` on `brain_list_items` + tool support.
- No surface-side migration: bindings live inside the existing `blocks` JSONB.
