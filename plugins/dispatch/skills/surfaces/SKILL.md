---
name: surfaces
description: Present structured or interactive work in an agent-authored Dispatch sidebar tab. Use when the user would benefit from persistent status, progress, options, compact tables, action buttons, data-entry forms, approvals, intake, or a lightweight workflow view that is richer than a pin or chat message.
---

# Agent surfaces

Use surfaces for compact, task-specific UI that stays beside the agent session.
The owning agent authors the document and handles every submitted interaction.

## When a surface is the right channel

A surface earns its place when several related values need hierarchy, repeated
updates, or user input. One small fact belongs in a pin, an artifact belongs in
`dispatch_share_file`, and explanation belongs in your reply — do not mirror the
transcript into a surface. The full channel comparison lives in `communicate`.

Prefer one useful tab over several narrow tabs. A surface is a fixed 400px
vertical pane. There is no kanban or drag-and-drop primitive; express
lightweight workflow with lists, statuses, tables, and slot actions.

## Document geography (slots)

Every surface shares one layout, so users always know where to look:

- `header` _(optional)_ — the headline: a `status` and/or `progress` block.
  It renders first, above everything.
- `blocks` — the body content.
- `footer` _(optional)_ — `{ actions: [...] }`, THE home for the surface's
  verbs. The renderer draws it as a compact split button: the primary verb is
  the visible button and the rest live in a chevron menu, destructive verbs
  last.

Sections carry their own optional `actions` footer for verbs scoped to that
group ("Queue migration" at the bottom of the release-details card). List
items and table rows take `actions` too: one renders as a quiet inline
affordance on the title row, two or more collapse into a per-item ⋯ menu.
There is no standalone actions block — actions always live in one of these
slots, and the renderer owns their placement and visual weight.

## The design contract

The renderer owns styling — supply meaning, not layout:

- **One `primary` action per surface.** Leave the rest `default`. Use
  `destructive` only for irreversible verbs, always with `confirm`; it renders
  quietly and sits in the overflow menu on purpose.
- **Color means state.** Use tone `neutral` for categories (environment, repo,
  owner) — it renders as plain text. Reserve `danger`/`warning` for
  exceptions; healthy states render dim so the one failing value owns the
  color budget.
- **Write human labels** ("Rolled back"), never enum tokens (`ROLLED_BACK`).
- **Tables fit 3 visible columns.** Mark extras `priority: "secondary"` — they
  collapse behind a per-row disclosure. A 2-column table renders as a
  key/value stat list automatically, so use one for metrics.
- **Repeating one action label down a list is fine** — identical verbs render
  as a compact column of affordances, not a stack of buttons.
- **`text` takes a `tone`.** Use it for the one sentence that changes a
  decision (risk notes, blocking caveats); leave ordinary prose untoned.
- **Timestamps are ISO strings**; the renderer formats them (relative under a
  week, absolute on hover). Don't pre-format dates into prose.
- **Collapse finished work, never the thesis.** A "Done" section starts
  `collapse: { initiallyCollapsed: true }`; the root cause of a postmortem
  does not.

## Authoring workflow

1. Call `dispatch_surface_create` with a short title, optional icon, optional
   `header`/`footer`, and stable, unique block/item/action/field IDs.
2. Keep the returned `tabId` and `revision`.
3. Call `dispatch_surface_get` before an update if the current revision is not
   known, then call `dispatch_surface_update` with `expectedRevision`. Updates
   replace the complete `blocks` array; `header` and `footer` accept `null` to
   clear the slot.
4. Treat interaction notices as wake-ups only. Read durable values with
   `dispatch_surface_interactions`, claim them with `dispatch_surface_claim`,
   perform the work, then call `dispatch_surface_resolve`.
5. Update the surface after processing an interaction so the visible state
   reflects the outcome.

Interactions remain queued when the owner is idle or stopped and are surfaced
when it resumes. Never infer submitted values from the injected notice.
Footer actions arrive with the reserved `blockId` `"footer"`; section actions
carry the section's id; item and row actions carry `blockId` + `itemId`.

```javascript
dispatch_surface_interactions({ tabId: "<tab id>", status: "queued" });
dispatch_surface_claim({ ids: ["<interaction id>"] });
dispatch_surface_resolve({
  id: "<interaction id>",
  outcome: "completed",
  message: "Recorded the canary decision.",
});
```

Freeze a surface when it should remain readable but stop accepting input. Delete
only when it no longer has durable value. Owners can edit their own surfaces;
parents may read a direct child's surfaces but cannot edit them. A tab authored
under an older schema version renders a "recreate this tab" notice — recreate it
with a current document rather than patching it.

## Block palette

- `text`: short Markdown explanation or result; optional `tone` renders a
  callout for decision-critical prose.
- `status`: one current state, semantic tone, detail, and optional ISO
  timestamp (rendered inline, relative).
- `progress`: bounded progress; the bar is neutral by default and shows its
  percentage — pair it with a `label` like "5 of 8 complete".
- `list`: bullets, numbered steps, or checklist items. Items may carry a
  freeform `status` plus semantic `tone` (not a closed state enum), an
  independent `checked` boolean for check-style lists, a safe `url` (the title
  becomes the link), a `group` subheading, and `actions` (1 inline, 2+ in a
  ⋯ menu). Use `collapse: { after, label? }` for long lists and
  `showItemCount: true` when the total matters.
- `table`: compact repeated data; at most 3 primary columns, badge variants
  for semantic values, `priority: "secondary"` for verbose diagnostics behind
  the per-row disclosure. When recency matters (deploy history, run logs),
  keep a relative-time column primary rather than demoting it — a history
  with no visible time cue is worse than one fewer data column. Two plain
  columns render as a key/value list. Rows take `actions` like list items.
- `form`: text, textarea, number, checkbox, radio, and single/multi-select
  input submitted together. The submit is always the form's primary action
  (no style knob) and renders full width; a trailing run of checkboxes
  renders as a grouped attestation gate. Use `submitMode: "once"` for
  decisions and approvals, `"repeatable"` for intake or ongoing feedback.
- `section`: a titled grouping container for related blocks; its label
  renders as a small-caps container heading. `title` is required; add
  `description` for context, `actions` for a group-scoped footer, and
  `collapse: { initiallyCollapsed: true }` to start closed. Sections nest
  four levels, hold 20 direct children, and surfaces allow 100 nested blocks
  in addition to the 100 top-level blocks.

## Use-case recipes

### Present options

Put the pending state in the header, the comparison in a table, and the
decision in the footer — or use one form when the user should also explain
their choice.

```json
{
  "title": "Release decision",
  "icon": "flag",
  "header": {
    "status": {
      "id": "state",
      "type": "status",
      "status": "Ready for decision",
      "tone": "info",
      "detail": "Both rollout paths passed CI."
    }
  },
  "blocks": [
    {
      "id": "paths",
      "type": "table",
      "title": "Release paths",
      "columns": [
        { "id": "option", "label": "Option" },
        { "id": "time", "label": "Time" },
        {
          "id": "risk",
          "label": "Risk",
          "format": "badge",
          "badgeVariants": { "Lower": "success", "Higher": "warning" }
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
    }
  ],
  "footer": {
    "actions": [
      {
        "id": "choose-canary",
        "label": "Use canary",
        "intent": "choose_release_canary",
        "style": "primary"
      },
      {
        "id": "choose-direct",
        "label": "Release directly",
        "intent": "choose_release_direct",
        "style": "destructive",
        "confirm": { "title": "Skip the canary observation window?" }
      }
    ]
  }
}
```

### Collect a decision with rationale

Use a repeatable form when the user must enter actual data rather than choose
one shortcut. A form's submit sends all field values together.

```json
{
  "title": "Design feedback",
  "icon": "form",
  "blocks": [
    {
      "id": "feedback",
      "type": "form",
      "title": "Share your review",
      "fields": [
        {
          "id": "direction",
          "type": "radio",
          "label": "Overall direction",
          "required": true,
          "options": [
            { "value": "keep", "label": "Keep this direction" },
            { "value": "revise", "label": "Revise it" }
          ]
        },
        {
          "id": "notes",
          "type": "textarea",
          "label": "Specific notes",
          "required": true,
          "placeholder": "What should change, and why?"
        }
      ],
      "submit": {
        "id": "send",
        "label": "Send feedback",
        "intent": "submit_feedback"
      },
      "resetLabel": "Clear draft",
      "submitMode": "repeatable"
    }
  ]
}
```

### Show progress and workflow

Header `progress` for the aggregate, a check-style `list` for the work, item
`actions` for the next step that belongs to exactly one item, and a section
`actions` footer for group verbs. Give an item a freeform `status` such as
`Waiting for approval` with `tone: "warning"`; use `checked: true` only when
that item is complete — never infer completion from the status label or tone.

### Request approval

Header `status` for the pending state, a `text` block with
`tone: "warning"` for the risk note, a form whose trailing checkboxes act as
the attestation gate, or a footer with one primary action and a destructive
alternative behind `confirm`. Set `disabled: true` with a visible
`disabledReason` when an action cannot run.

### Monitor a compact system

Header `status` for the headline, a table for services or checks with badge
tones reserved for the exceptions, secondary columns for diagnostics, and row
`actions` for per-service verbs (retry, mute, inspect).

## Interaction discipline

- Keep action `intent` and field IDs stable across revisions. Item and row
  actions use an item-scoped `itemId` in their durable interaction payload, so
  action IDs may repeat across different items but must remain stable per item.
- Claim before doing work so retries or resumed sessions cannot process the same
  interaction twice.
- Resolve with a short outcome message the UI can show.
- Reject invalid or no-longer-applicable requests explicitly rather than
  silently dropping them.
- Do not create a new tab for every update. Update the existing surface and keep
  its identity stable.
