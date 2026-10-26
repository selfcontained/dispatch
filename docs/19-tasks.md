# Tasks

## Overview

Tasks are a board per project. A task sits in one of the project's columns and outlives the agents that work it: a builder picks it up, a reviewer follows, and each of them is recorded against the task. A column can carry a **trigger** that launches a template when a task enters it, so moving a card is how work gets handed to the next agent.

Code: `apps/server/src/tasks/` (wire types, store, service), `apps/server/src/routes/tasks.ts`, `apps/server/src/shared/mcp/task-tools.ts`. Schema: migration `0023_tasks.sql`.

## Data Model

| Table          | Holds                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_columns` | A project's columns: `key` (slug, unique per project), `name`, `position`, `is_done`, `trigger`                                                                                       |
| `tasks`        | Title, markdown body, column, `position`, current `assigned_agent_id`, `links`, creator                                                                                               |
| `task_agents`  | Every agent assigned to a task and its `role` (`trigger`, `manual`, `self`); the assignment history; removing an agent closes the conversation to it                                  |
| `task_events`  | The activity log: `created`, `updated`, `moved`, `assigned`, `unassigned`, `trigger_launching`, `trigger_launched`, `trigger_failed`, `agent_launched`, `agent_removed`, `link_added` |

The first read of a project's board seeds the default columns: `backlog`, `ready`, `in_progress`, `in_review`, `done` (`isDone`). A project has at most one done column: setting `isDone` on one clears it on the others. Entering the done column sets `completedAt`; leaving it clears it. A column that holds tasks cannot be deleted (409 `column_not_empty`).

Each column has an optional `capacity` (`null` by default, meaning unlimited) and an authoritative `activeTaskCount` covering every non-archived task, independent of task filters or the archived view. Create and update accept `capacity: null` or a positive integer up to 2147483647. The column menu can set, change, or remove a limit. Lowering it below current occupancy is allowed; the column remains over limit until tasks leave.

Capacity gates **entry into that column**: creating there, moving there from another column, or restoring an archived task there. Full columns refuse entry with HTTP 409 `column_capacity_exceeded`, an actionable `error` message, and `{ column: { id, key, name }, count, limit }`. Rejection leaves the task, events, assignment, attachments, and automation unchanged. Same-column edits/reorders, moves out, and archiving remain allowed. Removing a limit immediately permits entry again. Admission and limit updates serialize on the destination column's database row, with occupancy and the task write using the same transaction connection across server instances.

A queue-to-work setup can leave Ready unlimited and put a limit plus an entry trigger on In progress. Moving from Ready into In progress first checks capacity, then an admitted move launches the configured agent. A trigger in an earlier column reserves no future slot: capacity only gates entry into its own column. Limits and project configuration are never applied automatically.

A task's `latestFailure` is computed on read: the newest `trigger_failed` since the latest `moved` or `created` event, with no `trigger_launched`/`agent_launched` at or after it. Re-entering a column clears an older failure. `launching` is the newest `trigger_launching { templateId }` with no `trigger_launched`, `trigger_failed`, or `moved` at or after it. A later move clears a launch left in progress by a crashed server.

## Triggers

```json
{
  "templateId": "…",
  "agentType": null,
  "model": null,
  "assign": true,
  "fireOnCreate": false
}
```

Only `templateId` is required when setting one; the rest default as shown. The template must belong to the project, or have no project and the project's repo as its directory. `agentType`/`model` override the template's and are validated the way templates validate them.

In the UI, a column's `…` menu — on its board header or its list group header — adds or edits the trigger ("Add trigger…" / "Edit trigger…"), alongside Rename, Move left/right (up/down in the list) and Delete. A column with a trigger shows it under its header as "On entry → launches <template>"; clicking that edits it too.

- A trigger fires only when a task **enters** its column: a `columnId` change, or a create in that column when `fireOnCreate` is set. Edits and reorders inside the column never fire.
- The launch goes through `TemplateService.launchTemplate` as a top-level agent in the task's project. The task briefing (task, project, column, links, body, the board's columns and how to use the task tools) is always appended to the rendered prompt, so any template works as-is — including one with no prompt, which launches with the briefing as its whole prompt. Its columns line lists the board's keys in order, marking the task's column, the done columns and each trigger's template, e.g. `Columns: backlog → ready (you are here) → in_progress → in_review (launches "Code review") → done (completes the task)`, so an agent can move the task without calling `task_list` first; the args `Task ID`, `Task Title` and `Task Body` are also available to templates that want to place them.
- If the task's assigned agent is still `running`/`creating`, the move is refused with 409 `{ code: "agent_working", agent: { id, name } }` and nothing changes. Retry with `confirmRelaunch: true` to launch anyway. An agent moving its own task is handing it off and is never refused.
- Before launch, `trigger_launching` is recorded and published so the board can show progress. Success records `trigger_launched`. With `assign`, the new agent becomes the task's agent (role `trigger`); the previous one stays in `task_agents`.
- A failure (missing template, launch error) never undoes the move. It records `trigger_failed { templateId, reason }`, which the card shows through `latestFailure`.
- An agent without full access cannot start a full-access template this way, whether by a move, a create with `fireOnCreate`, or a manual launch: the move stands and the trigger fails with "restricted agent cannot launch a full-access template". People (HTTP) are trusted.
- Transitions of one task run one at a time (move, launch, assignment), and the move itself only applies while the task is still in the column it left, so overlapping moves fire the trigger once. A launch that finds the task already moved elsewhere does not assign itself.

## Conversation

A task is a **stream root**: its conversation is the blocks with `stream_id = <task id>`, served by the ordinary stream routes (`GET/POST /api/v1/streams/<taskId>/blocks`, `…/blocks/:blockId/thread`, `…/read`). Unread and open-input counts per task come back under `tasks` in `GET /api/v1/chat/unread`; `stream.changed` / `stream.entry` events carry the task id as `agentId`.

- **Assignment** posts a user block into the task's stream addressed to the new agent and delivers it as its prompt: "You're assigned to task tsk\_… — <title>. This stream is the task's conversation; reply here." A launch briefing also names the task's stream. If the post fails, the assignment stands.
- **People** posting at the top of the task's stream reach the current assignee by default (400 "assign an agent first" when there is none), or the agents they `@mention` — the task's agents first, then running top-level agents. A thread reply follows the usual thread sides.
- **Delivery**: the DISPATCH POST envelope says `Task tsk_… — <title> (<column>). This is the task's conversation.`; a turn it opens answers in the task's stream, and `post({ replyTo })` on its ids lands there.
- **Agents** in the task's project (the same `projectForAgent` scope the `task_*` tools use) or on the task (`task_agents`) may post into its stream with `replyTo` and read it with `get_message`/`get_thread`; an agent from another project is refused unless the block it replies to was addressed to it, and an agent removed from the task is refused even then. They may react to its blocks the same way. `task_comment` posts at the top of the stream. Posting does not put an agent on the task or change the assignee; like any author there, it can then be `@mention`ed and replied to.
- **Files**: a person's attachment resolves against any agent on the task, so a file uploaded under an earlier assignee can still be sent to the current one.
- **Deleting** a task deletes its conversation. Deliveries of its posts still queued at an agent are taken back first, and new posts into it are refused while it is being deleted; a delivery that cannot be taken back within a moment answers 409 `delivery_in_flight` and nothing is deleted.

## MCP Tools

Available to agents and job agents. They act on the caller's project only: its own, or for an agent outside any project, the project whose repo holds its workspace. Another project's board or tasks are refused.

| Tool           | Does                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_list`    | Thin rows `{ id, title, column, assignedAgentId, updatedAt }`; column keys plus `columnCapacity` entries `{ id, key, name, capacity, activeTaskCount }`; filter by `column` key or `assignedToMe` |
| `task_get`     | The task with its column key, its agents and its last 30 events                                                                                                                                   |
| `task_create`  | Create in the first column or a named `column` key; returns `{ id, column }`                                                                                                                      |
| `task_update`  | Edit title/body, move with `column` (key), `assign: "self" \| "none"`, append `links` (deduped by url)                                                                                            |
| `task_comment` | Post at the top of the task's conversation; `to` delivers it to another agent on the task; caller must be in the task's project, and not removed from it                                          |

A tool move follows the trigger rules but cannot confirm a relaunch over another running agent; it returns the `agent_working` error instead. `assign: "self"` likewise refuses to take over a task whose agent is still running. `task_update` checks everything before it writes, so a refused call changes nothing.

## Live Updates

Every write publishes `{ type: "task.changed", projectId, taskId? }` on the SSE stream (`taskId` is omitted for column changes). Seeding the default columns on a board read does not publish.

## API

| Method | Path                                        | Description                                                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/projects/:projectId/tasks/board`   | `TaskBoard`: columns and tasks; seeds defaults on first read                                                                                                                                                                                                                                      |
| POST   | `/api/v1/projects/:projectId/task-columns`  | Create a column (`key` derived from `name` when omitted)                                                                                                                                                                                                                                          |
| PATCH  | `/api/v1/task-columns/:id`                  | Update name, key, position, `isDone`, `trigger` (null removes), `capacity` (null removes)                                                                                                                                                                                                         |
| DELETE | `/api/v1/task-columns/:id`                  | Delete an empty column; 409 `column_not_empty` otherwise                                                                                                                                                                                                                                          |
| GET    | `/api/v1/tasks?projectId=&assignedAgentId=` | `Task[]`; either filter alone is allowed                                                                                                                                                                                                                                                          |
| POST   | `/api/v1/tasks`                             | Create; defaults to the first column, top of the column                                                                                                                                                                                                                                           |
| GET    | `/api/v1/tasks/:id`                         | `TaskDetail`: agents and the last 200 events, oldest first                                                                                                                                                                                                                                        |
| PATCH  | `/api/v1/tasks/:id`                         | Update; a `columnId` change is a move (see Triggers)                                                                                                                                                                                                                                              |
| DELETE | `/api/v1/tasks/:id`                         | Delete                                                                                                                                                                                                                                                                                            |
| POST   | `/api/v1/tasks/:id/launch`                  | Launch a template for the task (briefed, role `manual`); `{ agent }`                                                                                                                                                                                                                              |
| GET    | `/api/v1/tasks/:id/briefing`                | `{ projectId, text }`: what an agent created for the task is told (the Create Agent dialog shows it)                                                                                                                                                                                              |
| POST   | `/api/v1/agents` with `taskId`              | The ordinary create-agent route, for a task: the briefing is appended to the prompt, the project defaults to the task's, and the agent is assigned (role `manual`, no assignment post) before its engine starts (the UI's "New agent…" in the Assignee picker)                                    |
| DELETE | `/api/v1/tasks/:id/agents/:agentId`         | Take an agent off the task: the task's posts still queued at it are taken back first (409 `delivery_in_flight` if one is mid-handover), it is unassigned if current, leaves `task_agents`, and can no longer post in the conversation — not even in reply to blocks addressed to it; `TaskDetail` |

Errors are `{ error, code? }`: 400 for invalid input, 404 for an unknown project/task/column, 409 for `agent_working`, `column_not_empty` and `column_key_taken`.

### Context at creation

The task create dialog accepts files by drag and drop, paste, or file picker, and
HTTP(S) links through its shared context picker. Remove a thumbnail or link chip
before submitting to leave it out. Context cannot be uploaded after creation.

`POST /api/v1/tasks` accepts the existing JSON body or `multipart/form-data` with
plain `projectId`, `title`, optional `body`, `columnId`, and `position` fields.
Each file uses a repeated `startupFiles` part; `startupLinks` is a JSON string
array, for example `["https://example.com/spec"]`. Limits match agent creation:
10 files, 20 MiB per file, 20 links, and 2,000 characters per link. File types are
validated from their bytes. Links must be absolute HTTP(S) URLs and are deduped
into `task.links` as `{ kind: "url", url, label: url }`. Validation precedes task
creation; attachment storage failure removes the new task and its files.

Task detail (`GET /api/v1/tasks/:id` and MCP `task_get`) includes `attachments`:
`{ id: number, name: string, mimeType: string, size: number, url: string }[]`.
Board/list rows stay thin. Attachment URLs use
`GET /api/v1/tasks/:id/attachments/:attachmentId`, with byte ranges and the same
sandbox headers as agent files. The drawer and modal show attachment previews
and open the shared lightbox. Agent briefings include names, MIME types and
absolute disk paths alongside task links. Files live under
`<filesRoot>/tasks/<taskId>/`; deleting a task cascades attachment rows and
removes that directory. MCP `task_create` does not upload files.

Agents launched for a task start with its title as their name (shortened to 40 characters plus an ellipsis when needed). Their task briefing asks them to use `rename_session` as their first act to choose a short, descriptive session name. An explicit name in Create Agent takes precedence over the initial task name.

## Archiving tasks

Archive a task from its detail panel, or use **Archive N tasks** in the completion column's menu to archive every active task in that column. The confirmation count includes tasks hidden by search or filters.

Archived tasks leave the normal board, list and assignee counts. Open **Archived** in the tasks header to browse them and restore individual tasks. Existing task links still open their details and conversations. Archiving preserves the column, completion timestamp, assignee, agents, links, attachments and activity. Restore returns the task to its existing column without launching a trigger. Restore an archived task before moving it.

The API supports task archive/restore actions and `archived=1` on board/list reads. MCP callers can use `task_update` with `archived: true` or `false`, and `task_list` with `archived: true`.

### Watching tasks

Agents can use `task_watch({ id })` and `task_unwatch({ id })` on their project's tasks. Watching leaves assignment and the task's column unchanged; `task_get` includes the caller's `watching` flag. Watches are idempotent and survive server restarts. Insert triggers atomically queue each new item in a per-watcher inbox; accepted notices remove only the represented items, so late-committing transactions remain deliverable.

Watch notices combine meaningful task changes and new conversation posts (including thread replies and answers) into one prompt after a short debounce. Notices skip the watcher's own activity and posts already addressed to it. They include event/message IDs for `task_get`, `get_message`, and `get_thread`, with up to 15 item excerpts per notice. Unavailable agents catch up when running again. Archived agents, agents removed from the task, and deleted tasks lose their watches.
