# Automations: Templates & Jobs

## Overview

The Automations system has two layers:

- **Templates** — reusable agent launch configurations. A template captures a prompt, agent type, directory, worktree settings, and an optional set of runtime arguments (`{{D:Arg Name}}` syntax). Templates can be launched from the Cmd+K command palette or the Automations UI to spin up a normal agent session with no supervision.

- **Jobs** — automation on top of a template. A job references a backing template and adds scheduling (cron), timeouts, singleton enforcement, structured reporting via MCP, auto-archive, and notifications. Each job invocation is a **run**.

Templates are the right choice for quick-launch workflows (code review, feature scaffolding, ad-hoc tasks). Jobs are for recurring or monitored work (nightly triage, release babysitting, janitorial cleanup) where you want a machine-readable outcome.

## Templates

### Data Model

Templates are uniquely identified by (`directory`, `name`). Each template has:

| Field         | Description                                                |
| ------------- | ---------------------------------------------------------- |
| `name`        | Display name, unique within its `directory`                |
| `directory`   | Absolute path of the repo the template runs against        |
| `prompt`      | User-supplied prompt used as the agent's first turn        |
| `agentType`   | One of `claude`, `codex`, `opencode`                       |
| `useWorktree` | If true, the agent gets its own git worktree               |
| `baseBranch`  | Base branch for the worktree (optional)                    |
| `branchName`  | Branch for the worktree (optional)                         |
| `fullAccess`  | Pass the agent CLI's full-access/bypass-approvals flag     |
| `callable`    | If true, the template appears in the Cmd+K command palette |

### Runtime Arguments

Templates support `{{D:Arg Name}}` placeholders in their prompt. At launch time, each placeholder becomes a required input field. Arguments are also pinned to the spawned agent's sidebar for reference.

Example prompt:

```
Review the PR at {{D:PR URL}} and focus on {{D:Review Focus}}.
```

This creates two input fields: "PR URL" and "Review Focus".

### Command Palette (Cmd+K)

Templates with `callable: true` appear in the Cmd+K command palette under a "Templates" group.

- Templates **without** arguments show a confirmation step — pressing Enter twice (select → confirm) launches immediately.
- Templates **with** arguments navigate to the template detail page (`/automations/templates/:id`) where you fill in the argument values before launching.

After launch, the new agent appears in the sidebar via SSE and the URL navigates to it automatically.

### API

| Method | Path                           | Description         |
| ------ | ------------------------------ | ------------------- |
| GET    | `/api/v1/templates`            | List all templates  |
| GET    | `/api/v1/templates/:id`        | Get single template |
| POST   | `/api/v1/templates`            | Create template     |
| PATCH  | `/api/v1/templates/:id`        | Update template     |
| DELETE | `/api/v1/templates/:id`        | Delete template     |
| POST   | `/api/v1/templates/:id/launch` | Launch template     |

The launch endpoint accepts `{ args?: Record<string, string> }` for runtime arguments.

## Jobs

### Data Model

Jobs are uniquely identified by (`directory`, `name`). Each job references a backing template and adds:

| Field                 | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `templateId`          | References the backing template for agent config                                     |
| `defaultArgs`         | Default argument values for scheduled runs                                           |
| `schedule`            | Cron expression (optional). Jobs without a schedule can still be triggered manually. |
| `timeoutMs`           | Max wall-clock for a run (default 30 min)                                            |
| `needsInputTimeoutMs` | Max time a run may sit in `needs_input` (default 24 h)                               |
| `singleton`           | If true (default), only one run can be active at a time                              |
| `autoArchive`         | If true, the spawned agent is auto-archived when the run completes                   |
| `enabled`             | If false, the cron schedule is skipped but manual runs still work                    |

Agent configuration (prompt, agentType, useWorktree, etc.) is read from the backing template at run time.

### Run Lifecycle

States: `started` → `running` → (`completed` | `failed` | `needs_input` | `timed_out` | `crashed`).

- The runner creates an agent named `job-<slug>-<runId[:8]>` and waits for a terminal MCP call from it (`job_complete` or `job_failed`).
- A run that calls `job_needs_input` transitions to `needs_input` and pauses. Answering it (via the UI or deleting the run) resumes or ends it; an unanswered `needs_input` times out per `needsInputTimeoutMs`.
- Singleton jobs (the default) only allow one active run at a time. Attempting to launch a second run while one is active returns an error.

### Report Shape

The MCP tools `job_complete` / `job_failed` require a report:

```json
{
  "status": "completed",
  "summary": "Processed 3 pull requests.",
  "tasks": [
    {
      "name": "triage-pr-123",
      "status": "success",
      "summary": "Re-ran CI, posted comment"
    },
    {
      "name": "triage-pr-124",
      "status": "error",
      "summary": "Rebase failed",
      "errors": [
        { "message": "Merge conflict in server.ts", "recoverable": false }
      ]
    }
  ]
}
```

`job_log` appends a structured log line (level: `debug|info|warn|error`) onto the named task, creating it if needed. Use it for progress updates between terminal calls.

Report size limits: 1 MB total, 100 tasks, 500 logs per task, 10 KB summary and error-message strings, 5 KB log-message strings.

### Notifications

Jobs emit their own Slack messages (distinct from the per-agent notifications in [docs/16-notifications.md](16-notifications.md)) on the following events, each with an independent webhook URL list:

- `onComplete` — run finished with `status: completed`
- `onError` — run ended as `failed`, `timed_out`, or `crashed`
- `onNeedsInput` — run is waiting on human input

The job agent's `latest-event` notifications are suppressed so you do not double-notify on completion.

### API

See [docs/03-api-spec.md](03-api-spec.md#jobs) for the full endpoint reference. The relevant endpoints are:

- `GET /api/v1/jobs` / `POST|PATCH|DELETE /api/v1/jobs`
- `POST /api/v1/jobs/enable` / `POST /api/v1/jobs/disable`
- `POST /api/v1/jobs/run` — trigger manually (`{ name, directory, wait? }`)
- `GET /api/v1/jobs/stats` / `GET /api/v1/jobs/history`

### MCP Tools (job-scope only)

Job agents are given a narrowed MCP toolset (see `JOB_TOOLS` in `apps/server/src/shared/mcp/server.ts`). The job-lifecycle tools are:

| Tool              | Purpose                                     |
| ----------------- | ------------------------------------------- |
| `job_complete`    | Terminal success. Submits the final report. |
| `job_failed`      | Terminal failure. Submits the final report. |
| `job_needs_input` | Pause the run and ask a human a question.   |
| `job_log`         | Append a progress log to a named task.      |

Job agents may also call analytics tools (`get_activity_summary`, `get_agent_history`, `get_feedback_summary`), lister tools (`list_agents`, `list_personas`, `list_recent_persona_reviews`, `list_recent_feedback`), and `create_pr` / `get_pr_status` / `dispatch_event` / `dispatch_rename_session` / `dispatch_notify`.

## UI

The Automations pane (`/automations`) has a tabbed sidebar with **Templates** and **Jobs** tabs.

- The Templates tab lists callable templates with inline launch buttons. Selecting a template shows its detail view with argument inputs and a Launch button.
- The Jobs tab lists configured jobs with their latest run status. Drill-down views show run history, per-run reports, and the MCP log stream. A run blocked on `needs_input` exposes an answer box that resumes the agent.

Legacy `/jobs` URLs redirect to `/automations/jobs`.
