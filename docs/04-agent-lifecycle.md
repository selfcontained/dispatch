# Agent Lifecycle Model

## States

- `creating`
- `running`
- `stopping`
- `stopped`
- `error`
- `unknown` (transient reconciliation state after restart)

## State Transitions

1. Create
- `creating -> running`
- `creating -> error` on launch failure

2. Stop
- `running -> stopping -> stopped`
- `running -> error` if stop command fails and process remains inconsistent

3. Restart backend reconciliation
- `unknown -> running` if tmux session exists
- `unknown -> stopped` if session absent

## tmux Session Contract

- Session name: `dispatch_agt_<agentId>_<name>`
- Window name: `main`
- Agent process starts in configured `cwd`
- Closing browser terminal must only detach client, not terminate tmux

## Launch Contract

Example launch command:

```bash
tmux new-session -d -s dispatch_<agentId> -c "<cwd>" "codex"
```

Optional with args:

```bash
tmux new-session -d -s dispatch_<agentId> -c "<cwd>" "codex <args>"
```

## Stop Contract

Preferred soft stop:

```bash
tmux send-keys -t dispatch_<agentId> C-c
```

Fallback hard stop:

```bash
tmux kill-session -t dispatch_<agentId>
```

## Reconciliation Routine (on startup)

1. Load agents from DB where status in (`running`, `creating`, `unknown`).
2. Query tmux sessions.
3. For each agent:
- session exists -> set `running`
- session missing -> set `stopped` and clear transient pid/runtime fields
4. Validate simulator reservation consistency.

## Idempotency Rules

- `start` on running agent returns `409` with current state.
- `stop` on stopped agent returns `200` no-op with current state.
- `delete` on running agent blocked unless `force=true`.
