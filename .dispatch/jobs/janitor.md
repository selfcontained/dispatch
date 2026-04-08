---
name: Janitor
schedule: "0 10 * * *"
timeout: 15m
needs_input_timeout: 18h
full_access: true
notify:
  on_complete: []
  on_error:
    - slack
  on_needs_input:
    - slack
---

# Janitor

Clean up orphaned resources left behind by dispatch agents that weren't shut down properly. Run three cleanup tasks in order, report results using the structured job tools.

You have repo tools available for gathering data: `list_dev_containers`, `list_agents`, `list_dispatch_sessions`, `list_candidate_databases`. Use these instead of running the commands manually. You also have `dev_down` with an optional `suffix` param for cleaning up dev instances.

## Task 1: dev-cleanup

Find and remove rogue `dispatch-dev` server instances.

### Procedure

1. Call `list_dev_containers` to find all dispatch-dev Postgres containers.
2. If none are running, log "No dispatch-dev containers found" and skip to Task 2.
3. Extract the suffix from each container name (strip the `dispatch-postgres-` prefix).
4. Call `list_agents` to get all agents and their statuses.
5. For each suffix, classify:
   - **Active agent**: Suffix starts with `agt_` and the agent exists in `running` or `creating` status. Do not touch.
   - **Rogue agent**: Suffix starts with `agt_` but the agent is `stopped`, `error`, or not found in API, AND no matching worktree exists in `.dispatch/worktrees/`. Clean up.
   - **Non-agent container** (e2e tests, manual dev servers — suffix does NOT start with `agt_`): Check if `/tmp/dispatch-dev-<SUFFIX>.env` exists and read `DEV_API_PID` from it. If the PID is alive (`kill -0 <PID>` succeeds), it's an active dev/test server — do not touch. If the PID is dead or no state file exists, it's orphaned — clean up.
6. For each rogue/orphaned instance, call `dev_down` with the `suffix` param set to the suffix.
7. Log each action taken.

### Key paths
- State files: `/tmp/dispatch-dev-<SUFFIX>.env`
- Docker containers: `dispatch-postgres-<SUFFIX>`
- Worktrees: `.dispatch/worktrees/`

## Task 2: tmux-cleanup

Find and kill abandoned Dispatch tmux sessions.

### Procedure

1. Call `list_dispatch_sessions` to get tmux sessions belonging to this Dispatch server.
2. If none found, log "No dispatch tmux sessions found" and skip to Task 3.
3. Call `list_agents` (reuse the response from Task 1 if available) to get agent statuses.
4. Extract the agent ID from each session name (the `agt_<12hex>` portion).
5. Classify each session:
   - **Active**: Agent ID is in `running` or `creating` status. Do not touch.
   - **Abandoned**: Agent ID is `stopped`, `error`, `archiving`, or not found in API.
6. For each abandoned session, run `tmux kill-session -t <session_name>`.
7. Log each action taken.

## Task 3: db-cleanup

Find and drop orphaned test/dev databases on local Postgres.

### Procedure

1. Call `list_candidate_databases` to get all `dispatch_*` databases on local Postgres.
2. If only `dispatch` is returned or nothing, log "No candidate databases found" and finish.
3. Filter out protected databases:
   - **Always exclude `dispatch`** — this is the production database. Never drop it.
   - **Exclude databases referenced by live dispatch-dev state files** — scan `/tmp/dispatch-dev-*.env` files, look for `DATABASE_URL` values pointing at port 5432, extract the database name, and exclude them.
   - **Exclude recent `dispatch_test_*` databases** — the name format is `dispatch_test_<epoch_millis>_<random>`. Parse the epoch-millis timestamp. If it is less than 1 day old (86400000 ms), skip it.
4. For each remaining database, run: `PGPASSWORD=dispatch psql -h 127.0.0.1 -p 5432 -U dispatch -d postgres -c 'DROP DATABASE IF EXISTS "<dbname>"'`.
5. Log each action taken.

### Safety rules
- NEVER drop `dispatch` — hardcoded exclusion.
- 1-day age threshold for `dispatch_test_*` databases.
- Exclude any DB referenced by a live dispatch-dev state file.

## Reporting

Use `job_log` to report progress as you work through each task.

When all tasks are complete, call `job_complete` with a report containing one entry per task:
- `status`: `success` if the task ran and cleaned up (or had nothing to clean), `skipped` if it was not applicable, `error` if something went wrong but the job continued.
- `summary`: Brief description of what was found and done.
- `errors`: Any recoverable errors encountered (e.g., ambiguous dev server suffixes, databases that couldn't be dropped).

If a fatal error prevents the job from continuing (e.g., cannot reach the Dispatch API, cannot connect to Postgres), call `job_failed` with a report explaining what happened and which tasks completed before the failure.

Use `job_needs_input` when you encounter ambiguous resources that need human judgment — for example, dev containers with non-agent suffixes, or tmux sessions with uncommitted work for an agent in error state. Pause and ask rather than guess.
