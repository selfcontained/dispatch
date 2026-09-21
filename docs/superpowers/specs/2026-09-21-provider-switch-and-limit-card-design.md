# Provider switch and limit card: design

**Date:** 2026-09-21
**Status:** Design approved section by section in Chat, pending review of this spec
**Repo:** `selfcontained/dispatch`
**Branch:** `agt_683b115bc1e9/dispatch-harness-research`

## What

Two features for Dispatch agents, the second built on the first.

1. **The limit card.** When a provider runs out of tokens, the feed shows one
   card that says which provider, what kind of limit, and when it resets, with
   three actions: continue when it resets, switch provider, stop here. It
   replaces three rows of raw error text.
2. **The provider switch.** An agent moves from one provider to another, Claude
   Code to Codex for example, and keeps going in the same session: same agent,
   same feed, same worktree. Available anytime from the model picker, and from
   the limit card.

## Why

A provider limit ends the work today. The turn fails, the feed shows the error
three times with a JSON fragment on the end, and nothing happens until someone
comes back and types "continue". On 2026-09-20 that was 15 minutes after the
limit had already reset.

```
You've hit your session limit · resets 5:30pm (America/Los_Angeles)
Internal error: You've hit your session limit · resets 5:30pm
(America/Los_Angeles): {"errorKind":"rate_limit"}
```

The harness is well placed to do better, because the session does not belong to
the provider. Every prompt, step, result and task list is stored in
`agent_stream_events` in Dispatch's own shape, and the feed is assembled from
that (`apps/server/src/chat/turns.ts`). A provider's private session file is a
cache of a conversation Dispatch already holds. That record is the hard part of
a handoff, and it exists.

Three things are missing, and this spec adds them:

- **A limit is not recognized as a limit.** It arrives as error text and the
  turn fails like any other.
- **An agent is welded to one engine.** The engine is the prefix of
  `agents.model`, read once by `splitModelId`
  (`apps/server/src/agents/harness/agent-spec.ts`). The model can change within
  an engine and not across engines.
- **Nothing carries context across engines.** Each engine resumes only its own
  sessions, and `agents.cli_session_id` remembers one.

## What "the same context" means

Read this first, because it sets what the feature can promise.

The new provider receives a briefing built from Dispatch's record, and the real
files on disk. It does not receive the old provider's memory: its reasoning, its
cached file reads, or anything else that lived inside that process. No design
changes this. Providers do not export that state and would not accept each
other's.

In practice the working tree holds most of what matters, and a good briefing
covers the rest. The quality of the briefing is where this feature succeeds or
fails, so it gets the most design attention below and the only test that cannot
be automated.

## Decisions taken

Each was put as a question in Chat on 2026-09-20 and 2026-09-21.

| Question                      | Decision                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Who decides to switch         | Manual, anytime. A limit is one reason to switch, not the only trigger. Automatic failover is out of scope                             |
| How context travels           | Hybrid: recent turns verbatim, older turns compressed only when the session outgrows the budget, plus facts Dispatch knows for certain |
| Work in flight after a switch | Ask each time: a checkbox, ticked when the last turn was cut short                                                                     |
| Architecture                  | Swap the engine under the same agent. Not a successor agent, not one engine with swappable model backends                              |
| Resume after a limit          | One click now, and Dispatch resumes by itself at the reset time                                                                        |

### Why not the alternatives

**A successor agent on the other provider** needs almost no supervisor change,
which is its appeal. But 20 tables key on an agent's id, among them chat,
stream events, reviews, media, pin events, surfaces, whiteboards and job runs. A new agent leaves all of that behind or needs a migration
step per table, and shows two sidebar cards for one piece of work. It is not the
same session in any sense the user would recognize.

**One engine with swappable model backends** keeps context perfectly, because
the engine never restarts. It needs provider API keys. The harness deliberately
holds none and uses each CLI's subscription login, so this moves the user from
subscription pricing onto metered billing. That undercuts the reason to switch.

**Asking the outgoing provider to summarize itself** is the obvious way to build
a handoff and cannot work here. The motivating case is a provider that has run
out of tokens. The briefing has to come from Dispatch's record or from the
incoming provider.

## 1. Recognizing a limit

A classifier in the harness looks at a failed turn and decides whether it was a
provider limit. It reads the machine-readable code first and falls back to known
phrases.

| Provider       | Code                                 | Reset wording seen on this host            |
| -------------- | ------------------------------------ | ------------------------------------------ |
| Claude Code    | `errorKind: rate_limit`              | `resets 5:30pm (America/Los_Angeles)`      |
| Codex, current | `codexErrorInfo: usageLimitExceeded` | `try again at Sep 20th, 2026 11:51 PM`     |
| Codex, older   | none                                 | `Try again in ~242 min`, or no time at all |

These are real strings from `agent_stream_events` on 2026-09-20. They are the
test fixtures.

The result is stored on the turn row as structured data, beside `error`:

```ts
limit?: {
  engine: HarnessEngineId;
  kind: "session" | "weekly" | "usage" | "unknown";
  /** ISO 8601. Absent when no source could say. */
  resetsAt?: string;
  /** Where `resetsAt` came from, so a wrong time can be traced. */
  resetSource?: "plan_report" | "error_text";
};
```

No migration: `payload` is `jsonb` and `TurnPayload` gains an optional field.
Everything downstream reads this field. No part of the UI parses an error
string.

**The reset time has two sources, best first.**

1. The provider's plan report from
   `apps/server/src/agents/harness/provider-usage.ts`, which carries exact
   `resetsAt` timestamps per window. The Keychain fix in `1ea18bf1` is what
   makes this source work for Claude on macOS.
2. The time parsed from the error text. Claude gives a time of day with a zone,
   Codex an absolute date with none, and one older form a relative duration.

If neither yields a time, `resetsAt` is absent and the card says so. It does not
guess.

**One card instead of three rows.** A limit lands in the feed three times today:
as the agent's reply, as a `status` row, and as the turn's `error`. When `limit`
is set, the projection in `turns.ts` drops the duplicate reply and the status
row, and the turn renders the card in their place.

## 2. The limit card

```
Claude hit its session limit
Resets at 5:30 PM, in 1 h 17 min. Your work is saved and nothing was lost.
[ Continue when it resets ]  [ Switch provider ]  [ Stop here ]
```

- **Continue when it resets** schedules the resume. At the reset time Dispatch
  sends the continue prompt itself. The card shows a live countdown and a
  Cancel while it waits.
- **Switch provider** opens the switch dialog (section 5) with the "continue
  the interrupted task" box ticked.
- **Stop here** dismisses the card and leaves the agent idle.

Once the reset passes with nothing scheduled, the card reads "Limit has reset"
with a single Continue button.

**A scheduled resume survives a restart.** It is a row, not a timer:

```sql
CREATE TABLE IF NOT EXISTS agent_scheduled_resumes (
  agent_id   text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  turn_id    bigint NOT NULL,   -- the turn's agent_stream_events row, as in the feed's `turn:<id>`
  resume_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

One per agent, so scheduling again replaces the earlier one. At boot the server
reloads pending rows, and one already past due fires at once. Cancel, Stop here,
any message from the user, and a provider switch each delete the row: all of
them mean the user has taken over.

**A scheduled resume gets one attempt.** Provider reset times are approximate.
If the resumed turn meets the limit again, the card reappears with the new time,
and it reschedules only if asked. An agent must never sit in a loop spending
requests against a limit.

The resume prompt is a system prompt in the existing envelope style, not a fake
user message, so the feed attributes it correctly.

## 3. The swap

### What changes on the agent

`agents.model` becomes changeable across engines. `setAgentModel` already
exists on the supervisor's deps and is called today for same-engine changes.

`agents.cli_session_id` stays as "the current session", so nothing that reads it
breaks. A new table remembers one session per engine:

```sql
CREATE TABLE IF NOT EXISTS agent_engine_sessions (
  agent_id      text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  engine        text NOT NULL,
  session_id    text NOT NULL,
  /** The last turn this engine saw, for the catch-up on a return. */
  last_seen_seq integer NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, engine)
);
```

This is what makes returning to a provider cheap. It resumes its own session
with its memory intact and is briefed only on the turns since `last_seen_seq`.

### The operation

`HarnessSupervisor.switchEngine(agentId, newModel, { continueTask })`, in this
order:

1. **Refuse early.** Confirm the target engine resolves (`resolveExecutable`)
   and is signed in (`auth-status.ts`). A refusal leaves the current session
   running. Same rule as `POST /harness/turn/edit` in `748bc91c`: everything
   that can refuse does so before anything stops.
2. **Hold the queue** with `holdQueue`, added in `748bc91c`. Without it a queued
   prompt starts on the old engine in the gap.
3. **Stop the running turn, if any**, with `interruptAndWait`. Open steps settle
   as cut (`48fd899a`), so the record the briefing reads is truthful.
4. **Save the outgoing engine's session** and `last_seen_seq` to
   `agent_engine_sessions`, then stop its process.
5. **Start the new engine in the same worktree.** Resume its remembered session
   if there is one. Otherwise open a fresh one.
6. **Queue the briefing** in front of the next prompt, through the mechanism
   `pendingPersona` already uses to prepend the persona to a fresh session's
   first prompt. Fresh session: full briefing. Resumed: catch-up only.
7. **Write the handoff row, then `agents.cli_session_id` and `agents.model`
   together, then release the queue.** With
   `continueTask`, the release names a system prompt to run first: "continue
   where the last turn left off".

**The record is written last.** `start()` normally stores the new session id at
once. Under a switch it must not: a restart that found the old engine named
beside the new engine's session id would try to resume a session that engine
never had. So both fields wait, and a restart mid-switch finds the old state or
the new one.

**A switch happens between turns, or by stopping the current one.** There is no
switching under a running turn, because a turn belongs to one engine process.
The dialog says that switching will stop it.

### Two traps in the existing supervisor

`HarnessSupervisor.stop()` is the wrong tool for step 4. It also fails every
queued prompt and stops the agent's Dispatch-managed background processes. The
switch needs a narrower stop that ends the engine process and nothing else, or
the promises below about the queue and background processes are false.

`start()` sends the agent's launch prompt whenever there is no stored session.
A fresh session on a second provider is not a first launch, so the switch has to
suppress it, or the agent's original task is sent again, mid-conversation, to a
provider that has just been told the work is half done.

### What does not change

The agent's id, feed, worktree, pins, reviews, child agents, jobs, MCP token and
Dispatch tool access. The engine is a replaceable part under all of that.

## 4. The briefing

Built by a pure function over Dispatch's record. No model is involved in the
core of it, which is what makes it testable: these stored turns in, exactly this
text out.

```ts
buildHandoff(input: {
  turns: AssembledTurn[];
  sinceSeq: number | null;   // null for a fresh session
  facts: HandoffFacts;       // branch, uncommitted summary, tasks, pins
  budgetTokens: number;
  olderBrief: string | null; // a saved compression, when one exists
}): { text: string; omittedTurns: number; estimatedTokens: number };
```

Four parts:

1. **The situation.** "You are taking over a session in progress from another
   coding agent. The files on disk are the source of truth. If this summary and
   the files disagree, trust the files." The last sentence is load-bearing: a
   briefing can be stale and the working tree cannot.
2. **Hard facts.** The branch, a summary of uncommitted changes, the task list
   with statuses, and the agent's pins. Read live at switch time, not recalled. Shortcut pins are left
   out: their value is a prompt to send back, not a fact about the work.
3. **The recent conversation, verbatim.** Prompts and answers in full. Each tool
   call is one line: what it was and how it ended.
4. **The earlier conversation, compressed**, only when needed.

**A typed prompt's text is not on the turn row.** A turn a Chat message started
stores only that message's id, and the text is joined in from
`agent_chat_messages` when turns are assembled. A loader that skips the join
produces a briefing in which every prompt the user typed is blank, so the
briefing reads the session through the same lookup the feed uses.

**Diffs and command output are left out.** They are large and already reflected
on disk. Leaving them out also keeps a secret that scrolled past in a terminal
from being re-sent to a second provider.

**Step status is carried faithfully.** A step reads as done, failed, or cut off
before it finished. Before `48fd899a` a cut step was stored as still running,
and a briefing would have had to guess.

**The budget decides between replay and summary.** The recent tail is sized in
tokens, not turns, so ten short turns and one enormous turn are both handled
sensibly. When the whole session fits the budget, everything is replayed and no
model is called. Only a session that outgrows it has its older part compressed.

**Compression runs as a separate, throwaway one-shot call on the incoming
provider**, never inside the main session. The main session receives the
finished brief, not the raw history it was made from. The brief is saved against
the turn it covers, so a later switch extends it and does not pay to summarize
the same history twice.

**If the summarizer fails, the switch still happens.** It falls back to a
truncated replay and the briefing says "earlier turns were omitted". A missing
summary must never be the reason someone is stuck on a provider with no tokens.

**The handoff is kept and readable.**

```sql
CREATE TABLE IF NOT EXISTS agent_engine_handoffs (
  id          serial PRIMARY KEY,   -- an integer: the feed's cursor breaks ties on it
  agent_id    text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  from_engine text NOT NULL,
  to_engine   text NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('switched', 'failed')),
  failure     text,
  briefing    text NOT NULL,        -- the exact text sent; empty for a failed switch
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Build step 3 adds two columns for the saved compression, `brief_upto_seq` and
`older_brief`. The marker in the feed links to the row as "View handoff". This is required, not a nicety.
When the new provider behaves oddly after a switch, the exact briefing is the
only way to tell whether the handoff caused it.

## 5. What the user sees

**Starting a switch.** The model chip above the composer already opens
`model-picker.tsx`, which lists the current provider's models. It gains the
other providers, grouped. Switching provider is the same gesture as switching
model, so there is no new control to find. `/switch` does the same from the
keyboard.

Picking a model on the same provider behaves as it does now. Picking one on a
different provider opens a confirm step:

```
Switch to Codex · GPT-6 Astra?
Claude Code will stop. Codex starts in the same worktree and is briefed on
this session.
[x] Continue the interrupted task     (ticked: the last turn was cut short)
First switch to Codex in this session, so it starts fresh. About 14k tokens
of briefing.
[ Cancel ]  [ Switch ]
```

- The checkbox is ticked when the last turn failed or was stopped, and clear
  when it finished cleanly. A clean finish leaves nothing to resume, and
  continuing there would make the agent invent work.
- The cost line states the truth before the user commits: "starts fresh" with
  an estimate on a first visit, "resumes its earlier session, short catch-up"
  on a return.
- A provider that is not installed or not signed in is greyed out with the
  reason. It does not fail after the click.

**While it happens.** The chip shows stages through the startup card in
`agent-startup.tsx`: stopping, starting, briefing. The composer stays disabled
until the new provider is ready, as at first launch.

**Afterwards.** A divider row in the feed:

```
Switched from Claude Code to Codex · 5:47 PM · View handoff
```

It is its own feed entry type, `switch`, read straight from
`agent_engine_handoffs`. A `status` row cannot carry it: `assembleTurns` does not
project `status` rows, and the web drops every feed entry of that type. One
handoff row is written per switch already, so the marker needs no second write
and cannot disagree with the stored briefing. A failed switch writes a row too,
with `outcome = 'failed'` and the reason, so the feed says what happened. Turns
above the marker show Claude's mark and turns below Codex's, which the feed
already does per turn. The engine label on the sidebar card updates.

## Failure handling

One rule: a switch either completes or leaves the agent exactly where it was.

| What fails                                          | What happens                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Target not installed or signed in                   | Refused before anything stops. Greyed out in the picker                                  |
| The running turn will not stop in time              | Switch abandoned, turn left running, error shown                                         |
| New provider fails to start                         | Old provider restarted from its saved session. Marker row says the switch failed and why |
| New provider's remembered session cannot be resumed | Fresh session with a full briefing, and the marker says so                               |
| Summarizer fails or times out                       | Truncated replay. Never blocks the switch                                                |
| New provider hits its own limit at once             | The limit card appears, as for any turn. No special case                                 |
| Server restarts mid-switch                          | `agents.model` is written last, so boot finds the old state or the new one               |
| Scheduled resume meets the limit again              | The card reappears with the new time. One attempt, no loop                               |

## Known limits

- The first switch to a provider always starts that provider cold. Only the
  return trip is cheap.
- Provider-specific features do not travel. Claude's nested subagent steps, or
  a model setting that exists on one side only, stop applying.
- A background process started through Dispatch's tool survives the swap. One
  started through a provider's own shell tool dies with that engine process.
- A switch discards the outgoing provider's prompt cache for this session, and
  a return after its TTL pays to rebuild it. That is the price of switching, not
  a defect. The cost line in the dialog is there so it is not a surprise.

## Settings

Each step has its own setting, following
`apps/server/src/dispatch-harness-settings.ts` and the rule in the token economy
spec: a regression is diagnosed by turning one thing off, which only works if no
two changes share a switch.

| Setting                               | Default | Governs                                                |
| ------------------------------------- | ------- | ------------------------------------------------------ |
| `harness_limit_card_enabled`          | on      | Limit classification, the card, scheduled resume       |
| `harness_engine_switch_enabled`       | on      | The swap, the picker's other providers, the marker row |
| `harness_handoff_compression_enabled` | on      | The one-shot summarizer. Off means replay only         |

## Build order

Three steps. Each works alone.

1. **The limit card.** Classifier, the `limit` field, the card, scheduled
   resume. Needs no engine swapping, fixes the failure that motivated this, and
   is the smallest piece. "Switch provider" is hidden until step 2.
2. **The swap with a replay briefing.** `agent_engine_sessions`,
   `switchEngine`, the picker, the marker row, `agent_engine_handoffs` and "View
   handoff". Briefing is replay only. "Switch provider" goes live.
3. **Compression for long sessions.** The one-shot summarizer and the saved,
   extendable brief. Until it lands, a very long session has its oldest turns
   omitted and the briefing says so.

## Testing

`e2e/fixtures/fake-acp-agent.mjs` already speaks all four dialects, which makes
this unusually testable.

- **Unit, classifier.** The real error strings above, one case per provider and
  per wording, plus a non-limit failure that must not match.
- **Unit, briefing.** `buildHandoff` as a pure function: cut steps, the token
  budget boundary, the catch-up for a returning provider, omitted-turn wording,
  and that no diff or terminal output appears in the text.
- **Supervisor.** `switchEngine` against the fake engine, one test per row of
  the failure table. The `holdQueue` tests in `harness-supervisor.test.ts` are
  the template.
- **Scheduled resume.** Fires at the time, fires at boot when past due, is
  deleted by each of the four things that mean the user took over, and does not
  loop.
- **End to end, live.** Start on one fake provider, switch, check the marker
  row, the handoff text, and that the next turn runs on the new one. The fake
  engine gains a `limit:` directive, then: the card, its countdown, the resume.
- **Real providers, by hand.** One real Claude to Codex switch and back on a
  host with both signed in, before this is called done. This is the only test of
  whether the briefing is good, and no automated test stands in for it.

## Not doing

- **Automatic failover.** Decided against for now. It is policy on top of
  `switchEngine`, and adding it later needs no change to anything here.
- **A successor-agent mode, or swappable model backends.** See "Why not the
  alternatives".
- **Transferring provider memory.** Not possible. See "What 'the same context'
  means".
- **A per-provider history view, a provider comparison, a "switch back"
  shortcut.** Returning is the same picker. Each is easy to add if missed.
- **Switching under a running turn.** A turn belongs to one engine process.
- **A model router.** Researched separately on 2026-09-21. Its "start cheap,
  escalate by relaunch" layer would use `switchEngine`, so building the swap
  here makes a router mostly policy on top of something that exists.
