# Janitor

Clean up stale or orphaned resources left behind by Dispatch development and test processes that were not shut down properly. Run the four cleanup tasks in order and report results using the structured job tools.

You have repo tools available for gathering data: `list_dev_containers`, `list_agents`, `list_dispatch_sessions`, `list_candidate_databases`. Use these instead of running the equivalent commands manually. You also have `dev_down` with an optional `suffix` param for cleaning up dev instances. Use Docker commands directly for the E2E resource inspection in Task 2.

## Safety rules for every task

- Target only resources whose names or Compose labels clearly identify them as Dispatch-owned development or E2E resources. Never use broad cleanup commands such as `docker system prune` or `docker network prune`.
- Preserve every active dev or E2E environment. Treat a resource as active when it belongs to a running or creating agent, has a live state-file PID, has a running container, was created less than 24 hours ago, or otherwise has evidence of current use.
- Inspect resource state and attachments before every destructive action, then re-check immediately before removal to avoid acting on stale observations.
- **Never remove a Docker network with attached containers.** A network with one or more entries in Docker's `.Containers` map is active for cleanup purposes, regardless of resource age or any other signal.
- Skip ambiguous resources and use `job_needs_input` when ownership or activity cannot be established safely. Never guess when cleanup could interrupt work or destroy data.

## Task 1: dev-cleanup

Find and remove rogue `dispatch-dev` server instances.

### Procedure

1. Call `list_dev_containers` to find all dispatch-dev Postgres containers.
2. If none are running, log "No dispatch-dev containers found" and skip to Task 2.
3. Extract the suffix from each container name (strip the `dispatch-postgres-` prefix).
4. Call `list_agents` to get all agents and their statuses.
5. For each suffix, classify:
   - **Active agent**: Suffix starts with `agt_` and the agent exists in `running` or `creating` status. Do not touch.
   - **Rogue agent**: Suffix starts with `agt_` but the agent is `stopped`, `error`, or not found in the API, AND no matching worktree exists in `.dispatch/worktrees/`. Clean up.
   - **Non-agent container** (E2E tests or manual dev servers; suffix does not start with `agt_`): Check whether `/tmp/dispatch-dev-<SUFFIX>.env` exists and read `DEV_API_PID` from it. If the PID is alive (`kill -0 <PID>` succeeds), it is an active dev/test server; do not touch. If the PID is dead or no state file exists, it is orphaned and may be cleaned up.
6. Re-check the agent status, worktree, state file, PID, and container state immediately before cleanup. If the instance is still rogue/orphaned, call `dev_down` with the `suffix` param set to the suffix.
7. Log each action taken.

### Key paths

- State files: `/tmp/dispatch-dev-<SUFFIX>.env`
- Docker containers: `dispatch-postgres-<SUFFIX>`
- Worktrees: `.dispatch/worktrees/`

## Task 2: e2e-cleanup

Find and remove stale, unused Docker resources from isolated Dispatch E2E Compose projects. The highest-priority targets are orphaned `dispatch-e2e-*_default` networks, which can exhaust Docker's predefined address pools even when no containers remain.

### Procedure

1. List candidate networks with `docker network ls --filter name=dispatch-e2e --format '{{.ID}}\t{{.Name}}'`.
2. Keep only names that match the Dispatch E2E Compose pattern `^dispatch-e2e-.+_default$`. Ignore all other networks.
3. Inspect each candidate with `docker network inspect`. Record its Compose project label, creation time, and the complete `.Containers` attachment map.
4. Preserve the network without exception if `.Containers` has any entries. `docker network inspect --format '{{len .Containers}}' <network>` must return `0` before the network can be considered for cleanup.
5. Derive the Compose project name by removing the `_default` suffix. Check all containers, including stopped containers, with `docker ps -a --filter label=com.docker.compose.project=<project>`. Preserve the network if any project container exists, if the network is less than 24 hours old, or if any other signal suggests an E2E run is active.
6. A candidate is removable only when all of the following are true: its name exactly matches the Dispatch E2E pattern, it is at least 24 hours old, its `.Containers` map is empty, no Compose-project containers exist, and ownership/state are unambiguous.
7. Immediately before removal, inspect the network again and verify that `{{len .Containers}}` is still `0`. Remove only that network with `docker network rm <network-id>`. If it gained an attachment or disappeared, skip it.
8. Inspect related `dispatch-e2e-*` containers or volumes only when their names or Compose labels establish Dispatch ownership. Remove them only if they are at least 24 hours old, stopped/unattached, belong to no active E2E project, and pass a fresh state check. Otherwise preserve them or ask for input.
9. Log every candidate inspected, every active or ambiguous resource preserved, and every orphan removed.

## Task 3: tmux-cleanup

Find and kill abandoned Dispatch tmux sessions.

### Procedure

1. Call `list_dispatch_sessions` to get tmux sessions belonging to this Dispatch server.
2. If none are found, log "No dispatch tmux sessions found" and skip to Task 4.
3. Call `list_agents` (reuse the response from Task 1 if available) to get agent statuses.
4. Extract the agent ID from each session name (the `agt_<12hex>` portion).
5. Classify each session:
   - **Active**: Agent ID is in `running` or `creating` status. Do not touch.
   - **Abandoned**: Agent ID is `stopped`, `error`, `archiving`, or not found in the API.
6. Re-check the agent status immediately before cleanup. For each session that is still abandoned and has no ambiguous signs of active work, run `tmux kill-session -t <session_name>`.
7. Log each action taken.

## Task 4: db-cleanup

Find and drop orphaned test/dev databases on local Postgres.

### Procedure

1. Call `list_candidate_databases` to get all `dispatch_*` databases on local Postgres.
2. If only `dispatch` is returned or nothing is returned, log "No candidate databases found" and finish.
3. Filter out protected databases:
   - **Always exclude `dispatch`** — this is the production database. Never drop it.
   - **Exclude databases referenced by live dispatch-dev state files** — scan `/tmp/dispatch-dev-*.env` files, look for `DATABASE_URL` values pointing at port 5432, extract the database name, and exclude them.
   - **Exclude recent `dispatch_test_*` databases** — the name format is `dispatch_test_<epoch_millis>_<random>`. Parse the epoch-millis timestamp. If it is less than 1 day old (86400000 ms), skip it.
4. Re-check state files, PIDs, and database activity immediately before removal. For each remaining database, run: `PGPASSWORD=dispatch psql -h 127.0.0.1 -p 5432 -U dispatch -d postgres -c 'DROP DATABASE IF EXISTS "<dbname>"'`.
5. Log each action taken.

### Database-specific safety rules

- Never drop `dispatch`; it is hardcoded as protected.
- Preserve `dispatch_test_*` databases less than one day old.
- Preserve any database referenced by a live dispatch-dev state file.

## Reporting

Use `job_log` to report progress as you work through each task.

When all tasks are complete, call `job_complete` with a report containing one entry per task:

- `status`: `success` if the task ran and cleaned up (or had nothing to clean), `skipped` if it was not applicable, `error` if something went wrong but the job continued.
- `summary`: Brief description of what was found, what was preserved as active, and what was removed.
- `errors`: Any recoverable errors encountered (for example, ambiguous dev server suffixes, attached/active E2E resources that were skipped, or databases that could not be dropped).

If a fatal error prevents the job from continuing (for example, Docker is unavailable, the Dispatch API cannot be reached, or Postgres cannot be reached), call `job_failed` with a report explaining what happened and which tasks completed before the failure.

Use `job_needs_input` when you encounter ambiguous resources that need human judgment—for example, dev containers with non-agent suffixes, E2E resources whose activity cannot be established, or tmux sessions with uncommitted work for an agent in error state. Pause and ask rather than guess.
