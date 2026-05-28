Triage the deferred-work intake queue: deduplicate items, route them into the correct recurring job's Brain backlog, and clean up processed entries. This job runs on a recurring schedule.

## Important context

Dispatch is a local-first control plane for running and managing multiple AI coding agents. Agents report deferred work via the `dispatch_report_deferred_work` MCP tool, which places items into a shared intake queue. This triage job reads that queue and routes items into job-specific Brain collections so the right recurring job picks them up.

## Brain layout

### Intake queue (source — read and drain)

- **Intake list** (collection: `deferred-work`, name: `intake`) — read with `brain_list_get`. Each item is a JSON object with fields:
  - `kind` — one of: `flake`, `coverage_gap`, `tech_debt`, `componentization`, `docs_gap`, `bug`, `refactor`, `other`
  - `summary` — short description
  - `details` — longer context (may be null)
  - `files` — array of file paths
  - `evidence` — structured supporting data
  - `priority` — `low`, `medium`, or `high`
  - `suggestedJob` — optional hint for routing
  - `reportedBy` — agent ID that reported the item
  - `reportedAt` — ISO timestamp
  - `status` — always `pending` when in the intake queue

### Routing targets (destination — push into)

Each recurring job owns a Brain collection with a `backlog` list. Route items by pushing into the appropriate list:

| Kind               | Target collection | Target list | Notes                        |
| ------------------ | ----------------- | ----------- | ---------------------------- |
| `flake`            | `test-enforcer`   | `flakes`    | Flaky test observations      |
| `coverage_gap`     | `test-enforcer`   | `backlog`   | Missing test coverage        |
| `bug`              | `test-enforcer`   | `backlog`   | Bugs exposed by tests        |
| `componentization` | `componentizer`   | `backlog`   | Oversized components         |
| `tech_debt`        | `tech-debt`       | `backlog`   | Code quality issues          |
| `refactor`         | `tech-debt`       | `backlog`   | Structural improvements      |
| `docs_gap`         | `docs-audit`      | `backlog`   | Missing/stale documentation  |
| `other`            | `deferred-work`   | `unrouted`  | Items that don't match a job |

If `suggestedJob` is set and maps to a known job, prefer that routing over the default kind-based routing. Known job names: `test-enforcer`, `componentizer`, `tech-debt`, `docs-audit`.

### Triage state (own state)

1. **Core state** (collection: `deferred-work`, name: `triage-state`) — read with `brain_get_object`. **Save the `revision`** for `expectedRevision` when updating.
   - `last_run_at` — ISO timestamp of the last triage run
   - `items_processed` — total items processed across all runs
   - `items_routed` — breakdown by target job

2. **Run history** — log each run with `brain_append_event`:
   - collection: `deferred-work`
   - kind: `triage-run`
   - subject: `deferred-work-triage`
   - value: `{ "date": "<today>", "processed": <count>, "routed": { "<job>": <count>, ... }, "duplicates_skipped": <count> }`

## Phase 1: Read the intake queue

1. Read the intake list: `brain_list_get(collection: "deferred-work", name: "intake", limit: 200, order: "asc")`. Save the `revision`.
2. If the list is empty, log a triage run with `processed: 0` and call `job_complete` with a summary saying nothing to triage.
3. Read the triage state object if it exists: `brain_get_object(collection: "deferred-work", name: "triage-state")`.

## Phase 2: Deduplicate

For each intake item, check whether a substantially similar item already exists in the target backlog:

1. Read the target list (e.g., `brain_list_get(collection: "test-enforcer", name: "backlog")`).
2. An item is a duplicate if an existing backlog entry has essentially the same summary or covers the same files with the same kind of work. Use judgment — exact string matching is too strict, but "same area, same problem" is a duplicate.
3. Mark duplicates for skipping. Do not route them.

Keep deduplication lightweight. Reading each target list once per run is enough — don't re-read after each push.

## Phase 3: Route items

For each non-duplicate intake item:

1. Determine the target collection and list using the routing table above. If `suggestedJob` overrides the default, use it.
2. Transform the item into the target job's backlog format. Each backlog item should be a JSON object with at minimum:
   - `description` — the summary, optionally enriched with details
   - `files` — relevant file paths (if any)
   - `source` — `"deferred-work-triage"` to mark provenance
   - `reportedBy` — original agent ID
   - `reportedAt` — original timestamp
   - `priority` — preserved from the intake item
3. Push the transformed item: `brain_list_push(collection: "<target>", name: "<list>", items: [<item>], maxItems: 30)`.
4. For flake items routed to `test-enforcer/flakes`, format as `{ "description": "<summary + details>", "source": "deferred-work-triage", "reportedBy": "<agentId>", "reportedAt": "<timestamp>" }`.

## Phase 4: Clean up the intake queue

After all items have been routed (or marked as duplicates), remove all processed items from the intake list.

Use `brain_list_remove` with the `where` filter to remove items by their `reportedAt` timestamp, working from the oldest items first. Alternatively, remove by index starting from the highest index to avoid reindexing issues.

## Phase 5: Update state

1. Update triage state: `brain_store_object(collection: "deferred-work", name: "triage-state", value: { last_run_at, items_processed, items_routed }, expectedRevision: <saved revision or omit if first run>)`.
2. Log the run event: `brain_append_event(collection: "deferred-work", kind: "triage-run", subject: "deferred-work-triage", value: { date, processed, routed, duplicates_skipped })`.

## Dispatch behavior

- Rename the session to "Deferred Work Triage".
- Emit `dispatch_event` status updates as work progresses.
- Use `job_log` for task-level progress.
- End with exactly one terminal tool call: `job_complete`, `job_failed`, or `job_needs_input`.

## Terminal report

The report should include:

1. How many items were in the intake queue.
2. How many were routed, broken down by target job.
3. How many were skipped as duplicates.
4. How many ended up in the unrouted list.
5. Any items that could not be processed and why.
