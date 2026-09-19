# Claude Code Instructions

<!-- Keep behavioral rules in sync with AGENTS.md (used by Codex agents). -->

## Project Structure (pnpm monorepo)

```
dispatch/
├── pnpm-workspace.yaml       # workspace config
├── apps/
│   ├── browser-extension/     # Chrome extension for browser feedback (dev preview)
│   ├── server/                # Fastify API server (@dispatch/server)
│   │   ├── src/               # backend source
│   │   │   ├── agents/        # agent manager, lifecycle; acp/ holds the host, driver and runtime
│   │   │   ├── brain/         # repo-scoped shared memory (objects + event log)
│   │   │   ├── chat/          # the stream: blocks, threads, feed, delivery envelopes
│   │   │   ├── db/            # PostgreSQL migrations and queries
│   │   │   ├── jobs/          # job scheduler, runner, reporting
│   │   │   ├── media/         # media file storage
│   │   │   ├── notifications/ # Slack + job notifiers
│   │   │   ├── observability/ # service resources sampling, subsystem tracker
│   │   │   ├── personas/      # persona launch profiles: loader, authoring, review-diff builder
│   │   │   ├── routes/        # HTTP route handlers
│   │   │   ├── server/        # server runtime helpers (lifecycle, auth, prompts)
│   │   │   ├── shared/        # shared utilities — git/, github/, lib/, mcp/
│   │   │   ├── templates/     # template service and storage
│   │   └── test/              # unit tests (vitest)
│   ├── site/                  # public website (Astro, deployed to Cloudflare)
│   └── web/                   # Vite React frontend (@dispatch/web)
│       └── src/
├── e2e/                       # Playwright E2E tests
├── bin/                       # dispatch-dev, dispatch-server, install-dispatch, etc.
├── scripts/                   # e2e-isolated.sh, generate-icon-colors.ts
├── plugins/
│   └── dispatch/              # official Dispatch plugin (skills for Claude Code + Codex)
├── release-notes/             # release notes + assisted-update metadata
├── .dispatch/                 # repo-level Dispatch config
│   ├── config.json            # repo-level settings (e.g. Linear integration)
│   ├── job-state/             # persistent state files for recurring jobs
│   ├── personas/              # persona definitions (*.md)
│   └── tools.json             # repo-specific MCP tools + lifecycle hooks
└── docs/
    └── jobs/                  # job prompt definitions (backup copies)
```

- Use `pnpm` (not npm) for all package management.
- Shared utilities live in `apps/server/src/shared/` — import via relative paths (e.g. `../shared/lib/run-command.js`).

## CRITICAL: Stay in Your Worktree

If you were started in a git worktree (check: does your working directory contain `.dispatch/worktrees/`?), **every file path you read, write, edit, or delete MUST use the worktree path**. Never `cd` to or reference the parent repo at `/Users/brad/dev/apps/dispatch/` directly — that is the main working tree and other agents or the user may be working there. Edits to the wrong tree silently land in the wrong place, cause merge conflicts, and get lost.

- Your working directory is your worktree root. Use relative paths or the full worktree-prefixed absolute path.
- Run `git` commands from your worktree — they automatically operate on the correct branch.
- Run `pnpm`, `vitest`, and other tools from the worktree root so they pick up your changes.
- If you need to verify which tree you are in: `git rev-parse --show-toplevel`.

## UI Validation

- For any UI/layout/style/feature change, validate behavior in Playwright before marking the task complete.
- Include at least one Playwright interaction that covers the changed UI path (for example: open/close panes, modal flow, or action button state changes).
- Capture at least one screenshot per validation flow and post it as a file attachment with the `post` MCP tool (`attachments: [{ type: "file", path }]`). Never leave screenshots local-only.
- For pages with SSE/WebSocket activity, do not use Playwright `waitUntil: "networkidle"` for readiness checks.
- Use `waitUntil: "domcontentloaded"` (or `"load"`) and wait for concrete UI-ready signals (visible control/text/state) instead.
- **Browser cleanup**: When you are done with Playwright validation, call `browser_close` to shut down the browser. Leaving browsers open wastes resources on headless VMs.

## Component Preference

- Prefer shadcn/ui components over hand-rolled UI when an equivalent shadcn option exists.
- Only hand-roll when there is no suitable shadcn primitive or composition path.

## Frontend State Ownership

- Default to colocating state with the smallest component that fully owns the UI and behavior.
- Do not lift state to a route, layout, or app root unless multiple siblings must coordinate through a shared owner.
- Treat route/layout-level state as a fallback, not a default. Those layers should not become new dumping grounds.
- Treat global client state (including Jotai atoms) as rare and justified only for truly cross-cutting concerns.
- If a piece of state only drives one feature subtree, keep it in that subtree even if persistence is needed. Prefer a small local persistence helper over promoting the whole state domain to global state.
- Prefer URL state over in-memory UI state for shareable/navigation state such as selected entity, active detail pane, or tab when that state should survive reloads, deep links, or back/forward navigation.
- Prefer React Query for server state, request lifecycle state, caching, invalidation, optimistic updates, and background refetching. Do not mirror API state into local UI state unless there is a specific UI-only derivation that cannot be computed from query data.
- Before adding a new atom, first ask:
  1. Is this server state? Use React Query.
  2. Is this only used by one component or feature cluster? Keep it local.
  3. Is this shareable navigation state? Put it in the URL.
  4. Is this truly app-wide and cross-cutting? Only then consider Jotai.
- `App.tsx` is a composition root, not a feature implementation file. Do not add feature-specific dialog state, selection state, or view toggles there when they can live lower in the tree.

### Persisted UI state (localStorage)

- For UI state that needs to survive reloads, prefer jotai's `atomWithLocalStorage` helper in `apps/web/src/lib/store.ts` over a hand-rolled `useState` + `useEffect` pattern. The helper handles SSR-safety, JSON serialization, read-on-mount, and write-on-change in one place — and it sidesteps the read/write effect-ordering races that come up when persistence keys change at runtime.
- When the persisted value needs to be keyed by another value (cwd, agent ID, route segment, etc.), use jotai's `atomFamily` to produce one atom per key rather than building a custom prefix scheme on top of plain atoms. Example: `atomFamily((cwd: string) => atomWithLocalStorage(\`dispatch:foo:${cwd}\`, default))`.
- This is the one place where Jotai is preferred over local state even for feature-specific UI — the persistence machinery belongs in a shared spot, and the atom's identity stays stable across mounts so the value reads back correctly when the dialog/component remounts.

## Pre-Completion Checks (Mandatory)

Before marking any task as done, run the following checks and fix any failures:

1. **Type checking**: `pnpm run check` (runs `tsc --noEmit` for backend + web).
2. **Web finalization**: If any files under `apps/web/` changed, run `pnpm run finalize:web` (type check + production build).
3. **E2E tests**: `pnpm run test:e2e` (Playwright). Always spins up its own isolated DB and server — safe to run alongside other agents.
4. **Unit tests**: `pnpm run test` (Vitest) if backend logic changed.

- Do not consider a task complete until all applicable checks pass.
- If a pre-existing test is flaky (fails before your changes too), note it in your response but do not skip the rest of the suite.

## Web Finalization

- If any files under `apps/web/` changed, run `pnpm run finalize:web` before marking the task complete.
- After running `pnpm run finalize:web`, verify the served app via the repo MCP dev tools when the task affects UI/theme/rendering behavior.
- After UI/theme/rendering validation on an isolated dev stack, leave that stack running for the user to inspect unless they explicitly ask you to tear it down.
- In the final response, include the exact local URLs/ports for the running validation stack and the cleanup command(s) needed to stop it later.

## Temporary Files

- Never write temporary files (screenshots, test scripts, scratch files) to the repo root.
- Use `/tmp/` or `$DISPATCH_MEDIA_DIR` for ephemeral files.
- Playwright screenshots should be posted as file attachments via the `post` MCP tool, not saved locally.

## Dev Server Management (CRITICAL)

- **NEVER run `pnpm run dev` directly** in your terminal — it will block your session and killing it can kill your agent process.
- **NEVER use `pkill`, `killall`, or `lsof | xargs kill`** to manage dev servers — these can kill your own agent process.
- Use the repo MCP dev tools to manage dev environments: `repo_dev_up`, `repo_dev_restart`, `repo_dev_down`, `repo_dev_status`, and `repo_dev_logs`. They spin up an isolated DB, API server, and Vite frontend on auto-selected free ports.
- **Prefer `repo_dev_restart` over `repo_dev_down` + `repo_dev_up`** when you need to pick up code changes. Restart reuses the same ports and DB — no wasted time recreating containers. Only use `repo_dev_down` when the user asks or you're done for good.
- If you start a validation stack for user review, do not tear it down automatically at the end of the turn unless the user explicitly asks.
- `repo_dev_up` auto-selects free ports and prints the URLs — just use the printed URLs.

## Backend Testing Safety

- Treat `127.0.0.1:6767` as production by default; do not stop or kill the existing production server for ad-hoc testing.
- When backend changes need local validation, use `repo_dev_up` and point validation tooling to the printed URL.
- Only operate on production (`:6767`) when explicitly requested by the user.

## Development Database

- Production uses the `dispatch` database. Never connect to it from dev servers.
- `repo_dev_up` creates an isolated Postgres container with its own port — no manual `DATABASE_URL` setup needed.
- Migrations run automatically on API server start.

## Optional VM Release Validation

VMs are for high-risk installation, service-manager, release-artifact,
assisted-update, or update-migration changes—not ordinary development or the
default test suite. Follow [docs/vm-release-validation.md](docs/vm-release-validation.md)
when that validation is warranted.

**Always ask the user before provisioning, starting, resetting, modifying, or
using a VM.** This applies even when a named local VM already exists. Explain
the scenario to be exercised, expected resource/use impact, and whether the
VM will be changed or cleaned up. Do not make VM validation a prerequisite for
unrelated changes or CI.

## The Stream

- Everything an agent hands the user goes into its stream with `post`: a `link` for a dev URL or doc, a `pr` attachment for a pull request, a `code` attachment for IDs, commands and env values, a `file` attachment for screenshots and reports, a `question` or `form` block for a decision.
- Status is derived by the server (working, waiting, idle, blocked); there is nothing for an agent to report. An open `question` or `form` addressed to the user is what shows the agent as waiting.
- `post` with `to: <agentId>` reaches another agent; children post into their parent's stream. Revise a block with `update`.

## Assisted Update Release Notes

- When the user indicates that a release should require or recommend assisted update handling, create or update `release-notes/next-assisted-update.json`.
- Follow `release-notes/AUTHORING.md` for the schema, merge rules, and authoring guidance. Do not invent a parallel format.
- If `release-notes/next-assisted-update.json` already exists, merge your change into that file instead of creating a second metadata file.
- Validate the file before finishing with:

  `pnpm tsx bin/embed-assisted-update.ts --check-only --metadata release-notes/next-assisted-update.json`

## Personas

- When asked to launch a persona (e.g., "run security review", "test this as an end user"), use `launch_agent` with `persona: <slug>`; the `prompt` is the persona's briefing.
- Make the briefing thorough: what was built, key files changed, areas of concern, and any specific instructions from the user.
- Be explicit about scope in the briefing — tell the persona what the changes are and what is NOT in scope. This helps them avoid flagging pre-existing issues.
- Available personas are defined in `.dispatch/personas/` as markdown files, plus Dispatch's built-in `code-review` generalist. Call `list_personas` for the effective list.
- A reviewer persona posts one `review` block (verdict, summary, findings) to the agent that launched it; each finding is a thread. The launcher resolves or disputes findings with `update` on that block's `state` and answers questions in the thread.
- When acting as a persona agent, only provide feedback on code and behavior that is part of or directly affected by the changes in the diff. Do not flag pre-existing issues.
