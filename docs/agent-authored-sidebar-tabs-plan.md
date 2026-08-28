# Agent-authored sidebar tabs

Status: MVP implemented in this worktree; ready for hands-on iteration  
Updated: 2026-08-27

## Decision summary

The first surface is a tall, narrow tab inside the existing per-session right sidebar. V1 should be designed and tested at roughly 360–440px wide as a one-column document, not as a general canvas or page builder.

V1 includes rich content leaves, action buttons, and structured forms. Interactions use a durable inbox: Dispatch validates and persists a click or submission before notifying the owning agent. Busy or stopped agents therefore do not lose user input.

First-class kanban behavior is deferred. The earlier exploration overfit that example by proposing a dedicated board block, server-owned card placement, WIP limits, and board-specific events. Kanban remains useful evidence for a possible future generic movable-collection capability, but it is not a V1 primitive.

Pins remains a fixed special system tab with its existing tools and storage. Custom tabs use a separate surface model and tool family.

## V1 boundaries

V1 supports:

- text and constrained markdown;
- lists and check-style work summaries;
- compact tables;
- status and progress indicators;
- buttons and action groups;
- single-column forms with text, textarea, select, radio, checkbox, and number fields;
- whole-document agent updates with optimistic concurrency;
- durable action and form delivery while the owner is idle, busy, stopped, or resumed later.

V1 does not support:

- arbitrary nested containers or freeform grid layout;
- multi-column authored layouts inside the pane;
- board/kanban blocks, drag-and-drop, user-reordered collections, or WIP limits;
- agent-authored HTML, CSS, JavaScript, callbacks, or network requests;
- conditional expressions, modal trees, charts, carousels, or embedded web content;
- cross-agent shared editing.

The restriction to one vertical flow is deliberate. Individual leaves may adapt to the rail—buttons can stack, tables can scroll or collapse secondary columns—but agents do not author responsive layout rules.

## Schema

Stable IDs are required for tabs, blocks, fields, options, and actions because an interaction must address the definition the user actually saw.

```ts
type SurfaceTab = {
  schemaVersion: 1;
  id: string; // server-issued: tab_...
  ownerAgentId: string;
  title: string; // 1..32 characters
  icon?: SurfaceIcon; // fixed allowlist
  revision: number; // authored-document revision
  lifecycle: "active" | "frozen";
  blocks: SurfaceBlock[]; // ordered, maximum 40
  createdAt: string;
  updatedAt: string;
};

type SurfaceIcon =
  | "layout"
  | "list"
  | "table"
  | "checklist"
  | "message"
  | "flag"
  | "clock"
  | "sparkles"
  | "form";

type SurfaceBlock =
  | TextBlock
  | ListBlock
  | TableBlock
  | StatusBlock
  | ProgressBlock
  | ActionsBlock
  | FormBlock;

type BlockBase = {
  id: string;
  title?: string; // 1..80 characters
  description?: string; // inline markdown, <= 240 characters
};
```

### Rich leaf blocks

```ts
type TextBlock = BlockBase & {
  type: "text";
  text: string; // constrained markdown, <= 8,000 characters
};

type ListBlock = BlockBase & {
  type: "list";
  style?: "bullet" | "number" | "check";
  items: Array<{
    id: string;
    text: string; // inline markdown, <= 500 characters
    state?: "pending" | "active" | "done" | "blocked";
    detail?: string; // inline markdown, <= 240 characters
  }>; // maximum 100
};

type Scalar = string | number | boolean | null;

type TableBlock = BlockBase & {
  type: "table";
  columns: Array<{
    id: string;
    label: string;
    format?: "text" | "number" | "date" | "badge" | "code" | "url";
    badgeVariants?: Record<string, Tone>; // <= 50 entries; key <= 200 chars
    align?: "left" | "center" | "right";
    priority?: "primary" | "secondary";
  }>; // 1..6 columns
  rows: Array<{
    id: string;
    cells: Record<string, Scalar>;
  }>; // maximum 100 rows
};

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

type StatusBlock = BlockBase & {
  type: "status";
  status: string; // 1..40 visible characters
  tone?: Tone;
  detail?: string; // constrained markdown, <= 1,000 characters
  timestamp?: string; // ISO 8601
};

type ProgressBlock = BlockBase & {
  type: "progress";
  value: number;
  max: number; // > 0
  label?: string;
  detail?: string;
  tone?: Exclude<Tone, "danger">;
};
```

Table cell strings are limited to 500 characters. `badgeVariants` is optional
and only valid for `badge` columns. It assigns a
semantic tone to a displayed badge value while retaining scalar table cells,
which keeps existing authored table documents backwards-compatible.

Status blocks render as unboxed informational readouts—a semantic dot, status
text, optional timestamp, and detail—so they do not imply button or text-input
affordances. An unspecified progress tone renders as `success`; agents select
another tone only when progress is informational, neutral, or waiting.

Table priority is a sidebar-specific affordance, not a responsive breakpoint: the rail is a fixed width, so `secondary` columns always render behind a per-row disclosure and `primary` columns (the default) always render inline. Agents state meaning, not pixel layout—mark a column `secondary` only for verbose diagnostics, never for a value the user needs to compare at a glance (a decision-critical risk/status badge stays `primary`).

Markdown supports paragraphs, emphasis, inline/fenced code, links, and flat lists. It excludes raw HTML, embedded images, and markdown tables; typed blocks provide predictable narrow-pane rendering.

### Actions and forms

```ts
type ActionRef = {
  id: string;
  label: string; // 1..48 characters
  intent: string; // stable agent-facing name, 1..80 characters
  style?: "default" | "primary" | "destructive";
  icon?: SurfaceIcon;
  confirm?: {
    title: string;
    description?: string;
  };
  disabled?: boolean;
  disabledReason?: string;
};

type ActionsBlock = BlockBase & {
  type: "actions";
  layout?: "auto" | "stack";
  actions: ActionRef[]; // 1..6
};

type FormField =
  | {
      id: string;
      type: "text" | "textarea";
      label: string;
      description?: string;
      required?: boolean;
      placeholder?: string;
      defaultValue?: string;
      minLength?: number;
      maxLength?: number;
    }
  | {
      id: string;
      type: "select" | "radio";
      label: string;
      description?: string;
      required?: boolean;
      multiple?: boolean; // select only
      options: Array<{
        value: string;
        label: string;
        description?: string;
        disabled?: boolean;
      }>;
      defaultValue?: string | string[];
    }
  | {
      id: string;
      type: "checkbox";
      label: string;
      description?: string;
      required?: boolean;
      defaultValue?: boolean;
    }
  | {
      id: string;
      type: "number";
      label: string;
      description?: string;
      required?: boolean;
      min?: number;
      max?: number;
      step?: number;
      defaultValue?: number;
    };

type FormBlock = BlockBase & {
  type: "form";
  fields: FormField[]; // 1..20, always one column
  submit: ActionRef;
  resetLabel?: string; // local draft reset; emits no interaction
  submitMode?: "once" | "repeatable";
};
```

`auto` actions may place two short actions in one row at normal sidebar width, but the renderer stacks them when labels, touch targets, or viewport width require it. `stack` always renders one action per row. This is a bounded renderer decision, not general composition.

## Composition

The tab body is one vertical sequence. V1 has no Section, Container, Columns, Grid, Card, or recursively nested block.

Semantic child arrays are permitted only where the renderer owns the whole structure: list items, table rows, actions, form fields, and choice options. This keeps addressing, accessibility order, validation, and responsive behavior bounded.

A title and description on every block provides enough visual grouping for V1. If usage later proves tabs need collapsible sections, add one single-level `SectionBlock` deliberately rather than beginning with a generic tree.

## Authoring tools

```ts
dispatch_surface_create({
  title,
  icon?,
  blocks
}) -> { tabId, revision }

dispatch_surface_update({
  tabId,
  expectedRevision,
  title?,
  icon?,
  blocks?,
  resolveInteraction?: {
    id: string,
    outcome: "completed" | "rejected",
    message?: string
  }
}) -> { revision }

dispatch_surface_list({ ownerAgentId? }) -> tab summaries
dispatch_surface_get({ tabId }) -> tab plus unresolved-interaction count
dispatch_surface_delete({ tabId, expectedRevision, force? })
```

V1 uses whole-document replacement, not JSON Patch. Documents are tightly capped, and one `expectedRevision` is easier for an agent to reason about than paths inside a mutable tree. `dispatch_surface_update` may atomically change the document and resolve one interaction.

## Drafts and persisted input

Three ownership domains stay separate:

1. The agent owns the document definition: blocks, labels, validation, and action intents.
2. Dispatch owns submitted interaction records.
3. Unsubmitted form drafts are local persisted UI state keyed by tab and form block.

Typing does not notify the agent. Submit validates and stores one normalized interaction. Drafts survive tab switching and reload, then clear after successful submission or explicit Reset.

There is no generic server-owned mutable surface state in V1. That concept was introduced solely for the earlier board design and is deferred with movable collections.

## Interaction contract

The browser never sends an arbitrary prompt. It sends stable IDs and validated values against the stored definition.

```ts
type InteractionRequest =
  | {
      idempotencyKey: string;
      kind: "action";
      blockId: string;
      actionId: string;
      baseRevision: number;
    }
  | {
      idempotencyKey: string;
      kind: "form_submit";
      blockId: string;
      actionId: string;
      values: Record<string, Scalar | string[]>;
      baseRevision: number;
    };
```

The server resolves the referenced block and action from the current document, validates values and disabled state, captures the visible context, and persists an immutable event before attempting delivery.

```ts
type SurfaceInteraction = {
  schemaVersion: 1;
  id: string; // ix_...
  agentId: string;
  tabId: string;
  tabRevision: number;
  kind: "action" | "form_submit";
  intent: string;
  payload: object;
  definitionSnapshot: object;
  status:
    | "queued"
    | "notified"
    | "claimed"
    | "completed"
    | "rejected"
    | "cancelled"
    | "orphaned";
  outcomeMessage?: string;
  createdAt: string;
  claimedAt?: string;
  resolvedAt?: string;
};
```

The interaction union is versioned and additive. A future movable-collection design could introduce `collection_move` without changing action/form semantics, but V1 does not reserve or pretend to implement it.

Delivery behavior:

- Running and idle: persist first, then inject a small trusted notification containing only the interaction ID.
- Running and mid-turn: persist immediately; notify at the next safe injection boundary and coalesce multiple notices.
- Stopped or setup failed: accept and keep queued; explain that delivery waits for resume.
- Resumed: send one coalesced notification; the agent explicitly reads the queue.
- Archived: freeze tabs read-only, reject new interactions, and mark unresolved records orphaned.

Receiving tools:

```ts
dispatch_surface_interactions({ tabId?, status?, limit? })
dispatch_surface_claim({ ids })
dispatch_surface_resolve({
  id,
  outcome: "completed" | "rejected",
  message?
})
```

The HTTP response means Dispatch persisted the interaction, not that the agent completed it. The UI shows Queued, Seen, Completed, Rejected, Cancelled, or Orphaned. Idempotency keys prevent duplicate work; stale `baseRevision` requires the user to review the current tab before resubmitting.

This is an inbox model, not RPC. Nothing depends on a three-second agent acknowledgement.

## Lifecycle and ownership

- Only the owning agent creates, renames, replaces, freezes, or deletes its tabs.
- The user activates, reorders, pins-to-visible, hides, and restores them. User close means hide, not delete.
- Agent deletion requires `expectedRevision`. It fails with unresolved interactions unless `force` is explicit; forced deletion cancels them.
- The UI shows tabs for the focused agent only.
- A parent agent may list/get direct-child tabs and interaction summaries read-only, but cannot mutate or resolve them.
- Stopping preserves tabs and permits interactions to queue.
- Archiving freezes a read-only snapshot and marks unresolved interactions orphaned.
- Cross-agent shared tabs are deferred.

## Pins and system tabs

Pins remains a fixed permanent system tab. `dispatch_pin` and `dispatch_pins` continue writing only to Pins. Custom tabs use `dispatch_surface_*`. Storage and API contracts stay separate, though rendering and validation helpers may be reused internally.

Media, Reviews, and Messages also remain system-owned. System tabs cannot be renamed or deleted; custom tabs can be hidden and reordered by the user.

## Sidebar tab clutter

The existing header is already dense:

- allow at most 8 active custom tabs per agent in V1;
- render every non-hidden custom tab in a horizontally scrollable second row;
- keep the management menu fixed outside the scroll area so it stays reachable;
- use the management menu for selection, local ordering, and hiding—not as the
  only route to tabs beyond an arbitrary visible cap;
- persist active tab, visible order, and hidden choices per user and agent ID;
- truncate titles visually while keeping full accessible labels and tooltips;
- show pending badges on visible tabs and in management for hidden tabs with
  unresolved work.

### MVP ordering and control model

System and custom tabs use separate ordering domains:

1. Dispatch owns the fixed system-tab order. V1 keeps Pins, Media, Reviews, and Messages in their existing order and renders custom surfaces in a second compact row.
2. The owning agent controls the canonical order of its custom tabs. Each surface has a server-side `sortOrder`, and the surface MCP API exposes a reorder operation that replaces the ordered list atomically.
3. The user may layer a local presentation order over that canonical order for each agent. The UI offers Move tab earlier, Move tab later, Hide tab, and Reset tab order. These preferences persist locally by agent ID and never rewrite the agent's canonical order. These controls affect only the horizontal custom-tab strip; they do not move work items or introduce kanban behavior.

New custom tabs append to the agent's canonical order. When a user has a local override, tabs absent from that override append after known tabs in canonical order so newly created work remains discoverable.

All non-hidden custom tabs render directly in a horizontal scroll strip. The
active tab scrolls into view when selected. Hidden tabs remain reachable through
the management menu, which closes after selecting a tab. Unresolved interaction
badges remain visible in management so queued work cannot disappear.

An agent may rename, reorder, or delete only its own custom tabs. A parent retains read-only visibility into direct-child surfaces; it cannot change their order. User presentation choices are not visible to agents because they do not change document meaning.

## Example: release choice

The surface is a vertical sequence: status, compact table, then stacked actions.

```json
{
  "schemaVersion": 1,
  "title": "Release choice",
  "blocks": [
    {
      "id": "context",
      "type": "status",
      "status": "Ready for decision",
      "tone": "info",
      "detail": "Both paths passed CI. Canary reduces blast radius."
    },
    {
      "id": "comparison",
      "type": "table",
      "columns": [
        { "id": "option", "label": "Option", "priority": "primary" },
        { "id": "time", "label": "Time", "priority": "primary" },
        {
          "id": "risk",
          "label": "Risk",
          "format": "badge",
          "priority": "primary"
        }
      ],
      "rows": [
        {
          "id": "canary",
          "cells": { "option": "Canary", "time": "~30 min", "risk": "Lower" }
        },
        {
          "id": "direct",
          "cells": { "option": "Direct", "time": "~8 min", "risk": "Higher" }
        }
      ]
    },
    {
      "id": "choices",
      "type": "actions",
      "layout": "stack",
      "actions": [
        {
          "id": "canary",
          "label": "Use canary",
          "intent": "choose_release_canary",
          "style": "primary"
        },
        {
          "id": "direct",
          "label": "Release directly",
          "intent": "choose_release_direct",
          "style": "destructive",
          "confirm": {
            "title": "Release directly?",
            "description": "This skips the observation window."
          }
        },
        {
          "id": "revise",
          "label": "Revise plan",
          "intent": "revise_release_plan"
        }
      ]
    }
  ]
}
```

## Example: structured feedback

Fields are one column with full-width tap targets. The form scrolls naturally inside the pane; submit remains in document flow.

```json
{
  "schemaVersion": 1,
  "title": "Review feedback",
  "blocks": [
    {
      "id": "status",
      "type": "status",
      "status": "Ready for review",
      "tone": "success",
      "detail": "Focus on hierarchy and interaction flow."
    },
    {
      "id": "feedback",
      "type": "form",
      "title": "What should change?",
      "fields": [
        {
          "id": "decision",
          "type": "radio",
          "label": "Overall direction",
          "required": true,
          "options": [
            { "value": "approve", "label": "Keep this direction" },
            { "value": "revise", "label": "Revise it" },
            { "value": "restart", "label": "Try another direction" }
          ]
        },
        {
          "id": "notes",
          "type": "textarea",
          "label": "Specific notes",
          "required": true,
          "minLength": 5,
          "maxLength": 2000
        }
      ],
      "submit": {
        "id": "submit",
        "label": "Send feedback",
        "intent": "submit_design_feedback",
        "style": "primary"
      },
      "resetLabel": "Clear draft",
      "submitMode": "repeatable"
    }
  ]
}
```

## Example: release work without a board

This retains what the kanban exploration taught us—status clarity, structured items, and useful next actions—without movable or multi-column behavior.

```json
{
  "schemaVersion": 1,
  "title": "Release work",
  "blocks": [
    {
      "id": "readiness",
      "type": "progress",
      "title": "Release readiness",
      "value": 5,
      "max": 8,
      "label": "5 of 8 complete",
      "tone": "info"
    },
    {
      "id": "work",
      "type": "list",
      "title": "Work items",
      "style": "check",
      "items": [
        {
          "id": "schema",
          "text": "Finalize interaction schema",
          "state": "active",
          "detail": "Design agent"
        },
        {
          "id": "builder",
          "text": "Launch builder",
          "state": "pending",
          "detail": "Ready after approval"
        },
        {
          "id": "a11y",
          "text": "Accessibility review",
          "state": "blocked",
          "detail": "Waiting for prototype"
        },
        { "id": "release", "text": "Release", "state": "pending" }
      ]
    },
    {
      "id": "actions",
      "type": "actions",
      "layout": "stack",
      "actions": [
        {
          "id": "blockers",
          "label": "Review blockers",
          "intent": "review_release_blockers"
        },
        {
          "id": "approve",
          "label": "Approve implementation",
          "intent": "approve_surface_implementation",
          "style": "primary"
        }
      ]
    }
  ]
}
```

If users later need to move these items among statuses, that is evidence for a generic movable-collection feature. V1 should not simulate it through ad hoc buttons or hidden state mutations.

## Future movable collections

A later design should begin from generic semantics rather than a board-specific block:

- a collection of stable-ID items;
- named views or groups;
- explicit ordering and placement state;
- `collection_move` and `collection_reorder` interactions;
- optimistic concurrency for simultaneous agent/user updates;
- mouse/touch drag-and-drop plus equivalent keyboard controls;
- clear behavior while the agent is stopped;
- a deliberate narrow-pane presentation, likely one group at a time rather than squeezed columns;
- optional rules such as allowed destinations or group limits.

None of these fields or behaviors belong to `schemaVersion: 1`. They are requirements for a later design pass if usage calls for movable collections.

## Delivery sequence

1. Foundation: persist tabs and interactions; revisioned CRUD; SSE updates; horizontally scrollable vertical-rail tabs; frozen archive snapshots.
2. Read-only leaves: text, list, table, status, and progress, with explicit 360–440px rendering tests.
3. Durable actions: queued/claimed/resolved behavior, idempotency, confirmation, stopped/resumed delivery.
4. Forms: local persisted drafts, validation, structured submission, outcome UI, and accessibility.
5. Evaluate: measure tab counts, document size, interaction latency, conflicts, form completion, and which missing layouts users actually request.

Do not add a partial kanban implementation to V1. If movable collections become a priority, treat them as their own vertical slice after the core surface proves useful.

## MVP acceptance criteria

The first testable build is meaningful when all of the following work end to end:

- An agent can create, read, replace, reorder, and delete its own custom tabs through MCP tools.
- A focused agent's custom tabs appear in the existing right sidebar without changing Pins, Media, Reviews, or Messages behavior.
- The sidebar renders every V1 block type at approximately 400px wide without page-level horizontal overflow.
- All non-hidden custom tabs remain directly reachable through horizontal scrolling; hidden tabs remain reachable through management, and selecting one closes the menu.
- A user's move-tab-earlier, move-tab-later, hide-tab, and reset-tab-order choices survive reload for that agent without changing the canonical order returned by the server.
- A button click persists one idempotent interaction and shows Queued without claiming the agent completed it.
- A form rejects invalid input, preserves its local draft across tab switches/reload, and submits normalized structured values as one interaction.
- A running owner is notified with an interaction reference rather than interpolated user input; a stopped owner retains queued work for later retrieval.
- The owning agent can list, claim, complete, or reject interactions. Completion may atomically update the surface document.
- Frozen/archived surfaces are readable but reject new interactions, and unresolved interactions become orphaned rather than disappearing.
- Desktop and mobile sidebar flows are keyboard accessible and covered by Playwright interaction tests.
