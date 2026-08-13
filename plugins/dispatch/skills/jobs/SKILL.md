---
name: jobs
description: Run agent work on a schedule with structured pass/fail reporting and notifications. Use for recurring or unattended work — nightly triage, release babysitting, cleanup — or when a run's outcome must be machine-readable.
---

# Jobs: scheduled and monitored agent runs

A job is automation layered on a template. The template supplies the agent
configuration — prompt, agent type, directory, worktree settings. The job adds
everything that makes an unattended run safe: a cron schedule, timeouts, a
one-at-a-time guarantee, structured reporting, auto-archive, and notifications.

**Template or job?** A template is for work a human launches — quick-start
workflows out of the command palette. A job is for work that runs on its own and
whose outcome someone needs to check later without reading a transcript. If
nobody is watching when it runs, it wants to be a job.

Jobs need a backing template, so start with the `templates` skill if one does not
exist yet.

## Tools

```
list_jobs   — scoped to a directory; prompts omitted (length only)
get_job     — one job by ID, or by name within a directory
create_job  — only `name` is required; everything else has a default
update_job  — identified by name (+ directory); pass only what changes
delete_job  — fails if the job has an active run
run_job     — trigger a run now; returns the run ID and agent ID immediately
```

Jobs are unique per (`directory`, `name`).

## Configuration

| Field                 | Meaning                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `templateId`          | The backing template supplying agent config                       |
| `defaultArgs`         | Values for the template's arguments on scheduled runs             |
| `schedule`            | Cron expression. Optional — a job without one still runs manually |
| `timeoutMs`           | Wall-clock ceiling for a run (default 30 min)                     |
| `needsInputTimeoutMs` | How long a run may sit waiting on a human (default 24 h)          |
| `singleton`           | Default true: only one run active at a time                       |
| `autoArchive`         | Archive the spawned agent when the run completes                  |
| `enabled`             | False skips the cron schedule; manual runs still work             |

Leave `singleton` on unless overlapping runs are genuinely safe — for anything
that touches a branch, a container, or a shared resource, they are not.

`enabled: false` is the right way to pause a job you are debugging. Deleting and
recreating loses its history.

## Run lifecycle

```
started → running → completed | failed | needs_input | timed_out | crashed
```

The runner creates an agent named `job-<slug>-<runId[:8]>` and waits for it to
make a terminal MCP call. A run that ends without one is not "done" — it
eventually times out and reports as such.

## Reporting, from inside a job agent

If you are the agent running a job, these are yours:

```
job_log       — append a structured log line (debug|info|warn|error) to a named task
job_complete  — terminal: the run succeeded
job_failed    — terminal: the run failed
job_needs_input — pause the run pending a human answer
```

The report shape:

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

**One task per unit of work, named stably across runs.** That is what makes a
job's history readable — "this task has failed four nights running" is only
visible if the name stayed the same. `job_log` creates a task if it does not
exist yet, so use it for progress between terminal calls.

Mark `recoverable` honestly. It is the signal that decides whether a human needs
to look tonight.

Limits: 1 MB per report, 100 tasks, 500 logs per task, 10 KB summary and error
strings, 5 KB log messages.

`job_needs_input` pauses the run rather than failing it — the right call when a
decision genuinely requires a human. An unanswered one times out per
`needsInputTimeoutMs`.

## Notifications

Jobs send their own Slack messages, with independent webhook lists per event:
`onComplete` (finished successfully), `onError` (failed, timed out, or crashed),
and `onNeedsInput` (waiting on a human). The job agent's own per-agent
notifications are suppressed so completion does not notify twice.

Wire `onError` and `onNeedsInput` at minimum. A job whose failures are silent is
worse than no job — it looks like coverage without providing any.
