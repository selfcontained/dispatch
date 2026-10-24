# Tasks

## Overview

Tasks are a board per project. A task sits in one of the project's columns and outlives the agents that work it: a builder picks it up, a reviewer follows, and each of them is recorded against the task. A column can carry a **trigger** that launches a template when a task enters it, so moving a card is how work gets handed to the next agent.

Code: `apps/server/src/tasks/` (wire types, store, service), `apps/server/src/routes/tasks.ts`, `apps/server/src/shared/mcp/task-tools.ts`. Schema: migration `0023_tasks.sql`.

## Data Model

| Table          | Holds                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_columns` | A project's columns: `key` (slug, unique per project), `name`, `position`, `is_done`, `trigger`                                                 |
| `tasks`        | Title, markdown body, column, `position`, current `assigned_agent_id`, `links`, creator                                                         |
| `task_agents`  | Every agent assigned to a task, its `role` (`trigger`, `manual`, `self`) and conversation                                                       |
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

## Conversation

Assigning an agent posts a short **task block** into its stream (its own, or its root's for a child) with a link to `/tasks?task=<id>`, and stores `{ streamId, blockId }` on the `task_agents` row. That thread is the task's conversation: replies there reach the agent, and `task_comment` posts into it. A repeat assignment of the same agent reuses the thread. If the post fails, the assignment stands with no conversation.

## MCP Tools

Available to agents and job agents. The default project is the caller's.

| Tool           | Does                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `task_list`    | Thin rows `{ id, title, column, assignedAgentId, updatedAt }`; filter by `column` key or `assignedToMe` |
| `task_get`     | The task with its agents and its last 30 events                                                         |
| `task_create`  | Create in the first column or a named `column` key; returns `{ id, column }`                            |
| `task_update`  | Edit title/body, move with `column` (key), `assign: "self" \| "none"`, append `links` (deduped by url)  |
| `task_comment` | Reply in the caller's conversation thread on the task; requires an assignment                           |

A tool move follows the trigger rules but cannot confirm a relaunch over another running agent; it returns the `agent_working` error instead.

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
