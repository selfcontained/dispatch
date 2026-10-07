# Stream stress

A reproducible load for the web app's stream: many agents talking in one root
stream, child work in launch threads, reviews with findings and long finding
discussions, long turns, and live traffic on top. Use it to measure memory and
latency before and after a change to the feed, the thread panel or the
server's stream events.

It runs against an isolated `repo_dev_up` stack, never a shared one.

## Safety: no real engine

Every agent on the stack must run `stress-acp-agent.mjs`, which never calls
a model. `drive.mjs` refuses to start unless both checks pass:

1. **Before any launch.** The API process listening on `--api` has
   `DISPATCH_AGENT_HOST_COMMAND=…/stress-host.sh` and
   `DISPATCH_AGENT_RUNTIME=acp` in its environment (read with `lsof` and
   `ps eww`).
2. **After the first launch.** The root agent's first turn (a one-step
   canary) must answer `Done with 1 steps.`, which only the stress engine
   says. If it doesn't, that agent is deleted and nothing else is
   launched. At worst, one short turn ran on a real engine.

`stress-host.sh` sets `DISPATCH_ACP_ADAPTER_COMMAND` inside the host. The
driver verifies that this wrapper was selected before it launches agents.

## Stack

Add this to the worktree's `.env` (read by `bin/dispatch-dev`, git-ignored):

```
DISPATCH_AGENT_HOST_COMMAND=<worktree>/scripts/stream-stress/stress-host.sh
```

Then start or restart the stack with `repo_dev_up` / `repo_dev_restart` and
`live: true`. The host script needs `bun` on the login shell's PATH. Take the
line out again before running the server unit suite from that worktree:
`test/dispatch-dev.test.ts` starts live stacks there and would pick it up.

## Commands

```sh
S=scripts/stream-stress
API=http://127.0.0.1:<api-port>

# Workload: one root stream, printed ids go to measure/wk-probe.
node $S/drive.mjs setup --api $API --scale 3 > /tmp/stress-setup.json

# Web builds to compare, each served against the stack's API.
(cd apps/web && npx vite build --outDir /tmp/stress-web-a)
(cd apps/web && VITE_API_TARGET=$API npx vite preview --outDir /tmp/stress-web-a --port 61010 --strictPort) &

# Chromium: load/older scaling, interactions idle and during 90 s of live traffic.
node $S/measure.mjs --web http://127.0.0.1:61010 --api $API \
  --setup /tmp/stress-setup.json --label a --older 6 --live 90 > /tmp/stress-a.jsonl

# System WebKit (Safari's engine): footprint by category across load, older, scroll, leave.
swiftc -O $S/wkhost.swift -o /tmp/wkhost
node $S/wk-probe.mjs --web http://127.0.0.1:61010 --setup /tmp/stress-setup.json --label a --older 6
```

`measure.mjs --live N` runs `drive.mjs live` itself. Run it by hand with
`--root <id> --finding <id> --seconds N` for traffic while you use the app.

## Shapes and resources

The workload is modelled on the dogfood review-flow session: 53 top-level
rows, 24 turns, 555 steps, two reviews with 3–4 findings, 3.5 MB first page.

| scale | rows / pages | feed JSON | setup time | DB growth     |
| ----- | ------------ | --------- | ---------- | ------------- |
| 1     | 206 / 3      | 7.8 MB    | ~1 min     | ~600 blocks   |
| 3     | ~570 / 6     | ~22 MB    | ~3 min     | ~1,300 blocks |

Both scales include two 305-step turns (~1.3 MB rows), 3 builders with
thread turns, 2 reviewers with 12 findings each, and a 150 × scale-reply
finding discussion.

Resource expectations:

- A live window sends ~5–40 SSE events/s to the tab. The API server sits at
  ~25% of one core, and the six stress agents are node processes of
  ~60 MB each.
- `measure.mjs` takes ~4 min with `--live 90`. `wk-probe.mjs` takes ~1 min
  and opens a visible window.
- Stop the stack with `repo_dev_down` when done; it removes the agents' hosts
  and the database.

Runs share one database, so each live window leaves a few more rows. Compare
runs taken back to back, and rerun the baseline when in doubt.

## What the numbers mean

- `measure.mjs` output (one JSON line per sample):
  - `load` / `older-N`: post-GC heap, DOM nodes, rows mounted.
  - `interact-*`: keystroke Event Timing p95, scroll frame p95, expanding
    steps, opening the long finding thread, switching agents.
  - `live+Ns`: main-thread busy % (CDP `TaskDuration`), long tasks, SSE
    events and KB/s, mark-read requests.
- `wk-probe.mjs` output: `graphicsMB` is compositing memory, the part Safari
  grew by, which Chromium and Playwright's WebKit do not show.
  `mallocMB` is WebKit's heap and `jsMB` is the JS heap.
- Known artefact: re-opening a thread through history (`pushState`) in a
  headless page can stall for a few seconds while the drawer's close
  fallback runs. A first open is not affected.
