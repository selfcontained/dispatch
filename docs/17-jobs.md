# Automations: Templates & Jobs

## Overview

The Automations system has two layers:

- **Templates** — reusable agent launch configurations. A template captures a prompt, agent type, directory, worktree settings, and an optional set of runtime arguments (`{{D:Arg Name}}` with optional filter-style modifiers like `|required|multiline`). Templates can be launched from the Cmd+K command palette or the Automations UI to spin up a normal agent session with no supervision.

- **Jobs** — automation on top of a template. A job references a backing template and adds scheduling (cron), timeouts, singleton enforcement, structured reporting via MCP, auto-archive, and webhook triggers. Each job invocation is a **run**. Creating a job auto-creates its backing template with `callable: false`; `GET /api/v1/templates` filters job-backed templates out, so they never show up in the Templates tab or the palette.

Templates are the right choice for quick-launch workflows (code review, feature scaffolding, ad-hoc tasks). Jobs are for recurring or monitored work (nightly triage, release babysitting, janitorial cleanup) where you want a machine-readable outcome.

## Templates

### Data Model

Templates are uniquely identified by (`directory`, `name`). Each template has:

| Field         | Description                                                 |
| ------------- | ----------------------------------------------------------- |
| `name`        | Display name, unique within its `directory`                 |
| `description` | Optional short description shown in Cmd+K and launch views  |
| `directory`   | Absolute path of the repo the template runs against         |
| `prompt`      | User-supplied prompt used as the agent's first turn         |
| `agentType`   | Any of `claude`, `codex`, `cursor`, `opencode`, `terminal`  |
| `model`       | Optional model id, validated against the agent type         |
| `useWorktree` | If true, the agent gets its own git worktree                |
| `baseBranch`  | Base branch for the worktree (optional)                     |
| `branchName`  | Branch for the worktree (optional)                          |
| `fullAccess`  | Pass the agent CLI's full-access/bypass-approvals flag      |
| `callable`    | If true, the template appears in the Cmd+K command palette  |
| `allowMedia`  | Default true: show a Context area for files/links at launch |
| `selfImprove` | Append run-only guidance to revise the saved prompt         |

Templates take the full agent-type table (`AGENT_TYPES`); jobs take the CLI subset (`CLI_AGENT_TYPES`), since a terminal agent cannot run a job.

### Runtime Arguments

Templates support `{{D:Arg Name}}` placeholders in their prompt. Arguments are optional by default. Add `|required` to make one mandatory at launch, and `|multiline` (or `|textarea`) to render a textarea instead of a single-line input. Arguments are also pinned to the spawned agent's sidebar for reference.

If you leave an optional argument blank, Dispatch removes that placeholder and leaves the surrounding text as-is. Write prompts so they still read naturally when optional values are omitted.

Example prompt:

```
Review the PR at {{D:PR URL|required}} and focus on {{D:Review Focus|multiline}}.
```

This creates a required single-line field ("PR URL") and an optional multiline field ("Review Focus").

If the same argument appears more than once, modifiers are merged. An argument is treated as `required` or `multiline` if any occurrence uses that modifier.

### Command Palette (Cmd+K)

Templates with `callable: true` appear in the Cmd+K command palette under a "Templates" group.

Selecting one always opens the launch dialog — there is no confirmation-only path, even for templates with no arguments. The dialog carries an agent-type override, a model override for types with a curated catalog, any argument fields, and (when `allowMedia` is on) a Context area for files and links. The inline play button in the Templates list opens the same dialog.

After launch, the agent record is optimistically added to the sidebar cache and the URL navigates to it immediately. The launch endpoint returns the full agent record (matching the create-agent response shape).

### API

| Method | Path                           | Description         |
| ------ | ------------------------------ | ------------------- |
| GET    | `/api/v1/templates`            | List all templates  |
| GET    | `/api/v1/templates/:id`        | Get single template |
| POST   | `/api/v1/templates`            | Create template     |
| PATCH  | `/api/v1/templates/:id`        | Update template     |
| DELETE | `/api/v1/templates/:id`        | Delete template     |
| POST   | `/api/v1/templates/:id/launch` | Launch template     |

The launch endpoint accepts `{ args?: Record<string, string> }` for runtime arguments and returns `{ agent }` with the full agent record.

## Jobs

### Data Model

Jobs are uniquely identified by (`directory`, `name`). Each job references a backing template and adds:

| Field                 | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `templateId`          | References the backing template for agent config                                     |
| `defaultArgs`         | Values substituted into the template's `{{D:...}}` placeholders on every run         |
| `schedule`            | Cron expression (optional). Jobs without a schedule can still be triggered manually. |
| `timeoutMs`           | Max wall-clock for a run (default 30 min)                                            |
| `needsInputTimeoutMs` | Max time a run may sit in `needs_input` (default 24 h)                               |
| `singleton`           | If true (default), only one run can be active at a time                              |
| `autoArchive`         | If true, the spawned agent is auto-archived when the run completes                   |
| `enabled`             | If false, the cron schedule is skipped but manual runs still work                    |
| `callable`            | Stored flag; renders a "callable" badge in the jobs list and nothing else            |
| `webhookEnabled`      | Generates `webhookSecret` on save, exposing `POST /api/v1/jobs/webhook/:secret`      |
| `notify`              | Per-job Slack routing. Read-only today — no write path, so it is always null         |

Agent configuration (prompt, agentType, model, useWorktree, fullAccess, selfImprove) is read from the backing template at run time; the job's own copies of those columns are legacy fallbacks. `defaultArgs` is settable only through `POST`/`PATCH /api/v1/jobs` — no UI or MCP tool exposes it, and substitution is skipped entirely when the map is empty.

### Run Lifecycle

States: `started` → `running` → (`completed` | `failed` | `needs_input` | `timed_out` | `crashed`).

- The runner creates an agent named `job-<slug>-<runId[:8]>` and waits for a terminal MCP call from it (`job_complete` or `job_failed`).
- A run that calls `job_needs_input` transitions to `needs_input` and pauses. The Jobs UI surfaces the pending question on the run's History entry but has no answer box — you reply in the agent's own terminal session and the agent then calls a terminal tool. An unanswered `needs_input` times out per `needsInputTimeoutMs`.
- `timeoutMs` is checked against the run's start time on every monitor tick, for every active status. A run sitting in `needs_input` is therefore killed by `timeoutMs` first whenever `timeoutMs < needsInputTimeoutMs` — which the 30 min / 24 h defaults guarantee.
- If the agent session ends before a terminal call (agent `stopped`/`error`, or its tmux session gone), the monitor marks the run `crashed`.
- Both timeouts are snapshotted into `run.config` when the run is created, so editing the job mid-run does not change the run already in flight.
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

### Continuation (Loop Jobs)

A job with `continuationEnabled: true` is a **Loop job**: each completed run can start another one automatically, forming a chain. Four columns on `jobs` carry the config:

| Field                  | Description                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `continuationEnabled`  | Turns looping on. `addJob`/`updateJob` require a schedule OR this before `enabled` can be true.                                      |
| `maxIterations`        | Cap on runs per chain. On create, defaults to `10` if `continuationEnabled` is true and the field is omitted; `null` means no limit. |
| `completionCriteria`   | String list injected into the run preamble as "Completion criteria" bullets.                                                         |
| `recoveryInstructions` | Free text injected as "Recovery instructions"; `"Not specified."` if unset.                                                          |

Creating a Loop job also forces `autoArchive: true` regardless of the caller's `autoArchive` input — each iteration's agent is archived once its run completes, since chain state travels through Brain and `job_runs`, not the agent record.

Each run row additionally carries `chainId` (random per chain, i.e. per "Run now" or scheduled loop start), `chainIteration` (starts at 1, increments per successor), and `continuationOfRunId` (the predecessor run). A run started this way has `config.triggerSource = "continuation"`.

`job_complete`'s report accepts an optional `continuation` object:

```json
{
  "status": "completed",
  "summary": "...",
  "tasks": [...],
  "continuation": {
    "action": "continue",
    "phase": "optional short phase name",
    "summary": "outcome of this run",
    "nextIntent": "what the next run should do first",
    "filePaths": ["relevant/file.ts"],
    "blockers": ["unresolved issue"]
  }
}
```

`action` is one of `continue`, `pause`, `finish`, or `default` (continue-if-under-cap, same as omitting `continuation` entirely). `nextIntent` is required whenever the run will continue. The successor only starts when: the job is still `enabled`, `continuationEnabled` is true, `action` is `continue`/`default`, and (`maxIterations` is null or `chainIteration < maxIterations`). Reaching the cap or `action: "pause"` ends the chain without touching `enabled` — a later cron trigger or "Run now" starts a fresh chain (`chainIteration` resets to 1). `action: "finish"` additionally sets `enabled = FALSE`.

Between runs, the compact handoff (`action`, `phase`, `summary`, `nextIntent`, `filePaths`, `blockers`, plus `chainId`/`iteration`/`recoveryAttempt`) is written to the Brain object `job-continuations/job-<jobId>`, scoped to the job directory's shared repo root (`git --git-common-dir`) so a per-run worktree still resolves to the same object the previous run wrote. The next run's preamble points at that Brain key and does not expect the handoff to be repeated in its own prompt. Loop jobs may use `useWorktree`/`baseBranch`/`branchName` like any other job — a fresh worktree per run does not break the chain.

### Notifications

`JobNotifier` is wired into the run-state-change callback and can route a run to Slack on three events — `onComplete` (`completed`), `onError` (`failed`, `timed_out`, `crashed`), and `onNeedsInput` — each with its own channel list, using the same `slack_webhook_url` setting as agent notifications.

**None of it fires today.** The channel lists come from `job.notify`, and no code path writes that column: it is absent from `createJob`'s insert, from `JobConfigUpdate`, from the routes' Zod schemas, and from the MCP `create_job`/`update_job` tools. `buildRunConfig` falls back to three empty arrays, so `getNotifyChannels` always returns none and the notifier returns before sending. Treat this as a data model waiting on a write path, not a shipped feature.

What does notify is the ordinary per-agent path, and only half of it: a job agent's `done`, `waiting_user`, and `blocked` events raise browser notifications like any other agent's, but `createNotificationRuntime` skips the Slack send for any agent whose name starts with `job-` and has a job run. So a job run's status events never reach Slack through that path either. Agents can call `dispatch_notify` directly, which is in `JOB_TOOLS`, and that path has no job exclusion.

### API

See [docs/03-api-spec.md](03-api-spec.md#jobs) for the full endpoint reference. The relevant endpoints are:

- `GET /api/v1/jobs` / `POST|PATCH|DELETE /api/v1/jobs`
- `POST /api/v1/jobs/enable` / `POST /api/v1/jobs/disable`
- `POST /api/v1/jobs/run` — trigger manually (`{ name, directory, wait? }`)
- `POST /api/v1/jobs/webhook/:secret` — unauthenticated trigger, rate-limited to 10/min, returns `{ jobId, runId }` and never waits
- `GET /api/v1/jobs/stats` / `GET /api/v1/jobs/history`

### MCP Tools (job-scope only)

Job agents are given a narrowed MCP toolset (see `JOB_TOOLS` in `apps/server/src/shared/mcp/server.ts`). The job-lifecycle tools are:

| Tool              | Purpose                                     |
| ----------------- | ------------------------------------------- |
| `job_complete`    | Terminal success. Submits the final report. |
| `job_failed`      | Terminal failure. Submits the final report. |
| `job_needs_input` | Pause the run and ask a human a question.   |
| `job_log`         | Append a progress log to a named task.      |

Job agents may also call analytics tools (`get_activity_summary`, `get_feedback_summary`), lister tools (`list_agents`, `list_personas`), and `create_pr` / `get_pr_status` / `dispatch_event` / `dispatch_rename_session` / `dispatch_notify`.

## UI

The Automations pane (`/automations`) has a tabbed sidebar with **Templates**, **Jobs**, and **Brains** tabs.

Templates and Jobs share a flat-list layout with border separators, a right-aligned Create button, and a sliding indicator that animates between tabs. Brains is a collection-first browser over the repo-scoped Brain.

- The **Templates** tab lists every non-job-backed template — callable or not — with an inline play button that opens the launch dialog. Selecting a template shows its detail view with a Launch button and an editable configuration form.
- The **Jobs** tab lists configured jobs with their latest run status, and an Overview dashboard (no job selected) with 7-day stats, charts, Upcoming, and Recent Activity. A selected job has **Configure**, **Prompt**, and **History** tabs; expanding a History row shows the run's report, its tasks, and the last five `job_log` lines per task. A run blocked on `needs_input` shows its pending question there — answering happens in the agent's terminal, not in this pane.

Legacy `/jobs` URLs redirect to `/automations/jobs`.
