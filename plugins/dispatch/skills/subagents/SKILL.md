---
name: subagents
description: Delegate work to other Dispatch agents and coordinate with running ones. Use when a task splits into independent parts, needs its own worktree, or when you must message or hand off to another agent.
---

# Launching and coordinating agents

A Dispatch agent can launch other agents. Each one is a full agent — its own
session, its own working directory, optionally its own git worktree and branch —
not an in-process helper that shares your context.

That difference decides when delegation is worth it:

- **Worth it:** independent parts of a task that can run at the same time; work
  that needs its own branch or worktree; a long-running background task; a
  genuinely separate perspective on what you just built.
- **Not worth it:** anything you could finish faster yourself. A launch costs a
  full CLI startup, and the child starts with none of your context — everything
  it needs has to be written into the prompt.

For _review_ specifically, launch a persona rather than a plain agent — see the
`review-workflow` and `personas` skills.

## Launching

```
dispatch_launch_agent  prompt, ... (see the tool schema for the full option set)
```

The prompt is the child's entire world. Write it as a standalone briefing:

- What the task is, stated as a deliverable rather than a topic.
- Where the relevant code lives — actual paths, not "the auth stuff".
- What is explicitly **out** of scope. Children reliably expand scope when the
  boundary is unstated.
- What decisions have already been made and should not be relitigated.
- How you want the result reported back.

If a template already captures this launch configuration, launch from it instead
of retyping the prompt — see the `templates` skill.

## Coordinating

```
list_agents           — who exists, their IDs, names, statuses, latest activity,
                        plus parentAgentId and relation (child, descendant, …)
dispatch_send_message target, message
```

The list is not flat. Each entry names the agent that launched it, so a
`descendant` is a grandchild or deeper — something your own child spawned, not
something you did. Incoming messages carry the same lineage: the delegation
chain runs from the sender up through whoever launched it to you.

Lineage is keyed by agent ID. Agents rename themselves as their work shifts, so
a name is a label for reading, not a handle for remembering — build the tree
from `parentAgentId`, and hold on to the ID of anyone you plan to contact later.

`dispatch_send_message` injects a message directly into the target's session, and
it can reply the same way. `target` accepts an agent ID (`agt_…`) or a name, which
is fuzzy-matched. A remembered name can drift onto a different agent or match
nothing at all, so prefer the ID whenever you have it. **It only works for agents
that are currently running** — a message to a stopped agent goes nowhere, so
check `list_agents` when a send fails rather than assuming it was delivered.

Messaging is for coordination, not for streaming progress. A parent that wants a
start and an end does not want twelve interim pings; fold the detail into the
final report.

For results that need to outlive either session — a finding, a decision, an
accumulating list — write to the brain instead of messaging it. See the `brain`
skill.

## Cleaning up

```
dispatch_archive_agent  agentId
```

Archive a child once you have consumed its output. This is scoped to agents you
launched directly — archiving someone else's agent is rejected. It stops the
session and soft-deletes it, and it cannot be undone, so read the child's output
first.

Pass your own agent ID to retire yourself instead of idling until someone
archives you from outside. Make it the last call of the turn: your session stops
moments after it returns, so send any final message or report first.

## Patterns that work

- **Fan out, then reconcile.** Launch one agent per independent part, each in its
  own worktree, then merge and run the full check suite yourself. Expect
  conflicts where their files overlap and plan who resolves them.
- **Build, then review.** Finish the change, then launch a reviewer persona
  against the diff rather than reviewing your own work.
- **Delegate the search, keep the conclusion.** A child that reads twenty files
  and reports three sentences saves your context; one that reports the twenty
  files does not.
