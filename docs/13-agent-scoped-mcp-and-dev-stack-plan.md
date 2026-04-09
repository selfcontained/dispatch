> **Note:** This document is a historical planning artifact. Agent-scoped MCP, repo tools, lifecycle hooks, and `dispatch-dev` have all been implemented — see the current codebase for authoritative behavior. The repo tools and hooks documentation below remains a useful reference for the `.dispatch/tools.json` format.

# Agent-Scoped MCP And Dev Stack Plan

## Goal

Add repo-specific MCP tools in a way that is safe, launch-time configurable, and easy for agents to use. Pair that with a simple dev-stack helper that starts isolated DB, API, and web servers on free ports without reintroducing the lifecycle coupling that caused the old `dispatch-dev` workflow to be removed.

## What Was Implemented In This Worktree

Branch: `agent-scoped-mcp-repo-tools`

Worktree: `.dispatch/worktrees/agent-scoped-mcp-repo-tools`

Completed changes:

- Agent-scoped MCP route: `POST /api/mcp/:agentId`
- Codex launch wiring that injects an ephemeral MCP server URL via `-c mcp_servers.dispatch.url=...`
- Claude launch wiring that injects an MCP config via `--mcp-config`
- MCP server context resolution using `agentId -> agent.cwd -> repo root`
- Repo-specific tool loading from `.dispatch/tools.json`
- Command-backed repo tools with `project.*` namespacing
- Dispatch repo example tools:
  - `project.dev_up`
  - `project.dev_down`
- Tests for:
  - Codex launch command includes agent-scoped MCP URL
  - Claude launch command includes agent-scoped MCP URL
  - repo tool manifest loading and validation

Key files:

- `src/server.ts`
- `src/mcp/server.ts`
- `src/mcp/repo-tools.ts`
- `src/agents/manager.ts`
- `.dispatch/tools.json`
- `test/repo-tools.test.ts`
- `test/db/agent-manager.test.ts`

Validation already completed in this worktree:

- `npm run check`
- `npm test`
- `npm run test:e2e`

## Why Agent-Scoped MCP Was Chosen

The Dispatch MCP server currently runs over HTTP. Tool listing and tool calls are just HTTP requests into Fastify, routed into the MCP handlers.

That means:

- there is no durable per-agent transport connection to infer identity from
- tmux session identity is not visible at the HTTP layer
- the cleanest way to know which agent is calling is to encode the agent in the URL at launch time

Using `/api/mcp/:agentId` solves both discovery and execution:

- `tools/list` gets the correct repo-specific tool set
- `tools/call` executes with the same agent context
- no extra header/proxy/session inference is required

## Repo Tool Design In This Worktree

Current design:

- repo manifest file: `.dispatch/tools.json`
- repo tools must be named under `project.*`
- handlers are declarative command wrappers, not arbitrary in-process plugins
- commands run in the resolved repo root
- commands inherit `DISPATCH_AGENT_ID`

Current example:

```json
{
  "hooks": {
    "stop": {
      "command": ["./bin/dispatch-dev", "down"],
      "description": "Tear down the agent's isolated dev environment on stop."
    }
  },
  "tools": [
    {
      "name": "dev_up",
      "description": "Start the repo's isolated Dispatch development environment.",
      "command": ["./bin/dispatch-dev", "up"]
    },
    {
      "name": "dev_down",
      "description": "Stop the repo's isolated Dispatch development environment.",
      "command": ["./bin/dispatch-dev", "down"]
    }
  ]
}
```

## Lifecycle Hooks

Repos can define lifecycle hooks in `.dispatch/tools.json` under the `hooks` key. Unlike tools (which agents call on demand via MCP), hooks are invoked automatically by Dispatch at specific points in the agent lifecycle.

### Supported hooks

| Hook | When it runs |
|------|-------------|
| `stop` | When an agent is stopped (including when deletion triggers a stop) |

### Hook definition

Each hook has:

- `command` (string[], required): The command to execute. First element is the executable, rest are static args.
- `description` (string, optional): Human-readable description of what the hook does.

### Execution context

- Hooks run in the agent's working directory (`worktreePath` or `cwd`).
- `DISPATCH_AGENT_ID` is set in the environment, so commands like `dispatch-dev down` can resolve the correct agent-scoped resources.
- Hooks are best-effort with a 15-second timeout. A failing hook does not block the lifecycle transition.
- Hook results (including non-zero exit codes) are logged but do not affect agent status.
- Parsed hooks are cached per manifest path and invalidated by file mtime.

### Example: automatic dev stack cleanup

The Dispatch repo itself uses a stop hook to tear down agent dev stacks:

```json
{
  "hooks": {
    "stop": {
      "command": ["./bin/dispatch-dev", "down"],
      "description": "Tear down the agent's isolated dev environment on stop."
    }
  }
}
```

When an agent stops, Dispatch runs `./bin/dispatch-dev down` with `DISPATCH_AGENT_ID` in the environment. `dispatch-dev` uses that to find the matching state file (`/tmp/dispatch-dev-<agentId>.env`) and tears down the DB container, API server, and Vite server.

### Future hooks

The `hooks` object is extensible. Planned hooks include `start`, `resume`, and `delete`.

## What We Learned About `dispatch-dev`

Git history confirms:

- `bin/dispatch-dev` existed
- it auto-selected free ports
- it started isolated Postgres, API, and optional Vite
- it used tmux windows and agent-linked cleanup
- it was added in `672d90c`
- it was removed in `6826908` / PR `#51`

The likely reason it was removed was not the free-port helper itself. The problematic part appears to have been lifecycle coupling:

- tied to `DISPATCH_AGENT_ID`
- depended on tmux session/window ownership
- added cleanup hooks into `AgentManager`
- used hidden state files and implicit cleanup on stop/delete

After removal, docs were only partially updated:

- `AGENTS.md` now describes manual isolated startup
- `CLAUDE.md` still refers to `dispatch-dev`

## Recommended Next Step: Reintroduce A Simpler `dispatch-dev`

Reintroduce `dispatch-dev`, but only as a plain isolated dev-stack helper.

Do not restore:

- tmux window management tied to agent sessions
- automatic cleanup on agent stop/delete
- reliance on `DISPATCH_AGENT_ID`
- implicit lifecycle ownership in `AgentManager`

Do restore:

- automatic free-port selection
- isolated Postgres startup
- API startup with derived `DATABASE_URL`
- optional Vite startup
- status/logs/down helpers
- printed URLs and cleanup instructions

## Proposed `dispatch-dev` Scope

Commands:

- `dispatch-dev up`
- `dispatch-dev up --vite`
- `dispatch-dev down`
- `dispatch-dev restart`
- `dispatch-dev status`
- `dispatch-dev logs`
- `dispatch-dev logs --vite`
- `dispatch-dev url`

Behavior:

- choose free ports automatically
- write state to `/tmp/dispatch-dev-<suffix>.env`
- use explicit process IDs or tmux sessions owned by the script, not by the agent manager
- capture logs in `/tmp/dispatch-dev-<suffix>/`
- use a caller-provided or generated suffix instead of agent ID
- print:
  - DB URL
  - API URL
  - Web URL if Vite is started
  - exact cleanup command

Suggested interface:

```bash
dispatch-dev up --cwd /path/to/worktree
dispatch-dev up --cwd /path/to/worktree --vite
dispatch-dev status
dispatch-dev logs
dispatch-dev down
```

Optional flags:

- `--cwd <path>`
- `--vite`
- `--no-db`
- `--suffix <name>`

## Proposed Implementation Plan For Simplified `dispatch-dev`

### Phase 1: Restore A Standalone Script

Deliverables:

- add `bin/dispatch-dev`
- base it on the historical script's port-finding and startup logic
- remove agent-session resolution and `DISPATCH_AGENT_ID` dependency
- store runtime state in `/tmp`

Exit criteria:

- `dispatch-dev up --cwd <repo>` starts DB + API
- `dispatch-dev up --vite` also starts web
- `dispatch-dev down` tears down only the stack it started

### Phase 2: Align Repo Docs

Deliverables:

- update `AGENTS.md`
- update `CLAUDE.md`
- remove the current contradiction between manual startup and `dispatch-dev`

Exit criteria:

- both docs describe the same supported workflow

### Phase 3: Connect Repo Tools To Real Dev Commands

Deliverables:

- keep `.dispatch/tools.json`
- point `project.dev_up` and `project.dev_down` at the restored script
- optionally add `project.dev_status` and `project.dev_logs`

Exit criteria:

- agent can discover and run repo-specific dev commands via MCP

### Phase 4: Optional Hardening

Deliverables:

- validate port availability and process liveness
- improve cleanup messaging
- ensure logs are easy to inspect
- add tests for:
  - free-port allocation helper
  - state file handling
  - `up/down/status/url`

Exit criteria:

- script is safe for concurrent local use and does not interfere with production `:6767`

## Open Questions

- Should the restored `dispatch-dev` use background PIDs, tmux sessions, or `nohup` plus PID files?
- Should the default suffix be random, timestamp-based, or derived from the current directory?
- Should `project.dev_up` remain zero-argument, or should repo tools later support structured args?
- Should built-in MCP tools eventually stop requiring explicit `cwd` when running on an agent-scoped route?

## Recommendation

Proceed with the current agent-scoped MCP implementation in this worktree, then restore a much simpler `dispatch-dev` that is:

- local
- explicit
- isolated
- not coupled to agent lifecycle

That keeps the MCP work valid and gives the repo-specific `project.dev_up` / `project.dev_down` tools a real command to call.
