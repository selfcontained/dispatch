# Service Resources Dashboard

## Goal

Add a **Resources** page under Dispatch Settings that answers three operator
questions quickly:

1. Is Dispatch healthy right now?
2. What is consuming host resources?
3. Which Dispatch loop or dependency is slow, failing, or falling behind?

The page is an operational view of the Dispatch installation, not another
agent-usage analytics page. Existing Activity metrics remain the place for
tokens, working time, and agent productivity.

## Current architecture findings

Dispatch is primarily one Bun/Fastify server process. That process coordinates
several kinds of work:

- a PostgreSQL connection pool with a maximum of 10 connections;
- tmux-backed agent sessions and their CLI process trees;
- a 30-second agent reconciliation pass;
- pane activity checks that run as part of the reconciliation cadence;
- signal-driven Git diff-stat computations, deduplicated in flight and cached
  for 3 seconds;
- per-job cron schedulers and active-run monitors;
- an automatic release check after startup and every six hours;
- SSE clients, terminal WebSockets, and optional browser screencast streams;
- viewer-driven terminal copy-mode polling;
- periodic tmux diagnostic capture and log maintenance.

There is no continuously running Git watcher today. The closest unit is
`DiffStatsRefresher`, which runs Git subprocesses when agent activity or a UI
request signals it. The dashboard should call this **Git diff refreshes** and
show request, duration, cache/deduplication, and failure information.

Postgres and the tmux server are dependencies that may be shared with other
applications or Dispatch instances. Their entire host-process CPU and memory
must not be presented as Dispatch-owned usage. Dispatch can accurately report
its database pool and query health, its own tmux sessions, and resource totals
for process trees rooted at those sessions.

## Proposed information architecture

Add `/settings/resources` with a `Gauge`-style icon after Notifications and
before Updates. Use the existing Settings shell and shadcn cards, badges,
tooltips, and chart primitives.

```text
┌ Overall health ───── Uptime ───── Last sample ─────────────────────┐
│ Dispatch CPU │ Dispatch RSS │ Agent CPU/RSS │ DB │ Event-loop lag │
├ Recent history ────────────────────────────────────────────────────┤
│ CPU: Dispatch / Agents / host load │ Memory: RSS / heap / Agents  │
├ Runtime health ────────────────────────────────────────────────────┤
│ API              Healthy    18 req/min    p95 24 ms          ▸    │
│ Database         Healthy    2/10 pooled   3 ms               ▸    │
│ Reconciliation   Healthy    12 s ago      180 ms             ▸    │
│ Git diff refresh Degraded   2 failures    p95 1.4 s          ▸    │
├ Capacity and storage ──────────────────────────────────────────────┤
│ Agents 8 running │ SSE 3 │ Streams 1 │ DB 84 MB │ Media 1.2 GB  │
└────────────────────────────────────────────────────────────────────┘
```

### 1. Overview

The first viewport should contain:

- overall state: Healthy, Needs attention, or Unavailable;
- last sample time and process uptime;
- Dispatch CPU;
- Dispatch resident memory (RSS);
- agent process CPU and RSS aggregate;
- database round-trip latency and pool use;
- event-loop delay;
- active workload summary: running agents, SSE clients, terminal sockets,
  stream sessions, and scheduled jobs.

CPU must be labeled as **one-core percentage** so an expensive process can
legitimately exceed 100% on a multicore host. Also show host load separately;
do not blend the two measurements.

Memory should distinguish:

- Dispatch server RSS and JavaScript heap;
- Dispatch agent process-tree RSS;
- host total/free memory as context.

Host free memory is informational, not a health verdict. Operating systems use
otherwise-free memory for caches, so a simple `used / total` threshold would
create false alarms.

### 2. Recent resource history

Show two compact charts using the in-memory samples collected since the server
started:

- CPU: Dispatch server, agent process trees, and host load;
- memory: Dispatch RSS, agent process-tree RSS, and JavaScript heap.

The MVP should keep a one-hour ring buffer sampled every five seconds (720
samples). It should say **History since last service start** and show the
actual available duration. Do not write five-second samples to Postgres: that
would make observability increase database churn and grow permanent storage.

A later release can add opt-in, downsampled persistence if operators need
cross-restart trends.

### 3. Runtime health

Use a dense, scannable table rather than a grid of equally prominent cards.
Each row represents a real runtime unit and reports only fields that make sense
for that unit.

| Runtime unit            | Useful live fields                                                | Health signal                                          |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| API server              | requests/min, in flight, error rate, p50/p95 duration             | recent 5xx burst or sustained latency/event-loop delay |
| Database                | probe latency, pool total/idle/waiting                            | failed probe, waiting clients, sustained slow probe    |
| Agent reconciliation    | cadence, last success, last duration, agents scanned, corrections | failed or stale beyond twice its cadence               |
| Activity monitor        | last success, duration, panes scanned, corrections                | failure or stale beyond twice its cadence              |
| Git diff refreshes      | requests, in flight, completed, failures, p95 duration, last run  | repeated failures, timeout, or growing in-flight work  |
| Job schedulers          | enabled schedules, active monitors, next run                      | scheduler error or missed run                          |
| Update checker          | mode, last result, last duration, next run                        | last attempt failed; `off` is Disabled, not unhealthy  |
| UI event stream         | connected clients, events sent, write failures                    | repeated write failures                                |
| Terminal observers      | viewers, active observers, fast/slow poll counts                  | repeated tmux probe failures                           |
| Browser streams         | live streams, viewers, frames/second, bytes/second                | CDP disconnect/error                                   |
| Diagnostics maintenance | last capture/prune, last duration, failure                        | stale or failed beyond expected cadence                |

Rows should use the states `healthy`, `degraded`, `unavailable`, `running`,
`idle`, `disabled`, and `unknown`. Before a scheduled unit has run, show
Unknown or Scheduled rather than green. A unit intentionally disabled should
never lower overall health.

Expanding a row can reveal its last error, recent duration, expected cadence,
and a plain-language description. Error strings must be sanitized; do not
expose environment variables, command arguments, auth tokens, or full private
paths.

### 4. Capacity and storage

Show operational totals that help explain pressure:

- agents by lifecycle state and number of agent process trees found;
- Postgres pool use (`total`, `idle`, `waiting`, configured max);
- active SSE clients, terminal WebSockets/viewers, copy-mode observers, and
  browser streams/viewers;
- scheduled jobs and in-flight job monitors;
- current database size via `pg_database_size(current_database())`;
- media, logs, diagnostics, and release-cache directory size.

Directory sizes must be sampled asynchronously on a slow cadence (at least 60
seconds), cached, bounded to the known Dispatch-owned roots, and tolerant of
missing or unreadable files. They must never be recursively scanned during an
HTTP request.

Label every figure by scope:

- **Dispatch**: server process and Dispatch-owned files;
- **Agents**: process trees rooted at Dispatch tmux panes;
- **Dependency**: database health/pool and tmux service state;
- **Host**: whole-machine context.

This prevents users from reading shared Postgres or tmux resource totals as
resources caused solely by Dispatch.

### 5. Diagnostics actions (post-MVP)

Useful follow-on actions are:

- copy a sanitized JSON snapshot;
- download a bounded diagnostics bundle containing the current snapshot,
  recent subsystem results, and recent server log tail;
- open the existing update or help pages when a known issue has a documented
  remedy.

The first version should remain read-only. Restarting the service, killing an
agent, clearing caches, or pruning files are materially different operations
and should not be hidden inside a resource dashboard.

## Metric definitions and collection

### Cheap five-second sample

Collect on a single unref'ed server timer and keep the result in memory:

- `process.memoryUsage()` for RSS, heap used/total, external, and array
  buffers;
- `process.cpuUsage(previous)` divided by elapsed wall time for one-core CPU;
- `process.uptime()`;
- `os.loadavg()`, `os.totalmem()`, and `os.freemem()`;
- event-loop delay from `node:perf_hooks`' `monitorEventLoopDelay`, after
  confirming Bun runtime compatibility;
- cached counters and gauges owned by server components.

Use separate slower cadences for collection that crosses a process or storage
boundary:

- database probe and database pool snapshot every 10 seconds;
- one OS process snapshot every 10 seconds for known Dispatch tmux pane roots
  and descendants;
- storage and database-size sampling every 60 seconds.

Process sampling should use one `ps` invocation per sample, parse the full
parent map once, and aggregate only known roots. Never run `ps` once per agent.
If the platform does not provide the required fields, return an explicit
`unsupported` capability and keep the rest of the page working.

### Request metrics

Use Fastify hooks to record request start/end into rolling, bounded buckets:

- request count and in-flight gauge;
- status-class counts;
- total duration distribution;
- optionally normalized route-level duration for the slowest few routes.

Do not retain raw URLs because IDs create unbounded cardinality and query
strings can contain sensitive data. Use Fastify's normalized route template,
exclude or separately tag the resources endpoint, and keep only aggregate
histogram buckets rather than every request.

### Subsystem metrics

Create a small shared tracker with explicit lifecycle methods:

```ts
type SubsystemRunTracker = {
  start(metadata?: Record<string, number>): RunHandle;
  snapshot(now?: number): SubsystemSnapshot;
};

type RunHandle = {
  succeed(metadata?: Record<string, number>): void;
  fail(error: unknown): void;
};
```

Each snapshot should include:

- expected cadence or `null` for signal-driven work;
- last started/completed/succeeded/failed timestamps;
- current in-flight count and peak;
- bounded success/failure counters;
- last and rolling p50/p95 duration;
- sanitized last error summary;
- unit-specific numeric metadata such as agents scanned or corrections made.

Explicit instrumentation at the actual call sites is preferable to inferring
loop health from logs. The tracker must not swallow errors or change existing
control flow.

### Health evaluation

Evaluate health on the server so web and future CLI clients share semantics.
Start with conservative rules:

- Unavailable: the DB probe fails or the sampler itself cannot produce a
  current snapshot;
- Degraded: a recurring subsystem's last successful completion is older than
  twice its expected cadence, a recent run failed with no later success, DB
  pool waiters persist, or event-loop/API latency remains high across multiple
  samples;
- Healthy: required probes pass and no required subsystem is degraded;
- Unknown: insufficient data;
- Disabled: intentionally not scheduled.

Use sustained windows rather than one-sample CPU or latency spikes. Initial
thresholds should be constants with tests and returned in the API metadata so
the UI can explain why a state is degraded.

## API proposal

Add an authenticated, read-only endpoint:

```text
GET /api/v1/system/resources?window=1h
```

The endpoint returns the cached current snapshot plus a downsampled series. It
does not perform subprocess, directory, or database-size collection inline.

Suggested top-level contract:

```ts
type ServiceResourcesResponse = {
  generatedAt: string;
  processStartedAt: string;
  availableHistoryMs: number;
  sampleIntervalMs: number;
  overall: { state: HealthState; reasons: HealthReason[] };
  capabilities: {
    processTreeMetrics: "available" | "unsupported" | "error";
    eventLoopMetrics: "available" | "unsupported";
    storageMetrics: "available" | "partial" | "error";
  };
  current: {
    host: HostMetrics;
    server: ProcessMetrics;
    agents: AgentProcessMetrics;
    database: DatabaseMetrics;
    http: HttpMetrics;
    workloads: WorkloadMetrics;
    storage: StorageMetrics;
  };
  subsystems: SubsystemSnapshot[];
  series: ResourceSample[];
};
```

Return stable reason codes plus display text, for example
`DB_PROBE_FAILED`, `RECONCILER_STALE`, and `EVENT_LOOP_DELAY_HIGH`. This lets
the web UI test behavior without parsing prose.

The existing `/api/v1/health` should remain a minimal readiness check used by
launchd/update flows. Do not make it depend on the heavier sampler or expand it
into the dashboard payload.

## Backend design

Introduce an observability module with a narrow ownership boundary:

```text
apps/server/src/observability/
  service-resources.ts       orchestration, ring buffer, public snapshot
  runtime-sampler.ts         process, host, event-loop sampling
  process-tree-sampler.ts    one bounded OS process snapshot
  subsystem-tracker.ts       run/counter instrumentation
  health-evaluator.ts        stable state and reason rules
  storage-sampler.ts         slow cached Dispatch-owned disk scan
```

Add `apps/server/src/routes/resources.ts` rather than continuing to grow the
already broad system settings route. Construct one `ServiceResources` runtime
in `server.ts`, pass trackers or lightweight counter callbacks into the
components that own the work, and stop its timers in `cleanupAppResources()`.

Components need read-only snapshot methods for current gauges where a counter
callback would be awkward:

- `UiEventBroker`: connected client count and publish/write counters;
- `StreamManager`: stream/viewer/frame/byte counts;
- `CopyModeObserverManager`: observer/viewer/poll counts;
- `JobService`: scheduler and active monitor counts;
- `DiffStatsRefresher`: cache/in-flight counts plus run tracker integration.

Avoid a global mutable metrics bag. Each feature remains the owner of its
gauges and receives only the tracker it needs; `ServiceResources` composes
snapshots at sample time.

## Frontend design

Add:

```text
apps/web/src/hooks/use-service-resources.ts
apps/web/src/components/app/service-resources-settings.tsx
apps/web/src/components/app/service-resources-dashboard.tsx
apps/web/src/components/app/service-resources-chart.tsx
apps/web/src/components/app/service-resources-chart-config.ts
apps/web/src/components/app/service-resources-subsystems.tsx
apps/web/src/components/app/service-resources-format.ts
```

The React Query hook should:

- poll every five seconds only while `/settings/resources` is mounted and the
  document is visible;
- retain the previous successful payload during a transient refresh failure;
- expose staleness separately from service-reported health;
- stop polling when the page unmounts.

Use responsive layout:

- desktop: six summary cards, two side-by-side charts, full subsystem table;
- narrow screens: two-column cards, stacked charts, subsystem rows that reveal
  detail on tap;
- mobile: single-column cards and list-style subsystem details without a wide
  horizontal table.

The existing API/DB dots in the Settings sidebar can remain. Once the resource
endpoint exists, clicking or focusing those statuses could link to Resources,
but the dashboard must not lift feature state into `App.tsx`; the page owns its
query and presentation.

## Implementation phases

### Phase 1: observable foundation and live overview

1. Add ring-buffer, CPU/memory/host sampler, event-loop sampler, health
   evaluator, and lifecycle cleanup.
2. Add DB probe/pool and workload gauges that are already cheap and available.
3. Add the authenticated resources route and contract tests.
4. Add the Settings route/nav item, overview cards, capability labels, loading,
   stale, empty, and unavailable states.
5. Add one-hour CPU/memory charts and responsive Playwright coverage.

This phase delivers a useful dashboard without modifying every subsystem.

### Phase 2: real subsystem health

1. Instrument reconciliation and activity monitoring separately.
2. Instrument Git diff refresh requests, dedupes, durations, and failures.
3. Instrument job schedulers/monitors and automatic update checks.
4. Expose UI event, terminal observer, and browser stream gauges/counters.
5. Add the runtime-health table and stable health-reason tests.

### Phase 3: resource attribution and storage

1. Implement cross-platform, single-pass process-tree sampling for Dispatch
   agent tmux pane roots.
2. Add slow cached storage sampling and database size.
3. Add capacity/storage UI and partial/unsupported states.
4. Validate overhead under idle, many-agent, and active-stream scenarios.

### Phase 4: operator diagnostics

1. Add sanitized JSON snapshot copy/download.
2. Add a bounded diagnostics bundle if operator demand justifies it.
3. Consider opt-in downsampled persistence only after validating a real need
   for history across restarts.

## Validation strategy

### Backend

- unit-test ring-buffer eviction and downsampling;
- unit-test CPU delta math and unavailable platform fields;
- unit-test health transitions, especially Unknown/Disabled and stale cadence;
- unit-test error sanitization and bounded cardinality;
- route-test auth, payload shape, query validation, and partial capabilities;
- use fake clocks for all cadence and staleness tests;
- verify sampler and tracker failures never break the service loop they
  observe.

### Frontend

- component-test loading, healthy, degraded, partial, stale, and unavailable
  payloads;
- verify units and scopes are explicit (`Dispatch`, `Agents`, `Dependency`,
  `Host`);
- verify polling pauses when hidden and stops on unmount;
- Playwright: open Settings, select Resources, observe a successful refresh,
  expand a subsystem, and validate the mobile layout;
- capture and share a screenshot of the changed UI flow.

### Performance acceptance

Before shipping, compare an idle service with and without metrics enabled:

- sampler CPU should remain negligible at the five-second cadence;
- history must remain bounded regardless of uptime;
- only one OS process listing may run per sample;
- no filesystem recursion or database-size query may run per HTTP request;
- opening multiple dashboard tabs must not multiply backend sampling work;
- the resources endpoint p95 should be dominated by JSON serialization of the
  cached snapshot, not collection work.

## Recommended MVP cut

Ship Phases 1 and 2 plus the process-tree portion of Phase 3 as the first
user-visible release. They provide immediate answers about server CPU/memory,
API/DB health, current workload, the loops most likely to explain degraded
behavior, and whether resource pressure belongs to the control plane or its
agents. Keep disk scanning and database-size reporting for the next increment;
they are useful capacity signals but less important for live diagnosis.

The MVP is successful when an operator can distinguish these cases without
opening a terminal:

- Dispatch itself is consuming CPU or memory;
- running agent processes are consuming the resources instead;
- Postgres is reachable but its pool is saturated;
- the event loop/API is slow;
- reconciliation, activity monitoring, or Git diff refreshes are failing or
  stale;
- everything is healthy and the observed host pressure is outside Dispatch.
