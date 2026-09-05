# Harness view: PromptKit's stream, in Dispatch's clothes

Status: approved direction (Nii, 2026-09-04: "go ahead with the promptkit port,
spec first"). Follows `2026-09-04-dsh-harness-design.md`, which shipped as
v0.38.7-dsh.1.

## Why

The dsh prototype renders its stream into the Chat feed: one headed post per
tool call, status lines between them, the reply at the end. Chat was designed
as a conversation layer for sparse, deliberate messages, and the live run
showed the mismatch: a three-tool turn became five headers.

Nii already designed the right surface for an agent stream:
`@mytraai/promptkit` in MytraAI/mytra-os-uis (`packages/promptkit`, spec
`docs/superpowers/specs/2026-07-06-promptkit-design.md` in that repo). Its
fused terminal stream is prompt line, then a live activity block that
collapses to `done · 5 steps · 7.2s` when the turn settles, then the result.
That is the trajectory folded inside the conversation, with the detail one
click away.

This spec ports that design into Dispatch as the **Harness view** for dsh
agents, on shadcn and Dispatch's theme tokens, with no dependency on
`@mytraai/promptkit` or `@mytraai/mytrakit`. Chat and Console stay as they
are.

## What is taken from PromptKit, and what is not

Taken as is (copied, attributed in a header comment, adapted only for import
paths and Dispatch's lint rules):

- The data model: `Turn`, `Trace`, `Step`, `StepStatus`, `ToolCall`,
  `ToolOutcome`, and the `StreamEvent` union.
- The pure reducer: `applyStreamEvent`, `finishTrace`,
  `computeUnaccountedMs`, `stepId`.
- The primitives' structure and behaviour: `TurnStream`, `PromptLine`,
  `ActivityBlock` with its collapsed summary and focus handling, `StepRow`,
  `StepDetailBody`, the braille `useStreamTicker`, `formatStepDuration`.
- The renderer registry idea (`stepDetails` by kind, `kindLabel`,
  `stepSummary`) as a plain module rather than a React context, since
  Dispatch has one host.

Replaced:

- The headless controller `usePromptPanel` and the `PromptTransport` port.
  PromptKit's host owns submission and consumes a stream it started. In
  Dispatch the server owns the turn: prompts go out through the existing chat
  and message paths, dsh runs them, and the server records the stream. The
  view therefore _observes_ turns it did not start, including history from
  before the page loaded. A `useHarnessTurns(agentId)` hook over a new turns
  endpoint replaces the controller; the reducer still folds live events.
- mytrakit components with shadcn ones already in the repo: `Button`,
  `ScrollArea`, `Tooltip`, `Popover`, `Textarea`, `Select`, `Command`,
  toasts via the app's existing notifier.
- mytrakit tokens with Dispatch's (table below). The monospace stack becomes
  `--font-terminal`.
- `PromptInput` with Dispatch's `ChatComposer`, which already handles
  attachments, drafts, quick phrases, and the send API.

Left out for this cut: feedback rating, voice recorder, model selector,
example prompts, command palette, artifacts, agent forms, reflection notice,
revert and retry. None has a dsh counterpart yet.

## Where it lives

```
apps/web/src/components/app/harness/
  contracts.ts          Turn, Trace, Step, StreamEvent, ToolCallRecord (PromptKit, verbatim)
  reduce.ts             applyStreamEvent, finishTrace, computeUnaccountedMs (verbatim)
  format.ts             formatStepDuration (verbatim)
  registry.ts           dsh step kinds → label, summary, detail renderer
  use-stream-ticker.ts  braille ticker (verbatim)
  use-harness-turns.ts  React Query over the turns endpoint; live via chat.changed
  turn-stream.tsx       TurnStream
  prompt-line.tsx       PromptLine
  activity-block.tsx    ActivityBlock + CollapsedSummary + StatusGlyph
  step-row.tsx          StepRow, RunningDots, LiveDuration
  step-detail.tsx       StepDetailBody + dsh detail renderers (terminal, diff, read, kv)
  result-turn.tsx       ResultTurn (Markdown from components/ui)
  harness-pane.tsx      TurnStream + ChatComposer, mounted by AgentPane
  *.test.tsx            one per component, plus reduce.test.ts ported
packages/shared/src/harness-types.ts   HarnessTurn wire type
apps/server/src/agents/dsh/turns.ts    assembles HarnessTurn[] from stream rows
apps/server/src/routes/agents/harness-routes.ts   GET turns
```

## Server: turns from the stream

The recorder already writes assistant, thought, tool_call, and status rows.
Two additions make turns reconstructible without guessing:

**Turn rows.** Migration `0049_agent-stream-events-turn.sql` widens the
`kind` check to include `turn`. The recorder appends a `turn` row on the
driver's `turn started` event with payload `{ state: "started", prompt }`,
and updates that same row on `settled` to `{ state: "settled", stopReason?,
error?, endedAt }`. `prompt` is the parsed source of the text that was sent:

| Envelope on the wire                 | `prompt` recorded                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--- DISPATCH CHAT (id: <uuid>) ---` | `{ source: "chat", chatMessageId }` (text and attachments join from `agent_chat_messages`; a launch post gives `source: "launch"`) |
| `--- DISPATCH MESSAGE ---` + JSON    | `{ source: "agent", senderId, senderName, text }`                                                                                  |
| anything else                        | `{ source: "system", text: first 500 chars }`                                                                                      |

The supervisor passes the prompt text to the recorder alongside the driver's
`turn started` event (the driver event gains a `text` field; it is not
persisted anywhere else).

**Turns endpoint.** `GET /api/v1/agents/:id/harness/turns?limit=50` returns
`{ turns: HarnessTurn[] }`, newest last, assembled in
`apps/server/src/agents/dsh/turns.ts` from the agent's stream rows ordered
by `seq`:

```ts
type HarnessTurn = {
  id: string; // `turn:<row id>`
  prompt: {
    source: "chat" | "launch" | "agent" | "system";
    text: string;
    senderName?: string; // agent messages
    chatMessageId?: string;
    attachments: ChatAttachment[]; // from the chat message when present
  };
  trace: {
    startedAt: string;
    endedAt?: string;
    finalResult?: "ok" | "error";
    steps: HarnessStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  error?: string;
};
type HarnessStep = {
  id: string; // `stream:<row id>`
  kind: string; // execute | edit | read | search | fetch | think | note | other
  label: string; // tool title, or first line of a note
  status: "running" | "ok" | "error";
  startedAt: string;
  endedAt?: string;
  durMs?: number;
  detail: {
    toolKind?: string;
    locations?: { path: string; line?: number }[];
    diff?: { path: string; oldText: string | null; newText: string } | null;
    terminalOutput?: string | null;
    truncated?: boolean;
    text?: string; // note steps
  };
};
```

Assembly rules:

- A turn spans from its `turn` row to the next `turn` row. Rows before the
  first `turn` row (agents recorded by v0.38.7-dsh.1 before this change) form
  one synthetic turn with `prompt.source: "system"` and text "Earlier
  activity".
- `tool_call` rows become steps. `status` maps `completed` → `ok`, `failed`
  → `error`, else `running`. `durMs` is `updated_at - created_at` once
  settled. `detail` carries the payload fields the Chat entries carry today.
- `assistant` rows: the last one in the turn is the `result`; earlier ones
  become `note` steps whose label is the first line of their text and whose
  detail carries the full text. A turn still streaming has its last
  assistant row as the result with `streaming: true`.
- `thought` rows become `think` steps, collapsed by default like any step.
- `status` rows inside a turn become the turn's `error` when the turn has
  none and the row followed a settle with an error; other status rows are
  ignored here (the Chat feed still shows them).
- The agent's own `mcp__dispatch__dispatch_event` calls are dropped from the
  trace. Their content already shows as the status line under the agent
  card, and in a stream they read as noise.

The endpoint is read-only and needs no new SSE: the supervisor already
publishes `chat.changed` after every stream write, and `useHarnessTurns`
refetches on it, the same way the Chat pane does.

## Web: the view

**Views.** `AgentPaneView` gains `"harness"`. For dsh agents the toggle shows
three segments, Harness, Chat, Console, and the persisted default is
`harness`. Other agent types keep the two-segment toggle and never see the
harness view. `agentSupportsHarness(type)` is `type === "dsh"`.

**HarnessPane.** A column: `TurnStream` in a `ScrollArea` that follows the
bottom while the newest turn streams (same threshold rule as the Chat pane),
then `ChatComposer` docked below, sending through the chat API exactly as it
does in Chat. Empty state: "Send the first prompt" with the launch post
rendered as the first prompt line when one exists.

**Mapping a HarnessTurn onto PromptKit's model.** The hook converts each
`HarnessTurn` into a PromptKit `Turn` pair: a user turn (`role: "user"`,
`content: prompt.text`, `contextChips` for `senderName` on agent messages,
`attachments` from the chat message) and an assistant turn (`role:
"assistant"`, `content: result.text`, `trace`). The trace's `steps` come
straight from `HarnessStep` (same fields, timestamps parsed). The newest
turn with `streaming: true` renders through the live path: `ActivityBlock`
open, `ResultTurn` hidden until settle, and the result text shown under the
block as PromptKit's `liveText` while it grows.

**Registry for dsh kinds.**

| kind    | label               | summary                 | detail                                        |
| ------- | ------------------- | ----------------------- | --------------------------------------------- |
| execute | the command (title) | first line of output    | terminal output in a `pre`, truncated note    |
| edit    | `edit <basename>`   | `+N −M` from the diff   | the coloured line diff already built for Chat |
| read    | `read <basename>`   | line range when present | path and locations                            |
| search  | `search`            | count of locations      | locations list                                |
| fetch   | `fetch`             | title                   | kv                                            |
| think   | `thinking`          | none                    | the text                                      |
| note    | first line of text  | none                    | full markdown                                 |
| other   | tool title          | none                    | kv of whatever detail carries                 |

**Tokens.** PromptKit's accent and mytrakit's semantic names map onto
Dispatch's HSL tokens; the port uses Tailwind classes that already exist in
this repo, so all eleven themes apply.

| PromptKit / mytrakit                               | Dispatch                                                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pk-accent` (running, prompt caret)                | `status-working`                                                                                                                                                       |
| `pk-success` (ok glyph)                            | `status-done`                                                                                                                                                          |
| error                                              | `status-blocked`                                                                                                                                                       |
| `content-primary`                                  | `foreground`                                                                                                                                                           |
| `content-secondary`                                | `foreground/80`                                                                                                                                                        |
| `content-tertiary`                                 | `muted-foreground`                                                                                                                                                     |
| `surface-primary` / `surface-secondary`            | `background` / `muted`                                                                                                                                                 |
| `border-base`                                      | `border`                                                                                                                                                               |
| Fira Code stack                                    | `font-terminal`                                                                                                                                                        |
| `pk-animate-row-in`, `pk-animate-msg-in`, `pk-pop` | `animate-harness-row`, `animate-harness-msg`, `animate-harness-pop` keyframes added to `tailwind.config.ts` beside `chat-enter`, all with `motion-reduce:animate-none` |

Structure and typography are the shared identity and are kept: the `›`
prompt caret, 12.5px body, 12px step labels, 10.5px tabular durations, the
braille running glyph, the pop-in check.

**Accessibility.** Carried from PromptKit and from this week's UX review:
`role="list"`/`listitem` on the trace, `aria-live="polite"` on the running
step, `aria-expanded` and `aria-label="<label>, <state>"` on toggles, focus
kept across the collapse flip, reduced motion honoured by the ticker and the
animations, status never conveyed by colour alone (glyph plus text).

## What does not change

- The Chat feed keeps rendering stream rows as it does now (the entries from
  v0.38.7-dsh.1), so a user who prefers Chat loses nothing. Making Chat
  sparse for dsh is a separate decision.
- Prompt delivery, the supervisor, the driver, and the recorder's row shapes
  other than the new `turn` kind.
- Unread counts (still the known gap), token usage (still the known gap).

## Testing

- Server: recorder tests for `turn` rows including each envelope shape;
  `turns.ts` tests over seeded rows covering a settled turn, a streaming
  turn, a pre-turn-row synthetic turn, note steps, dropped `dispatch_event`
  calls, and duration math; a route test for the endpoint.
- Web: `reduce.test.ts` ported verbatim; component tests for `ActivityBlock`
  (open while running, collapses on settle, summary text, focus after
  toggle), `StepRow` (labels, aria, duration), `TurnStream` (order, live
  path), `PromptLine` (caret, chips, attachments), `useHarnessTurns`
  (mapping); `AgentViewToggle` three-segment case.
- E2E: `e2e/dsh-agent.spec.ts` extended: the Harness view is the default,
  shows the launch prompt line, a collapsed summary with the step count once
  the fake turn settles, and the result text; the toggle switches to Chat and
  back.
- Live: one turn on production with the deployed patch, inspected in the
  browser.

## Rollout

Ships as `v0.38.7-dsh.2` through the same local build and swap. Migration
0049 is additive (a widened check constraint) and safe under rollback.
