# Dispatch Jobs

Scheduled, repo-scoped agent tasks with structured execution, history, and interactive recovery.

## Overview

Jobs are recurring agent tasks defined in repository files and executed on a schedule by Dispatch. They combine the consistency of scripts (deterministic steps codified as repo tools) with the adaptability of agents (contextual decision-making, interactive recovery when stuck).

Jobs solve the problem of recurring maintenance and operational tasks that today require manually spinning up an agent, re-explaining the task from scratch, and hoping the approach is consistent. With Jobs, the task definition lives in the repo, the mechanical steps are codified as tools, and the agent provides the judgment layer.

## Concepts

### Job Definition

Jobs are fully DB-backed and managed through the Dispatch UI or API. Each job has:

- **Name**: identifier for the job
- **Directory**: the working directory the job agent runs in
- **Prompt**: the task instructions for the agent (markdown)
- **Schedule**: cron expression (e.g., `0 9 * * 1` for every Monday at 9am)
- **Timeout**: max run time before auto-timeout (default: 30 minutes)
- **Needs-input timeout**: how long to wait for human input before timing out (default: 24 hours)
- **Agent type**: claude, codex, or opencode
- **Use worktree**: whether to create a git worktree for the job run
- **Branch name**: if using a worktree, the branch to use
- **Permission scope**: full access or restricted
- **Notify**: per-event notification config (on_complete, on_error, on_needs_input)
- **Enabled/disabled** toggle

A job's identity is `(directory, name)` — the same job name in two different directories produces two independent jobs with separate schedules, settings, and history.

## Execution Model

### Job Lifecycle

```
scheduled → started → running → completed | failed | needs_input
                                                ↗
                                  (resume from needs_input)
```

| State | Description |
|-------|-------------|
| **scheduled** | Cron trigger is pending; job has not started yet |
| **started** | Agent is being spawned and initialized |
| **running** | Agent is actively executing the job |
| **needs_input** | Agent is paused, waiting for human decision. This is a hard pause — the agent stops working until a human responds |
| **completed** | All tasks finished. Agent submitted a structured report |
| **failed** | An unrecoverable error stopped the job. Agent reported what failed and why |
| **timed_out** | Job exceeded its `timeout` or `needs_input_timeout` without completing |

### Structured Reporting

When a job finishes, the agent doesn't just say "done" in prose. It submits a **job report** via a dedicated tool — a structured object that the framework requires before it will accept a terminal state:

```json
{
  "status": "completed",
  "summary": "All 3 cleanup tasks completed. 2 rogue containers removed, 3 tmux sessions killed, 0 databases dropped.",
  "tasks": [
    {
      "name": "dev-cleanup",
      "status": "success",
      "summary": "Found 2 rogue containers, cleaned up both",
      "errors": []
    },
    {
      "name": "tmux-cleanup",
      "status": "success",
      "summary": "Killed 3 abandoned sessions",
      "errors": [
        {
          "message": "Session dispatch_agt_x had uncommitted work — skipped, flagged for review",
          "recoverable": true,
          "action": "skipped cleanup"
        }
      ]
    },
    {
      "name": "db-cleanup",
      "status": "skipped",
      "summary": "No candidate databases found",
      "errors": []
    }
  ]
}
```

### Error Classification

Jobs distinguish between three outcomes that aren't "success":

1. **Recoverable error** — Something went wrong in one step, but the job can continue. The error is logged in the task report, but execution proceeds. Example: "Couldn't drop one database because it had active connections — skipped it."

2. **Fatal error** — The job cannot proceed at all. Example: "Can't connect to Postgres" or "Dispatch API is unreachable so I can't validate any ownership." The job stops and the run is marked `failed`.

3. **Needs input** — Not an error, but a decision point where the agent needs human judgment. Example: "Found a tmux session with uncommitted work for an agent in error state. Kill it or leave it?" The job pauses until a human responds.

### Framework Guardrails

The job runner (not the agent) enforces these constraints:

- **Timeout**: If the agent hasn't emitted a terminal state within the configured `timeout`, the run is marked `timed_out`.
- **Terminal state required**: The agent must call a `job_complete` or `job_failed` tool to finish. Freeform "I'm done" in prose doesn't count. The framework won't close the run without a structured report.
- **Needs-input timeout**: If the agent asks for help and nobody responds within `needs_input_timeout`, the run is marked `timed_out` with the pending question logged.
- **Crash detection**: If the agent process dies (crash, OOM, tmux session ends) without a terminal event, the framework marks it as a crash with whatever logs are available.
- **Concurrency guard**: If a job is still running when the next cron trigger fires, the new run is skipped and logged. No two runs of the same job overlap.

## Scheduling

### Cron-based

Scheduling uses the `croner` library in-process. Dispatch manages cron schedules internally — no system crontab manipulation.

- Enabling a job with a schedule starts an in-process cron timer
- Disabling a job stops its timer
- Schedules are standard 5-field cron expressions

### Manual Trigger

Jobs can be triggered manually via the "Run now" button in the Jobs UI or the `POST /api/v1/jobs/run` API endpoint.

### What Happens on Trigger

1. Dispatch spawns an agent with the job's prompt (from the markdown body) plus any server-side additional instructions
2. Agent type, worktree, permissions, and branch come from the server-side config
3. The agent gets access to the repo's tools from `.dispatch/tools.json`
4. The framework monitors the agent for timeout and crash conditions
5. On completion, the structured report is stored as a run in the job's history
6. Notifications fire based on the job's `notify` config and the globally configured channels

## Notifications

Jobs reference notification channels by name (e.g., `['slack']`). The actual webhook URLs and channel configs live in Dispatch's global settings (Settings > Notifications), which already exists today.

```yaml
notify:
  on_complete: []               # routine success — don't bother me
  on_error: ['slack']           # something failed — tell me
  on_needs_input: ['slack']     # need my help — tell me
```

Empty array means no notification for that event. This is extensible to future channels (`['slack', 'discord', 'email']`) without changing the schema.

Notifications for job events are distinct from the existing agent notification settings. The global agent notifications (done, waiting, blocked) continue to work as they do today for regular agents. Job notifications are controlled per-job in the job definition file.

## UI Integration

### Jobs Dialog

A new bottom nav icon in the left sidebar (4th icon, alongside Docs, Activity, Settings) opens the Jobs dialog. The dialog follows the same pattern as Settings and Activity — a modal overlay with its own navigation.

#### Overview

The main view lists all discovered jobs across all directories:

| Column | Description |
|--------|-------------|
| Job name | From the frontmatter `name` field |
| Directory | Source repo/directory path |
| Schedule | Human-readable (e.g., "Every Monday at 9:00 AM") |
| Status | Enabled/disabled toggle |
| Last run | Status badge (completed/failed/timed_out) + timestamp |
| Next run | Calculated from cron expression |
| Actions | "Run now" button |

#### Job Detail

Clicking a job row opens a detail view with tabs:

**Configure tab** — Job configuration:
- Job name, directory, agent type (claude/codex/opencode)
- Schedule (cron expression), timeout, needs-input timeout
- Worktree toggle + branch name field
- Permission scope toggle (full access)
- Notification preferences (on_complete, on_error, on_needs_input)

**Prompt tab** — The job prompt (markdown instructions for the agent).

**History tab** — List of past runs:
- Timestamp, duration, status badge
- Click a run to see the full structured report (task-by-task results with errors)
- Run retention: configurable, default 50 runs

**Active run banner** — If a job is currently running, a prominent banner at the top links to the live agent session in the main panel.

### Agent List Integration

Job-spawned agents appear in the normal agent list in the left sidebar, but visually distinguished:
- Badge or icon indicating it's a job run (e.g., "janitor - run #12")
- Clicking focuses the agent in the main panel with terminal, pins, media — identical to any other agent
- This is how you "hop into a running job session" when you get a `needs_input` notification

### Docs

A new "Jobs" entry in the Docs sidebar explaining the feature, configuration format, and workflows.

## User Flows

### Setup Flow

1. User opens the Jobs pane and clicks "Add Job"
2. Fills in name, directory, agent type, prompt, schedule, and other settings
3. Job is created in the database (disabled by default)
4. User toggles the job to enabled
5. Dispatch starts the in-process cron timer — job will run on schedule

### Routine Run

1. Cron fires at the scheduled time
2. Dispatch spawns an agent with the job definition
3. Agent executes the tasks, using repo tools for mechanical steps
4. Agent submits structured report via `job_complete`
5. Run is stored in history
6. No notification (routine success, `on_complete: []`)

### Run Needs Help

1. Agent hits an ambiguous situation during a job run
2. Agent calls `needs_input` with a description of the decision needed
3. Dispatch sends Slack notification (per `on_needs_input: ['slack']`)
4. User opens Dispatch UI, sees the job has an active run needing input
5. User clicks into the live agent session via the agent list
6. User provides guidance in the terminal
7. User disconnects — agent continues and finishes
8. Run completes, stored in history

### Investigating a Failure

1. Job run fails — agent calls `job_failed` with error details
2. Slack notification fires (per `on_error: ['slack']`)
3. User opens Jobs dialog, goes to the job's History tab
4. User clicks the failed run to see the structured report
5. Sees which task failed, the error message, and what succeeded
6. If the session is still alive, can click into it for the full transcript
7. Optionally clicks "Run now" to retry

### Manual Run

1. User clicks "Run now" on a job (enabled or disabled — manual trigger always works)
2. Same execution flow as a scheduled run
3. Agent appears in the agent list, user can watch live if desired

## Implementation Considerations

### Repo Tools Integration

The mechanical steps of a job (query an API, list Docker containers, check a database) should be codified as repo tools in `.dispatch/tools.json`. This gives the agent consistent, fast operations rather than rediscovering how to do things each run. The agent provides judgment on top of deterministic tool results.

### Job-Specific Agent Tools

The framework provides job-specific tools to the agent:

- `job_complete(report)` — Submit a structured report and mark the run as completed
- `job_failed(report)` — Submit a structured report and mark the run as failed
- `job_needs_input(question)` — Pause execution and notify for human input
- `job_log(task, message, level)` — Structured logging within a task (for building up the report incrementally)

These replace the freeform `dispatch_event` for job execution. Regular `dispatch_event` continues to work for agent-list status display, but the job lifecycle is controlled through these dedicated tools.

### Auth Token Access

Jobs that need to query the Dispatch API (e.g., checking which agents are running) need access to the auth token. This should be provided as an environment variable to the job agent, or exposed via a repo tool that handles authentication internally.

### API

Jobs are managed via the REST API:

- `GET /api/v1/jobs` — list all jobs (with latest run info)
- `POST /api/v1/jobs` — create a new job
- `PATCH /api/v1/jobs` — update job configuration
- `DELETE /api/v1/jobs` — delete a job
- `POST /api/v1/jobs/enable` — enable a job
- `POST /api/v1/jobs/disable` — disable a job
- `POST /api/v1/jobs/run` — trigger a job run
- `GET /api/v1/jobs/stats` — job execution statistics
- `GET /api/v1/jobs/history` — job run history
