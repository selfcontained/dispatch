---
name: repo-tools
description: Expose a repo's own scripts to agents as first-class tools, and run cleanup on agent stop, via .dispatch/tools.json. Use when you keep re-running the same shell command across sessions.
---

# Repo-specific tools and hooks (`.dispatch/tools.json`)

Every repo can publish its own MCP tools to the agents working in it. Drop a
`.dispatch/tools.json` at the repo root and each entry becomes a real tool in the
agent's tool list — discoverable without anyone documenting it in a prompt.

The symptom that means you want this: agents keep rediscovering the same shell
incantation, or a README paragraph keeps getting ignored because nothing surfaces
it at the moment of use.

## File shape

```json
{
  "hooks": {
    "stop": {
      "command": ["./bin/dev", "down"],
      "description": "Tear down the agent's isolated dev environment on stop."
    }
  },
  "tools": [
    {
      "name": "dev_up",
      "description": "Start the repo's isolated dev environment on free ports.",
      "command": ["./bin/dev", "up"],
      "scope": ["agent"],
      "params": [
        {
          "name": "live",
          "type": "boolean",
          "flag": "--live",
          "description": "Enable the live agent runtime instead of inert mode."
        },
        {
          "name": "cwd",
          "type": "string",
          "flag": "--cwd",
          "description": "Working directory override (e.g. a worktree path)."
        }
      ]
    }
  ]
}
```

## Tool entries

| Field         | Required | Notes                                                                       |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `name`        | yes      | Exposed as `repo_<name>`. Dots are stripped — MCP names cannot contain them |
| `description` | yes      | This is what makes the tool get used. See below                             |
| `command`     | yes      | Argv array, run from the repo root                                          |
| `params`      | no       | Turned into CLI flags appended to `command`                                 |
| `scope`       | no       | Any of `agent`, `reviewer`, `job`. Omit to expose everywhere                |

`repo_` prefixing is automatic, and a name that would collide with a built-in
Dispatch tool (`create_pr`, `get_pr_status`, `dispatch_event`, `dispatch_share`)
is rejected at load.

**Write the description for an agent that has never seen this repo.** It is the
only thing standing between the tool existing and the tool being used. Say what
the command does and when to reach for it — not just what it is named.

## Params

Each param becomes a flag appended to `command`:

- `type: "string"` → appends `<flag> <value>` when a non-empty value is passed.
- `type: "boolean"` → appends `<flag>` only when the value is `true`.
- Omitted or null values append nothing.

`name`, `type`, and `flag` are all required; a param missing any of them fails to
load. Give every param a `description` too — the agent picks values from it.

## Execution model

Commands run from the repo root with `DISPATCH_AGENT_ID` set in the environment.
**Every exit code is returned to the agent** rather than throwing — stdout,
stderr, and the exit code all come back, so the agent can read a failure instead
of just seeing an error. Write scripts that fail loudly on stderr.

## Hooks

`hooks.stop.command` runs when the agent stops. Use it for teardown that would
otherwise leak: stopping a dev stack, removing a container, releasing a port.
Keep it fast and idempotent — it may run when the thing it cleans up was never
started.

## Working on it

The manifest is re-read when its mtime changes, so edits take effect without a
restart — but the agent's tool list is built at session start, so a **newly
added** tool only appears to a session launched after the edit. A malformed entry
(missing `name`, `description`, or `command`) throws at load, which surfaces as
the repo's tools being absent rather than as a parse error. If `repo_*` tools
vanish, validate the JSON first.
