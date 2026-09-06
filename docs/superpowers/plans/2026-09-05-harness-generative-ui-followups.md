# Harness generative UI: what exists, what PromptKit decided, what comes next

**Date:** 2026-09-05
**Status:** follow-up plan, not started. Written after v0.38.7-dsh.19 shipped
inline shortcut buttons, the first generative-UI seam in the Harness view.
**Grounding:** PromptKit's "UI as a Modality" design
(`MytraAI/mytra-os-uis`, `docs/superpowers/specs/2026-07-14-promptkit-generative-ui-modality-design.md`)
and the PromptKit port under `apps/web/src/components/app/harness/`.

## Why

A long task stalls on the same thing every time: the agent needs a decision
and asks for it in prose. The user reads a paragraph, works out the options,
types an answer, and the agent parses free text. A form with the choices
already laid out, answered in one click, is faster for the user and safer
for the agent. That is the ask: when the agent has questions or decisions,
render them as structured input, not sentences.

## What the Harness already has

Three pieces of this exist today, each reachable from a turn:

| Piece                | Where                                                     | What it does                                                                                                                                                     |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent questions      | `question-card.tsx`, `dispatch_chat_post` kind `question` | Options as buttons, freeform reply through the composer, answer posted against the chat message id                                                               |
| Shortcut pins inline | `shortcut-row.tsx`, `TurnStream.turnExtras`               | A turn's `dispatch_pin`/`dispatch_pins` calls render as the same buttons the sidebar shows, in their live state; a click fires the pin's prompt as the next turn |
| The slot             | `TurnStream.turnExtras(turn)` / `liveExtras`              | Anything rendered under an assistant turn's result, keyed off the turn's own steps                                                                               |

`turnExtras` is the seam. It takes a turn and returns whatever should sit
under it. Forms go through the same slot.

## What PromptKit decided, and what carries over

PromptKit's spec draws one line that this plan keeps: **the write side is
turn-based.** A submit collects values and becomes the next turn; nothing
streams values to the agent mid-generation. The Harness already works this
way, because Dispatch owns the turn: a shortcut click, a question answer,
and a composer send all arrive at the agent as a prompt.

The spec's other decisions, mapped onto Dispatch:

- **Structured input is one contract.** PromptKit adds `StructuredInput
{ artifactId?, kind?, values, label? }` on the user turn and a `respond()`
  on the controller. Dispatch's equivalent is a chat message with an
  `answer`, which `dispatch_chat_post` questions already have. Extend that
  record, do not invent a second path.
- **Increment A before B.** A bounded catalog of host-authored cards first
  (`AgentForm` with typed fields), the arbitrary component tree later, if
  ever. For Dispatch the catalog is enough for a long time: forms,
  choices, confirmations, a table.
- **Inputs belong to a submit.** Brane retired free-floating inputs because
  their values had nowhere to go. A form owns its fields and its one
  submit; that is the only pattern.
- **Use it sparingly.** A generated form is a worse answer than a sentence
  whenever a sentence would do. The discipline lives in the agent's
  instructions, not in the renderer.
- **The renderer never runs agent code.** Nodes are data mapped onto a fixed
  set of components; an unknown component renders a placeholder.

## The plan, in three steps

### 1. `dispatch_chat_post` grows a `form` kind

The agent already posts questions through the Dispatch MCP. A form is the
same message with a schema instead of an options list:

```json
{
  "kind": "form",
  "text": "Which release path?",
  "form": {
    "submit": "Release",
    "fields": [
      {
        "id": "channel",
        "type": "choice",
        "label": "Channel",
        "options": ["patch", "minor"],
        "required": true
      },
      {
        "id": "notes",
        "type": "text",
        "label": "Release note",
        "multiline": true
      },
      {
        "id": "deploy",
        "type": "boolean",
        "label": "Deploy to production",
        "default": false
      }
    ]
  }
}
```

Field types for the first cut: `choice` (one of), `multi` (any of), `text`,
`number`, `boolean`. Nothing else until a real prompt needs it. The
server validates the schema on post and rejects unknown field types with a
400, so a bad form never reaches the view.

The answer reuses the existing answer route: `answer.value` becomes the
JSON of the values, `answer.label` a one-line summary ("patch · deploy").
The agent receives it as the next turn in the same envelope questions use
today, so nothing changes in the supervisor or the recorder.

### 2. `FormCard` in the Harness, through `turnExtras`

`question-card.tsx` gets a sibling, `form-card.tsx`: shadcn `Select`,
`Checkbox`, `Input`, `Textarea`, one submit, disabled once answered, the
answer rendered in place after. Attached to its turn by `createdAt` the way
questions are (`turns.ts` already threads questions onto turns). The
composer's reply chip does not apply: a form is answered by its own submit.

Tests: the card renders each field type, required fields block submit, the
answer posts the values and label, an answered form is read-only.

### 3. Tell the agent when to use it

A paragraph in the dsh persona (`persona.ts`, beside `DSH_SLASH_RULE`):
post a form when the next step needs a decision with a small set of
options or a few parameters; ask in prose for anything a sentence covers;
never post a form for a yes/no that a shortcut pin already offers.

## Not in this plan

- Live read-side bindings (a card showing host data that updates on its
  own). PromptKit's read side is host hooks over a data layer; Dispatch has
  no equivalent surface yet and no ask for one.
- The component tree (Increment B). A catalog of five field types is the
  whole first increment.
- Forms in the Chat feed for non-harness agents. The seam is Harness-only
  until the first form has been used for a week.

## Order and size

Step 1 is a server change with a migration-free schema (the `question` JSON
column already holds arbitrary shape). Step 2 is one component and a test
file. Step 3 is prose. Together they are one PR after the current branch
merges, small enough to review in one sitting.
