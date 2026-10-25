---
name: tasks
description: Work a project's Dispatch task board — file a task someone can pick up cold, check where it stands, move it between columns, talk on its conversation, link evidence, finish or archive it. Use when asked to create, pick up, hand off, update or close a board task.
---

# Working a task board

Tasks belong to a project's board and persist across the agents that work them.
Use the `task_*` tools only for work on that board. An ordinary coding request
does not imply that a task needs creating or moving.

## Read before you act

```
task_list  projectId?, column?, assignedToMe?, archived?
task_get   id
```

`task_list` returns thin rows and the board's `columns` **keys**. Filter by
`column`, `assignedToMe`, or `archived: true` when useful. Read the relevant
task with `task_get` before changing it: it includes the body, column key,
links, agents, last 30 events, `latestFailure`, `launching`, and attachments.
A task launch briefing already names the board's column keys, done column, and
columns that launch templates; use that briefing when it answers your question.

## Create a task someone can pick up cold

```
task_create  title, body?, column?, projectId?
```

Write a specific title and a markdown body with the problem, deliverable,
acceptance criteria, non-goals, and relevant paths or links. It lands in the
first column unless you name a `column` key. If that column's trigger fires on
create, an agent may launch immediately. `task_create` cannot attach files;
add links afterwards with `task_update`. Check the returned ID with
`task_get` when subsequent work depends on the created state.

## Own, move, and hand off

```
task_update  id, title?, body?, column?, assign?, links?
```

`assign: "self"` makes you the current assignee and puts you on the task's
conversation. It is refused while a different assigned agent is still
running. `assign: "none"` unassigns the task. Past agents remain in the task's
agent history.

Move with the **column key** from `task_list` or your briefing, not the display
name. Entering a column with a trigger launches its template as a new top-level
agent; that agent may become the assignee. Edits and reorders inside the same
column do not fire a trigger. Moving your own task is a handoff and is never
refused for the running-agent rule. If another assigned agent is running, a
move returns `agent_working`; these tools cannot override it. Leave the task
where it is or ask the user to move it on the board.

A failed launch does not undo the move. Check `latestFailure` and `launching`
in the `task_update` result or a fresh `task_get` before saying the handoff
succeeded. `task_update` validates the whole request before writing; a refused
call changes nothing.

## Conversation and evidence

The task has its own stream. A DISPATCH POST identifies the task and its
conversation; reply in that context, or use `post({ replyTo })` to answer a
specific block. `get_message` and `get_thread` recover context. For a new
top-level message, use `task_comment({ id, text, to? })`; `to` addresses another
agent on the task. Any agent in the task's project may comment. Commenting
does not assign you or put you on the task.

Append links with:

```
task_update  id, links: [{ kind: "pr" | "branch" | "url", label, url }]
```

Links are deduped by URL. Put the PR, branch, checks, or other evidence needed
to assess acceptance on the task, rather than relying on a separate chat.
Moving into the board's done column sets `completedAt`. Verify with `task_get`
that the task is in the done column and its evidence is linked. Done does not
mean archived.

## Completion and archives

| Term           | Meaning                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Column         | The task's board status; the key is used in tool calls.                                          |
| Assigned agent | Its current owner; earlier agents remain in its agents list.                                     |
| Completed task | In the done column, with `completedAt` set.                                                      |
| Archived task  | Off the active board. Restore is possible; column, assignee, agents, links, and activity remain. |
| Archived agent | A stopped session. `archive_agent` cannot be undone; the task retains its record of that agent.  |

Archive a task only when asked or when the project's stated practice calls for
it. Do not infer archival from a merge or release. Send `archived` **alone**:

```
task_update  id, archived: true
task_update  id, archived: false
```

`task_list({ archived: true })` finds archived tasks. Restore puts a task back
in its prior column without firing a trigger. Restore before moving it.

`archive_agent({ agentId, cleanupWorktree? })` is separate: you may archive
only agents you launched or yourself. It stops the session and cannot be
undone. `cleanupWorktree` is `auto` (default), `keep`, or `force`; choose with
care when work may still need integration.

## Keep project policy in the project

Columns, work limits, merge or release freezes, and who accepts work are
project policy. Read them from the task, briefing, or repo instructions; do
not invent them. Accepting or coordinating a task means checking its
acceptance criteria and linked evidence. A PR code review is separate work
unless requested; see `review-workflow` for PRs and reviews, and `subagents`
for launching agents.
