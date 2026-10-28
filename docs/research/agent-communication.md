# Agent communication research (paused)

Recorded 2026-10-28. **Status: paused; problem unresolved; no solution selected or
implementation authorized.** Preserve these findings when revisiting the subject;
do not treat the exploratory mockups or alternatives as an approved roadmap.

This is a research record, not the current schema or an approved design. The source audit used released v1.5.5, commit
`71c9bace78a7a208425cff17c0c233df4698ccbb`. It inspected implementation and existing
tests, not a new live reproduction or a measurement of production failure rates.

## Problem and constraints

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

## What the audit found already exists

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

## Directions explored, without selecting one

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

## What did not work in the exploration

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

## Open questions and a possible restart

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

## Audit entry points

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
