# Jobs

## Overview

A **job** is a named, repo-scoped agent task that can run on a schedule or on demand. Each invocation is a **run**, which spawns a fresh agent with the job's prompt, posts structured progress via MCP, and returns a terminal `JobReport`.

Jobs are the right mechanism for recurring work (nightly PR triage, release babysitting, janitorial cleanup) and for one-shot tasks where you want a machine-readable outcome instead of a free-form chat transcript.

## Data Model

Jobs are uniquely identified by (`directory`, `name`). Each job has:

| Field                 | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `name`                | Display/slug name, unique within its `directory`                                     |
| `directory`           | Absolute path of the repo the job runs against                                       |
| `prompt`              | User-supplied prompt used as the agent's first turn                                  |
| `schedule`            | Cron expression (optional). Jobs without a schedule can still be triggered manually. |
| `agentType`           | One of `claude`, `codex`, `opencode`                                                 |
| `useWorktree`         | If true, the run gets its own git worktree (default)                                 |
| `branchName`          | Branch for the worktree (optional)                                                   |
| `fullAccess`          | Pass the agent CLI's full-access/bypass-approvals flag                               |
| `timeoutMs`           | Max wall-clock for a run (default 30 min)                                            |
| `needsInputTimeoutMs` | Max time a run may sit in `needs_input` (default 24 h)                               |
| `enabled`             | If false, the cron schedule is skipped but manual runs still work                    |

## Run Lifecycle

States: `started` → `running` → (`completed` | `failed` | `needs_input` | `timed_out` | `crashed`).

- The runner creates an agent named `job-<slug>-<runId[:8]>` and waits for a terminal MCP call from it (`job_complete` or `job_failed`).
- A run that calls `job_needs_input` transitions to `needs_input` and pauses. Answering it (via the UI or deleting the run) resumes or ends it; an unanswered `needs_input` times out per `needsInputTimeoutMs`.
- Only one run per job can be active at a time. The DB enforces this via a unique index on (jobId, active status).

## Report Shape

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

## Notifications

Jobs emit their own Slack messages (distinct from the per-agent notifications in [docs/16-notifications.md](16-notifications.md)) on the following events, each with an independent webhook URL list:

- `onComplete` — run finished with `status: completed`
- `onError` — run ended as `failed`, `timed_out`, or `crashed`
- `onNeedsInput` — run is waiting on human input

The job agent's `latest-event` notifications are suppressed so you do not double-notify on completion.

## API

See [docs/03-api-spec.md](03-api-spec.md#jobs) for the full endpoint reference. The relevant endpoints are:

- `GET /api/v1/jobs` / `POST|PATCH|DELETE /api/v1/jobs`
- `POST /api/v1/jobs/enable` / `POST /api/v1/jobs/disable`
- `POST /api/v1/jobs/run` — trigger manually (`{ name, directory, wait? }`)
- `GET /api/v1/jobs/stats` / `GET /api/v1/jobs/history`

## MCP Tools (job-scope only)

Job agents are given a narrowed MCP toolset (see `JOB_TOOLS` in `apps/server/src/shared/mcp/server.ts`). The job-lifecycle tools are:

| Tool              | Purpose                                     |
| ----------------- | ------------------------------------------- |
| `job_complete`    | Terminal success. Submits the final report. |
| `job_failed`      | Terminal failure. Submits the final report. |
| `job_needs_input` | Pause the run and ask a human a question.   |
| `job_log`         | Append a progress log to a named task.      |

Job agents may also call analytics tools (`get_activity_summary`, `get_agent_history`, `get_feedback_summary`), lister tools (`list_agents`, `list_personas`, `list_recent_persona_reviews`, `list_recent_feedback`), and `create_pr` / `get_pr_status` / `dispatch_event` / `dispatch_rename_session` / `dispatch_notify`.

## UI

The jobs pane (`/jobs`) lists every configured job with its latest run status. Drill-down views show run history, per-run reports, and the MCP log stream. A run blocked on `needs_input` exposes an answer box that resumes the agent.
