# ACP agent runtime

Dispatch runs every agent through the Agent Client Protocol (ACP) instead of
an interactive CLI in a tmux pane. This document is the contract the pieces
are built against. It describes the target for the `acp-runtime` branch; it
is not a description of what `main` does today.

## Goals

- The agent's stream (turns, tool calls, plans, usage, questions) is the
  product. Chat renders it; nothing scrapes a terminal.
- An agent process outlives the Dispatch server. A restart or deploy never
  cuts a running turn.
- The server never touches an agent's filesystem or process directly. It
  talks to an **agent host** over a stream protocol, so a host on another
  machine is a transport change, not a redesign.
- One engine table. Claude first, Codex second. Nothing else until asked for.

## Process model

```
dispatch server
  │  Unix socket (local) · ssh stdio (remote, later)
  ▼
dispatch-agent-host  (one per agent; daemonized, own process group)
  │  ACP over stdio
  ▼
claude-agent-acp  →  claude   (or codex-acp → codex)
```

The host is the same executable as the server, invoked as
`dispatch agent-host --state <dir>`. In development that is
`bun apps/server/src/main.ts agent-host …`; the server derives the command
from its own `process.execPath`/`argv[1]` and `DISPATCH_AGENT_HOST_COMMAND`
overrides it (tests, e2e).

The server spawns the host `detached`, stdio pointed at the host's log file,
and `unref()`s it. That puts the host in its own session and process group,
which is what lets it survive the server: the systemd unit uses
`KillMode=process`, and launchd only reaps the job's own process group. The
host is spawned through the user's login shell (`$SHELL -lc 'exec "$@"'`) so
`gh`, ssh agents and PATH behave as they did under tmux.

The host is the ACP _client_. It spawns the adapter, holds its stdio for its
whole life, and journals every event. It does no queueing and no policy: one
ACP session, one prompt at a time, and it says `busy` if asked for a second.

### State directory

`<agentStateRoot>/<agentId>/`, where `agentStateRoot` is
`DISPATCH_AGENT_STATE_ROOT` or `<dirname(filesRoot)>/agents`
(`~/.dispatch/agents` in production; the dev stack's files root keeps it out
of `~/.dispatch`).

| file                 | owner  | purpose                                                            |
| -------------------- | ------ | ------------------------------------------------------------------ |
| `launch.json` (0600) | server | engine, cwd, adapter binaries, system prompt, MCP url + token, env |
| `host.sock`          | host   | control socket                                                     |
| `host.pid`           | host   | liveness                                                           |
| `journal.jsonl`      | host   | every event, with `seq`, for replay                                |
| `session.json`       | host   | ACP session id, so a restarted host can `session/resume`           |
| `host.log`           | host   | stderr of host and adapter                                         |

`stop` removes the socket and pid; `archive` removes the directory.

## Host protocol

Newline-delimited JSON over the socket. One client at a time; a second
connection replaces the first. The server is the only client.

Client → host:

| message                     | effect                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `{type:"hello", fromSeq}`   | host answers `welcome`, replays journal events with `seq > fromSeq`, then streams live     |
| `{type:"prompt", id, text}` | run one turn; `prompt_accepted {id}` once the adapter has it, `error {id}` if busy or dead |
| `{type:"cancel"}`           | ACP `session/cancel`                                                                       |
| `{type:"shutdown", force}`  | close the ACP session, stop the adapter, exit                                              |
| `{type:"ping"}`             | `pong`                                                                                     |

Host → client:

| message                                                                   | content                                                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `{type:"welcome", agentId, engine, sessionId, running, turn, journalSeq}` | `turn` is the open turn's `{seq, startedAt}` or null                                          |
| `{type:"event", seq, at, event}`                                          | `event` is a `DriverEvent`: `update` (ACP `SessionUpdate`), `turn started/settled`, or `exit` |
| `{type:"prompt_accepted", id}`                                            |                                                                                               |
| `{type:"error", id?, message}`                                            |                                                                                               |

The server records `agents.host_seq` as it folds events into
`agent_stream_events`, and reconnects with `hello {fromSeq: host_seq}`.
Replay makes reconnect idempotent; a dropped socket is the normal path, not
an error path.

### Filesystem operations (remote-ready)

Workspace preparation (worktree, local config copy, dependency install) runs
on the server for a local host today, through one module
(`agents/workspace.ts`) whose signature takes paths and returns results.
Nothing in the manager calls `fs` or `git` on an agent's cwd outside that
module and the git-context/diff-stats readers. When a remote host exists,
those become host RPCs with the same signatures.

## Server runtime

`AgentRuntime` (`agents/runtime.ts`) is the only thing the manager talks to
about a process:

```ts
launch(input: RuntimeLaunch): Promise<void>      // write launch.json, spawn host, hello, first prompt
attach(agentId): Promise<boolean>                // reconnect after a server restart; false if the host is gone
isAlive(agentId): Promise<boolean>
prompt(agentId, text): { accepted: Promise<void>; settled: Promise<void> }  // serialized per agent
isBusy(agentId): boolean
cancel(agentId): Promise<void>
stop(agentId, force): Promise<void>
listHosted(): Promise<string[]>                  // agent ids with a live host, for the reconciler
onEvent(listener): () => void                   // DriverEvent + agentId, seq order, deduplicated
readLogTail(agentId): Promise<string>
```

Two implementations: `AcpRuntime` and `InertRuntime` (e2e without engines).
The manager never branches on runtime kind; it asks.

Prompt delivery has one seam, `enqueueAgentPrompt`, which every caller
(Chat, reviews, cross-agent messages, jobs, persona launches, MCP tools)
already goes through. It becomes `runtime.prompt`. "Held" means the runtime
queue is busy.

## Data model

- `agents.type` is the engine: `claude` or `codex`. No new type, no flag.
- `agents.cli_session_id` holds the ACP session id.
- `agents.host_seq` is the replay watermark.
- `agent_stream_events` (from #1067) is the durable projection of the stream.
  `chat/turns.ts` assembles turns from it into `ChatTurnEntry` feed rows.
- Migrations are additive: `0052_agent-stream-events`, `0053_agents-host-seq`.

## What this removes

tmux runtime, setup script, command builder, terminal websocket and injection
routes, injection coordinator and hold setting, copy-mode observer and assist,
activity monitor, token harvester, Codex session discovery, xterm and the
terminal pane, the Console/Terminal segment. Agent types `cursor`,
`opencode`, `terminal` go with them.

## Guidance

One system prompt builder (`agents/acp/system-prompt.ts`) delivers the
launch guidance plus the active personality through ACP
`_meta.systemPrompt.append` (Claude) or as the first prompt's leading block
(Codex). The agent's text _is_ its reply; `post` is for what plain text
cannot do — a question with options, a form, a file, a link.

## Out of scope for the first milestone

Codex engine wiring, usage and budgets, background processes, model and
config switching, slash menu, path picker, sandboxed permission mode, the MCP
tool revamp, pins/surfaces rethink, schema baseline, remote hosts.
