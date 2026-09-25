# Dispatch

Dispatch is a local-first control plane for running and managing multiple AI coding agents, with one stream per agent and file sharing in the browser. It runs on macOS and Linux.

## Quick Install

Install and start PostgreSQL 14+ first, then run this on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/selfcontained/dispatch/main/bin/install-dispatch.sh | bash
```

The installer selects the latest stable release, creates a private local
database and credentials when it can administer PostgreSQL, installs the
platform-matched binary at `~/.dispatch/server/dispatch`, and registers a
user service. For a managed database, pass its URL instead:

```bash
curl -fsSL https://raw.githubusercontent.com/selfcontained/dispatch/main/bin/install-dispatch.sh | bash -s -- --database-url 'postgres://…'
```

The service listens on `127.0.0.1:6767`. Verify with
`curl http://127.0.0.1:6767/api/v1/health`. Normal UI updates atomically
replace the fixed executable and restart the service.

<img width="1440" height="900" alt="image" src="https://github.com/user-attachments/assets/efb154d9-7d4c-411a-861b-d460cb0816d6" />

## Features

- Start, monitor, and stop multiple long-running agents (Claude Code or Codex) remotely.
- Each agent runs in its own host process that outlives the Dispatch server, so restarts and browser disconnects do not kill work.
- Git worktree isolation for parallel agent work on separate branches.
- MCP-based tooling with repo-specific custom tools (`.dispatch/tools.json`).
- Jobs — scheduled, repo-scoped agent tasks with structured reporting and interactive recovery.
- Personas — launch profiles for reviewers and other roles (`.dispatch/personas/`); a reviewer posts one structured review block back to the agent that launched it. A built-in General Code Review persona means review works with no repo setup.
- Personalities — short system-prompt blocks appended to every agent for voice or standing preferences.
- Keyboard shortcuts and a command palette (`Mod+K`) for fast navigation and actions.
- Browser Feedback — a Chrome extension to select an element on any web page, comment, and send it with bounded DOM context and a cropped element screenshot to a running agent (paired under Settings → Connections).
- Slack notifications with focus-aware suppression.
- Activity analytics — heatmaps, daily status charts, working time by project.
- Service resources dashboard — live CPU, memory, subsystem health, and workload metrics for the Dispatch server, agents, and host (Settings → Resources, opt-in collection).
- Token usage tracking by day, project, and model.
- Agent history with soft-delete preservation, filtering, and per-agent detail views.
- Release management — cut releases, deploy tags, and self-update from the UI.
- Theming with multiple color themes.
- Password-based login with first-run setup and per-device session cookies.
- Browser UI with:
  - quick phrases — reusable text snippets with template variables, sent to an agent as a prompt
  - durable agents: each runs under its own host process that outlives the server, so a restart never cuts a turn
  - agent lifecycle controls (create, start, stop, delete — with background archive cleanup)
  - files pane for screenshots, video, text snippets, and live Playwright browser streaming (MJPEG over CDP)
  - one stream per agent: replies, questions and forms you answer in one click, files, links, checklists and reviews, with threads
  - live agent status (working, waiting, idle, blocked) derived by the server, over SSE
  - in-app browser notifications (with Slack fallback if no browser client acks)
  - in-app docs pane covering features and MCP tools

## Prerequisites

| Dependency                 | Purpose                  | macOS                        | Linux                    |
| -------------------------- | ------------------------ | ---------------------------- | ------------------------ |
| **PostgreSQL 14+**         | Database                 | `brew install postgresql@17` | `apt install postgresql` |
| **At least one agent CLI** | The agents Dispatch runs | See below                    | See below                |

Production installs run the released, compiled Bun binary from `dist/bun/`; the host does not need Node just to run Dispatch.

### Optional

| Dependency       | Purpose                                   | Install                                                                                                 |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **GitHub CLI**   | Help agents work with GitHub and open PRs | `brew install gh` / `apt install gh`                                                                    |
| **Docker**       | Isolated dev databases via `dispatch-dev` | macOS: `brew install --cask docker` / Linux: [docs.docker.com](https://docs.docker.com/engine/install/) |
| **xclip + Xvfb** | Clipboard image paste (Linux only)        | `apt install xclip xvfb`                                                                                |

### Agent CLIs

Dispatch spawns agents via their CLI tools. Install at least one:

| Agent      | Install                                    | Authenticate                               |
| ---------- | ------------------------------------------ | ------------------------------------------ |
| **Claude** | `npm install -g @anthropic-ai/claude-code` | `claude` (follow login prompts)            |
| **Codex**  | `npm install -g codex`                     | Set `OPENAI_API_KEY` in your shell profile |

Dispatch drives each CLI through its Agent Client Protocol adapter: `npm i -g @agentclientprotocol/claude-agent-acp` for Claude, `npm i -g @agentclientprotocol/codex-acp` for Codex. The CLI must be authenticated before Dispatch can spawn agents of that type; the agent host starts through your login shell, so login state and API keys in your profile are inherited automatically.

## Setup

```bash
# 1. Clone and enter the repo
git clone git@github.com:selfcontained/dispatch.git
cd dispatch

# 2. Install dependencies
pnpm install

# 3. Copy the example env file
cp .env.example .env

# 4. Start Dispatch
bin/dispatch-dev up --live
```

For day-to-day backend work, the server itself runs under Bun. `pnpm` is still used at the repo root for dependency installation and workspace-level scripts.

> **Important:** Docker Desktop must be running (not just installed). If you see
> _"Error: docker compose is not available"_, open Docker.app first.

`dispatch-dev` automatically:

- Spins up an isolated Postgres container on a free port
- Runs database migrations on server start
- Starts the API server on a free port
- Starts the Vite frontend dev server
- Enables live agent spawning (with `--live`)
- Prints the URLs when ready

Open the Vite URL printed in the output to access the UI.

### Managing the Dev Environment

```bash
bin/dispatch-dev status             # check what's running
bin/dispatch-dev logs               # API server logs
bin/dispatch-dev logs --vite        # Vite server logs
bin/dispatch-dev url                # print the API server URL
bin/dispatch-dev down               # tear everything down
bin/dispatch-dev restart             # restart the environment
```

### Verify

```bash
# Health check
curl -s $(bin/dispatch-dev url)/api/v1/health | jq

# Create a test agent
curl -s -X POST $(bin/dispatch-dev url)/api/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{"cwd": "/tmp", "type": "claude"}' | jq
```

## MCP Tools

Every agent launched by Dispatch gets access to MCP tools via an agent-scoped endpoint. Interactive agents (persona agents included) and job runners each expose a slightly different set, all configured automatically with no setup.

`get_usage` is available to both interactive agents and job runners. Call it with
`{}` to compare provider usage, or `{ "type": "claude", "force": true }` to
request a refresh for a comparison focused on Claude. It returns model IDs from
Dispatch's current launch catalog, remaining percentages for each reported quota
window, reset times, and remaining spend when available. Quotas are shared by
agents using the same provider login; model-specific limits retain the provider's
window labels. Check `observedAt` and `unavailableReason` before using a report to
choose `launch_agent`'s `type` and `model`. Missing limits mean unknown capacity.

### Interactive agents

| Tool                       | Description                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `post`                     | Post a block into the stream: text, a question, a form, a link, a checklist, a review, a file       |
| `update`                   | Revise a posted block, or change the state of one addressed to you (resolve a finding, tick a task) |
| `react`                    | Put an emoji reaction on a block                                                                    |
| `rename_session`           | Update the current session's display name                                                           |
| `login_link`               | Mint a short-lived browser login link for the Dispatch UI                                           |
| `list_files`               | List files shared with or by this agent, or by its parent or a direct child                         |
| `delete_file`              | Permanently remove a shared file                                                                    |
| `list_personas`            | List available personas for this project                                                            |
| `persona_templates`        | Get built-in starter templates for authoring personas                                               |
| `persona_upsert`           | Create or update a persona file in `.dispatch/personas/`                                            |
| `persona_validate`         | Validate persona files for required metadata and instructions                                       |
| `launch_agent`             | Launch a new agent to work on a subtask, as a child or standalone; `persona` launches a reviewer    |
| `archive_agent`            | Archive an agent this session launched, or itself, with worktree cleanup                            |
| `list_agents`              | List other agents in the same repo with IDs, statuses, activity, lineage                            |
| `get_activity_summary`     | Summarize agent activity over a time range                                                          |
| `get_feedback_summary`     | Aggregate review findings for pattern detection                                                     |
| `brain_get_object`         | Read a shared object from the repo-scoped Brain                                                     |
| `brain_store_object`       | Create or update a shared Brain object (optimistic concurrency)                                     |
| `brain_list_objects`       | List Brain objects, optionally filtered by collection or prefix                                     |
| `brain_delete_object`      | Delete a shared Brain object                                                                        |
| `brain_list_push`          | Append one or more items to a shared Brain list                                                     |
| `brain_list_remove`        | Remove one item from a shared Brain list by index or field match                                    |
| `brain_list_get`           | Read items from a shared Brain list with paging and ordering                                        |
| `brain_get_list_item`      | Read one Brain list item by index, with its value untruncated                                       |
| `brain_list_set`           | Replace one item in a shared Brain list by index                                                    |
| `brain_list_delete`        | Delete a shared Brain list and all of its items                                                     |
| `brain_append_event`       | Append a structured event to the Brain's append-only event log                                      |
| `brain_query_events`       | Query Brain events by collection, kind, subject, tags, and time range                               |
| `brain_get_event`          | Read one Brain event by id, with its value untruncated                                              |
| `brain_delete_events`      | Delete Brain events by id, or prune a collection (`dryRun` previews count)                          |
| `list_jobs`                | List jobs scoped to a directory                                                                     |
| `get_job`                  | Get a single job by ID or name                                                                      |
| `create_job`               | Create a new job                                                                                    |
| `update_job`               | Update an existing job's configuration                                                              |
| `delete_job`               | Delete a job                                                                                        |
| `run_job`                  | Trigger an immediate run of a job                                                                   |
| `list_templates`           | List templates scoped to a directory                                                                |
| `get_template`             | Get a single template by ID or name                                                                 |
| `create_template`          | Create a new reusable agent launch template                                                         |
| `update_template`          | Update an existing template                                                                         |
| `delete_template`          | Delete a template                                                                                   |
| `list_personalities`       | List saved personalities and the active personality ID                                              |
| `create_personality`       | Create a saved personality                                                                          |
| `update_personality`       | Update a saved personality's name or prompt                                                         |
| `delete_personality`       | Delete a saved personality (clears it if it was active)                                             |
| `set_active_personality`   | Set the active personality for subsequently launched agents                                         |
| `clear_active_personality` | Clear the active personality                                                                        |

Pull requests are opened with the `gh` CLI and posted to the stream as a `pr` attachment; there is no PR tool.

### Persona agents

A persona is a launch profile, not a different tool set: `launch_agent` with `persona: <slug>` gives the new agent the persona's instructions and your prompt as its briefing, and it gets the same tools as any interactive agent. A reviewer persona posts one `review` block (verdict, summary, findings) to the agent that launched it; each finding is a thread, and the launcher marks findings fixed or dismisses them by updating the block's state.

### Job agents

Job agents get lifecycle and reporting tools: `job_complete`, `job_failed`, `job_needs_input`, `job_log`, plus the stream, persona, collaboration, analytics, Brain, job, and template tools listed above (no `login_link` or personality tools).

### Repo-specific tools

Repos can define custom tools in `.dispatch/tools.json` — these are exposed to agents with a `repo_` prefix. The same file also defines lifecycle hooks (for example `stop` to tear down per-agent dev environments).

These tools only work inside running agent sessions (they require agent-scoped MCP context which Dispatch provides automatically).

## Dispatch plugin (Claude Code + Codex)

This repo doubles as a plugin marketplace. The **Dispatch plugin** ships eleven skills that teach agents how to use the capabilities above — the Brain, subagents, `.dispatch/tools.json`, reaching the user, artifact sharing, the review workflow, UI validation, personas, jobs, templates, and personalities — so agents discover them instead of having to be told.

**Before you install:** plugins on Claude Code and Codex are **unsigned and unsandboxed, and run with your full local user privileges** — this one and every other self-hosted plugin. This plugin ships no executable components (no hooks, no `bin/`, no bundled MCP servers), only markdown skills; [plugins/dispatch/README.md](plugins/dispatch/README.md#trust) shows how to verify that for yourself before running the commands below.

```bash
# Claude Code
claude plugin marketplace add selfcontained/dispatch
claude plugin install dispatch@dispatch

# Codex
codex plugin marketplace add selfcontained/dispatch
codex plugin add dispatch@dispatch
```

See [plugins/dispatch/README.md](plugins/dispatch/README.md) for what each skill covers and for update mechanics — notably that Codex has no update command, so upgrading means re-running `codex plugin add`.

## Operations

- Update production from the Dispatch UI: **Settings → Updates**
- Cut releases from the Dispatch UI: **Settings → Releases** (release admin only)
- CLI/API path for updates and releases: `bin/dispatch-server update`
- Service management: `bin/dispatch-server start|stop|restart|status|logs|build`
- Production runtime note: the launchd/systemd service runs the compiled Bun binary, so Node/npx is not required on the host just to run Dispatch.

## Docs

User-facing documentation (agents, keyboard shortcuts, personalities, repo tools, templates and jobs, worktrees, reviewers, files, browser feedback, the plugin, notifications, service resources, updates) lives in the app itself — open the **Docs** pane from the sidebar. The files below are developer-facing references that aren't duplicated in the UI:

- [API Specification](docs/03-api-spec.md) — complete API endpoint reference
- [Agent Lifecycle Model](docs/04-agent-lifecycle.md) — states, transitions, host contract
- [Operations Runbook](docs/10-operations-runbook.md) — service management, releases, diagnostics
- [Theming](docs/14-theming.md) — how to add and customize color themes
- [Jobs](docs/17-jobs.md) — scheduled/on-demand agent tasks with structured reports

## Issue Tracking

- [GitHub Issues](https://github.com/selfcontained/dispatch/issues)
