---
name: surfaces
description: Present structured or interactive work in an agent-authored Dispatch sidebar tab. Use when the user would benefit from persistent status, progress, options, compact tables, action buttons, data-entry forms, approvals, intake, or a lightweight workflow view that is richer than a pin or chat message.
---

# Agent surfaces

Use surfaces for compact, task-specific UI that stays beside the agent session.
The owning agent authors the document and handles every submitted interaction.

## Choose the right surface

- Use a **pin** for one small fact the user may need to copy or revisit: a URL,
  port, branch, file, decision, or one shortcut.
- Use a **surface** when several related values need hierarchy, repeated updates,
  or user input.
- Use `dispatch_share_file` for a file, screenshot, report, or other artifact.
- Keep chat for explanation and conversation; do not mirror the transcript into
  a surface.

Prefer one useful tab over several narrow tabs. A surface is a vertical pane, so
keep tables compact, stack long actions, and avoid dashboard layouts that assume
desktop width. There is no kanban or drag-and-drop primitive; express
lightweight workflow with lists, statuses, tables, and actions.

## Authoring workflow

1. Call `dispatch_surface_create` with a short title, optional icon, and stable,
   unique block/item/action/field IDs.
2. Keep the returned `tabId` and `revision`.
3. Call `dispatch_surface_get` before an update if the current revision is not
   known, then call `dispatch_surface_update` with `expectedRevision`. Updates
   replace the complete `blocks` array.
4. Treat interaction notices as wake-ups only. Read durable values with
   `dispatch_surface_interactions`, claim them with `dispatch_surface_claim`,
   perform the work, then call `dispatch_surface_resolve`.
5. Update the surface after processing an interaction so the visible state
   reflects the outcome.

Interactions remain queued when the owner is idle or stopped and are surfaced
when it resumes. Never infer submitted values from the injected notice.

Use these interaction shapes:

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
parents may read a direct child's surfaces but cannot edit them.

## Block palette

- `text`: short Markdown explanation or result.
- `status`: one current state, semantic tone, detail, and optional timestamp.
- `progress`: bounded progress; omit `tone` for normal success-green progress.
- `list`: bullets, numbered steps, or checklist-like workflow states. Items may
  carry a freeform `status` plus semantic `tone` (not a closed state enum), an
  independent `checked` boolean for check-style lists, a safe `url`, a `group`
  subheading, and one `{ id, label, intent }` action.
  Use `collapse: { after, label? }` for long lists and `showItemCount: true`
  when the total matters.
- `table`: compact repeated data; use badge variants for semantic values.
  Set `showItemCount: true` when the total row count is useful context.
  Secondary columns are always collapsed behind a per-row disclosure, so mark
  a column `secondary` only for verbose diagnostics the user doesn't need to
  compare at a glance — a decision-critical value (a risk/status badge, the
  thing the user is choosing between) stays `primary` (the default) so it
  renders without an extra click.
- `actions`: up to six immediate commands with stable `intent` values; require
  confirmation for consequential actions.
- `form`: text, textarea, number, checkbox, radio, and single/multi-select input
  submitted together. Use `submitMode: "once"` for decisions and approvals,
  `"repeatable"` for intake or ongoing feedback.
- `section`: a titled grouping container for related blocks. Its `title` is
  required; add `description` for context. Set
  `collapse: { initiallyCollapsed: true }` when the renderer may hide its
  body while keeping the header visible. Without `collapse`, it is a static
  group. Sections may nest four levels, contain up to 20 direct children, and
  surfaces allow up to 100 nested blocks in addition to the 40 top-level
  blocks.

## Use-case recipes

### Present options

Pair context with actions. A table is useful when the choices have comparable
attributes. If the user may also enter a rationale, use one form with a radio
choice and optional textarea instead of adding an action that promises to open
text entry.

```json
{
  "title": "Release decision",
  "icon": "flag",
  "blocks": [
    {
      "id": "state",
      "type": "status",
      "status": "Ready for decision",
      "tone": "info",
      "detail": "Both rollout paths passed CI."
    },
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
    },
    {
      "id": "decision-form",
      "type": "form",
      "title": "Choose a rollout path",
      "fields": [
        {
          "id": "path",
          "type": "radio",
          "label": "Rollout path",
          "required": true,
          "options": [
            {
              "value": "canary",
              "label": "Canary (~30 min, lower risk)"
            },
            {
              "value": "direct",
              "label": "Direct (~8 min, higher risk)"
            }
          ]
        },
        {
          "id": "explanation",
          "type": "textarea",
          "label": "Why this choice? (optional)",
          "required": false,
          "placeholder": "Add context for the decision…"
        }
      ],
      "submit": {
        "id": "submit-decision",
        "label": "Save decision",
        "intent": "submit_rollout_decision",
        "style": "primary"
      },
      "resetLabel": "Clear",
      "submitMode": "once"
    }
  ]
}
```

### Collect feedback or intake

Use a repeatable form when the user must enter actual data rather than choose one
shortcut. A form's submit action sends all field values together; ordinary
action buttons carry intent but do not collect text.

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
        "intent": "submit_feedback",
        "style": "primary"
      },
      "resetLabel": "Clear draft",
      "submitMode": "repeatable"
    }
  ]
}
```

### Show progress and workflow

Combine `progress`, a check-style `list`, and targeted actions. Give an item a
freeform `status` such as `Waiting for approval` and a `tone` such as `warning`;
use `checked: true` only when that item is complete. Do not infer completion from
the status label or tone, and do not use a closed state enum. Use `group` for small list subheadings and an
item action when the next step belongs to exactly one item. This supports release
checklists, incident handoffs, onboarding, and review queues without pretending
to be a full board.

### Request approval

Use a status block for the pending state, one primary action, and a destructive
action only when it is genuinely available. Set `disabled: true` with a visible
`disabledReason` when an action cannot run.

### Monitor a compact system

Use a status block for the headline, progress for one meaningful aggregate, and
a table for services or checks. Map badge cell values to semantic tones with
`badgeVariants`; put verbose diagnostics in secondary columns.

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
