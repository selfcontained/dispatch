# Tasks

## Overview

Tasks are a board per project. A task sits in one of the project's columns and outlives the agents that work it: a builder picks it up, a reviewer follows, and each of them is recorded against the task. A column can carry a **trigger** that launches a template when a task enters it, so moving a card is how work gets handed to the next agent.

Code: `apps/server/src/tasks/` (wire types, store, service), `apps/server/src/routes/tasks.ts`, `apps/server/src/shared/mcp/task-tools.ts`. Schema: migration `0023_tasks.sql`.

## Data Model

| Table          | Holds                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_columns` | A project's columns: `key` (slug, unique per project), `name`, `position`, `is_done`, `trigger`                                                 |
| `tasks`        | Title, markdown body, column, `position`, current `assigned_agent_id`, `links`, creator                                                         |
| `task_agents`  | Every agent assigned to a task and its `role` (`trigger`, `manual`, `self`); these agents may post in the task's conversation                   |
| `task_events`  | The activity log: `created`, `updated`, `moved`, `assigned`, `unassigned`, `trigger_launched`, `trigger_failed`, `agent_launched`, `link_added` |

The first read of a project's board seeds the default columns: `backlog`, `ready`, `in_progress`, `in_review`, `done` (`isDone`). A project has at most one done column: setting `isDone` on one clears it on the others. Entering the done column sets `completedAt`; leaving it clears it. A column that holds tasks cannot be deleted (409 `column_not_empty`).

A task's `latestFailure` is computed on read: the newest `trigger_failed` with no `trigger_launched`/`agent_launched` at or after it.

## Triggers

```json
{
  "templateId": "…",
  "agentType": null,
  "model": null,
  "assign": true,
  "passContext": true,
  "fireOnCreate": false
}
```

Only `templateId` is required when setting one; the rest default as shown. The template must belong to the project, or have no project and the project's repo as its directory. `agentType`/`model` override the template's and are validated the way templates validate them.

- A trigger fires only when a task **enters** its column: a `columnId` change, or a create in that column when `fireOnCreate` is set. Edits and reorders inside the column never fire.
- The launch goes through `TemplateService.launchTemplate` as a top-level agent in the task's project. The template always receives the args `Task ID`, `Task Title` and `Task Body`. With `passContext`, the task briefing (task, project, column, links, body and how to use the task tools) is appended to the rendered prompt.
- If the task's assigned agent is still `running`/`creating`, the move is refused with 409 `{ code: "agent_working", agent: { id, name } }` and nothing changes. Retry with `confirmRelaunch: true` to launch anyway. An agent moving its own task is handing it off and is never refused.
- Success records `trigger_launched`. With `assign`, the new agent becomes the task's agent (role `trigger`); the previous one stays in `task_agents`.
- A failure (missing template, launch error) never undoes the move. It records `trigger_failed { templateId, reason }`, which the card shows through `latestFailure`.
- An agent without full access cannot start a full-access template this way, whether by a move, a create with `fireOnCreate`, or a manual launch: the move stands and the trigger fails with "restricted agent cannot launch a full-access template". People (HTTP) are trusted.
- Transitions of one task run one at a time (move, launch, assignment), and the move itself only applies while the task is still in the column it left, so overlapping moves fire the trigger once. A launch that finds the task already moved elsewhere does not assign itself.

## Conversation

A task is a **stream root**: its conversation is the blocks with `stream_id = <task id>`, served by the ordinary stream routes (`GET/POST /api/v1/streams/<taskId>/blocks`, `…/blocks/:blockId/thread`, `…/read`). Unread and open-input counts per task come back under `tasks` in `GET /api/v1/chat/unread`; `stream.changed` / `stream.entry` events carry the task id as `agentId`.

- **Assignment** posts a user block into the task's stream addressed to the new agent and delivers it as its prompt: "You're assigned to task tsk\_… — <title>. This stream is the task's conversation; reply here." A launch briefing also names the task's stream. If the post fails, the assignment stands.
- **People** posting at the top of the task's stream reach the current assignee by default (400 "assign an agent first" when there is none), or the agents they `@mention` — the task's agents first, then running top-level agents. A thread reply follows the usual thread sides.
- **Delivery**: the DISPATCH POST envelope says `Task tsk_… — <title> (<column>). This is the task's conversation.`; a turn it opens answers in the task's stream, and `post({ replyTo })` on its ids lands there.
- **Agents** on the task (`task_agents`) may post into its stream with `replyTo` and read it with `get_message`/`get_thread`; any other agent is refused unless the block it replies to was addressed to it. They may react to its blocks the same way. `task_comment` posts at the top of the stream.
- **Files**: a person's attachment resolves against any agent on the task, so a file uploaded under an earlier assignee can still be sent to the current one.
- **Deleting** a task deletes its conversation. Deliveries of its posts still queued at an agent are taken back first, and new posts into it are refused while it is being deleted; a delivery that cannot be taken back within a moment answers 409 `delivery_in_flight` and nothing is deleted.

## MCP Tools

Available to agents and job agents. They act on the caller's project only: its own, or for an agent outside any project, the project whose repo holds its workspace. Another project's board or tasks are refused.

| Tool           | Does                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `task_list`    | Thin rows `{ id, title, column, assignedAgentId, updatedAt }`; filter by `column` key or `assignedToMe`               |
| `task_get`     | The task with its agents and its last 30 events                                                                       |
| `task_create`  | Create in the first column or a named `column` key; returns `{ id, column }`                                          |
| `task_update`  | Edit title/body, move with `column` (key), `assign: "self" \| "none"`, append `links` (deduped by url)                |
| `task_comment` | Post at the top of the task's conversation; `to` delivers it to another agent on the task; caller must be on the task |

A tool move follows the trigger rules but cannot confirm a relaunch over another running agent; it returns the `agent_working` error instead. `assign: "self"` likewise refuses to take over a task whose agent is still running. `task_update` checks everything before it writes, so a refused call changes nothing.

## Live Updates

Every write publishes `{ type: "task.changed", projectId, taskId? }` on the SSE stream (`taskId` is omitted for column changes). Seeding the default columns on a board read does not publish.

## API

| Method | Path                                        | Description                                                          |
| ------ | ------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/api/v1/projects/:projectId/tasks/board`   | `TaskBoard`: columns and tasks; seeds defaults on first read         |
| POST   | `/api/v1/projects/:projectId/task-columns`  | Create a column (`key` derived from `name` when omitted)             |
| PATCH  | `/api/v1/task-columns/:id`                  | Update name, key, position, `isDone`, `trigger` (null removes)       |
| DELETE | `/api/v1/task-columns/:id`                  | Delete an empty column; 409 `column_not_empty` otherwise             |
| GET    | `/api/v1/tasks?projectId=&assignedAgentId=` | `Task[]`; either filter alone is allowed                             |
| POST   | `/api/v1/tasks`                             | Create; defaults to the first column, top of the column              |
| GET    | `/api/v1/tasks/:id`                         | `TaskDetail`: agents and the last 200 events, oldest first           |
| PATCH  | `/api/v1/tasks/:id`                         | Update; a `columnId` change is a move (see Triggers)                 |
| DELETE | `/api/v1/tasks/:id`                         | Delete                                                               |
| POST   | `/api/v1/tasks/:id/launch`                  | Launch a template for the task (briefed, role `manual`); `{ agent }` |

Errors are `{ error, code? }`: 400 for invalid input, 404 for an unknown project/task/column, 409 for `agent_working`, `column_not_empty` and `column_key_taken`.
