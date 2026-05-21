---
job: docs-audit
updated_at: 2026-05-20
---

# docs-audit — state handoff

Each run of the docs-audit job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-inventory the whole repo every night.

## last_audited_sha

`17056a78c2d49d93deb72daa9cfcf8c6ea638c0c` — HEAD at the start of the 2026-05-20 run.

## next_focus

**Audit docs-pane "Automations: Templates & Jobs" section against the template create/edit form fields in `automations-form-fields.tsx` and `automations-create-dialog.tsx`.** PR #563 improved template variable templating (optional args, `|required`, `|multiline` modifiers) and the previous run updated the docs for this. However, the context picker unification (PR #562) changed how directories and worktree settings are shared between template launch and create-agent dialogs — verify the "Creating a template" and "Launching templates" subsections still accurately describe the UI flow and field set.

## backlog

Items noticed during prior passes but left for later runs. Pick the most relevant one when `next_focus` is empty or already done.

- **Agent history type filter missing Cursor and Terminal.** `agent-history-tab.tsx` lines 200-203 only list Claude, Codex, OpenCode in the type filter dropdown. `AGENT_TYPES` includes all five (claude, codex, cursor, opencode, terminal). This is a UI bug, not a docs issue — but worth noting here in case a docs claim about filtering surfaces later.
- **docs-pane "Updates" section — `ASSISTED_UPDATE_METADATA_INVALID`.** Low-impact but worth a sentence if the section gets revisited.
- **docs-pane "Updates" section — release-channel deep mechanics.** PR #487 (2026-05-03) may have introduced new user-visible release-detection state — spot-check `release-manager.tsx` next time the Updates section is touched.
- **docs-pane "Status Events" section — `metadata` parameter** — `dispatch_event` accepts an optional `metadata` (Record<string, unknown>) param. Currently undocumented in docs-pane. Revisit only if a feature starts using metadata in a user-visible way.
- **docs-pane "Jobs" section — `JobNotifyConfig` is data-model-only today** — not exposed via any API or UI. Revisit when a UI or API is added.
- **docs-pane "Worktrees" — failure surfaces (PR #409).** Worktree-create failures now mark the agent `stopped` with `last_error` and a blocked latest_event. The docs-pane Worktrees section didn't get the failure UX paragraph — add if the failure path becomes surprising.
- **`docs/04-agent-lifecycle.md` — round-trip back from in-app docs.** If the in-app docs-pane gains a "Lifecycle" or "Architecture" section, link to this doc rather than re-explaining the state machine.
- **`release-notes/AUTHORING.md` — migration manifest authoring is undocumented.** CRU-146 added `update-migrations/*.yaml` manifests with their own evaluator but AUTHORING.md does not cover them yet.
- **`unknown` AgentStatus is dead code.** Worth a separate cleanup PR (not docs work).
- **README install table — Cursor CLI install instructions are approximate.** The binary defaults to `agent`; the exact npm package / install path should be verified once the CLI is publicly documented by Anysphere.
- **`docs/18-subagent-orchestration.md` — add to README docs index when implemented.** Currently a design doc for a forward-looking feature. Add once the feature ships and has user-facing surface.
- **docs-pane "Repo Tools" Brain subsection — expand when Brain gains a UI.** The current Brain docs describe the MCP tool interface only. If/when a Brain explorer UI is added (e.g. in Settings or Activity), add a subsection describing the UI surface.
- **`docs/03-api-spec.md` — add Brain API endpoints.** The Brain tools work through MCP, but the underlying store routes (`/brain/objects`, `/brain/events`) may gain a direct HTTP API. When they do, add them to the API spec.

## drift_patterns

Observations about where docs tend to go stale. Each run should add new observations and prune ones that no longer apply.

- **Operator-facing prose docs accumulate aspirational claims.** When auditing operator-facing docs, grep the source for the verb and confirm the call exists.
- **API-spec drift compounds quietly.** When the audit pivots to api-spec, reconcile against `grep -nE '(server|app)\.(get|post|patch|delete)' apps/server/src/server.ts` rather than diff-driven discovery.
- **User-facing docs drift fastest.** The in-app docs-pane content is the first thing to notice when behavior changes.
- **Settings panes spawn whole new docs sections.** Pattern: a keyboard / command-palette layer is a docs section when the feature surface is large enough.
- **New keyboard layers land without docs.** Watch for `useHotkey` / `data-hotkey-disable` / cmdk imports in future diffs.
- **Form sections evolve from single-checkbox to multi-checkbox.** When auditing a checkbox claim, look for nearby checkboxes in the surrounding `<div>`.
- **Form labels rename without docs updates.** Grep the literal label string in the relevant component file.
- **Review tooling reshapes by deletion as well as addition.** When a review feature lands, grep for the tool names that were in the docs last time.
- **"Sidebar shows X" claims understate what's actually rendered.** Open the actual rendering component and enumerate every span.
- **Settings defaults flip without the docs noticing.** Trace default claims to both the component's `useState(...)` initial value and the server-side fallback.
- **The built-in MCP tool list sprawls without touching the docs.** Grep for `AGENT_TOOLS = new Set` and diff against the `Built-in tools` list in `docs-pane.tsx`.
- **The create-agent dialog accretes options silently.** When `create-agent-dialog.tsx` gains a field, the "Creating an agent" bullet list needs a matching entry.
- **Agent types list accretes silently.** `AGENT_TYPES` in `apps/web/src/lib/agent-types.ts` started as `claude/codex/opencode` and now includes `terminal` and `cursor`. All five need to appear in every type-list in docs-pane.
- **MCP tool sets change by agent type.** The AGENT / JOB / PERSONA tool lists evolve independently.
- **System-prompt injection has a per-flow allowlist.** Personalities are appended only for "regular" launches.
- **Repo tool prefix is `repo_`, not `repo.`.** MCP clients don't support dots in tool names.
- **Push-based prompt injection makes some "what the agent sees" claims wrong.** Cross-check the docs whenever injection-prompts.ts is edited.
- **Media sidebar has two layout modes (drawer / pinned).** Docs claims about "opening the sidebar" should specify which mode is the default (drawer). The pin/unpin toggle and its layout effects are a frequent source of confusion.
- **Per-install state files live outside the repo checkout.** `~/.dispatch/release.json`, `~/.dispatch/assisted-update.json`, `~/.dispatch/applied-migrations.json`, `~/.dispatch/cache/release-<tag>.tar.gz`.
- **MCP tool params accrete without docs updates.** `includeDiff` on `dispatch_launch_persona` (PR #496) defaulted to true and wasn't in the docs until this run. Watch for new optional params on existing tools.
- **README MCP tool lists go stale when tool sets expand.** JOB_TOOLS gained review round-trip tools without a README update; cross-check `AGENT_TOOLS`/`JOB_TOOLS`/`PERSONA_TOOLS` in `apps/server/src/shared/mcp/server.ts` whenever the README tools section is touched.
- **API-spec endpoint tables go stale when new route files are added.** Personalities CRUD was added without an api-spec section. When a new route file appears in `apps/server/src/routes/`, check whether its endpoints are in the spec.
- **History endpoint query params change without docs updates.** The `sort` values changed from `recent|oldest` to `created_at|name|updated_at` and an `order` param was added, but the api-spec wasn't updated. Grep the actual query parsing in the route handler.
- **Job form accretes advanced settings without docs updates.** PR #510 added callable/singleton toggles to both the create and settings forms. The in-app docs Jobs section needs to mirror these whenever the form gains a new field.
- **New agent types land without docs updates.** Cursor was added in PR #513 without updating any docs surfaces. Every location that enumerates agent types needs checking when a new type is added.
- **README CLI install table drifts from agent-type-settings.** The README CLI table should match the agent types that can be enabled in the UI; when a new type is added to `AGENT_TYPES`, add a row.
- **Template launch dialogs now always open.** PR #523 changed inline play and command palette to always open a launch dialog (agent type override + args). If the dialog gains more fields, the "Launching templates" section needs updating.
- **Template create/edit forms accrete checkboxes.** PR #528 added `allowMedia` — when the template form gains a new checkbox, the "Creating a template" docs list needs a matching entry.
- **Agent detail metadata claims trail UI changes.** The "Agent details" paragraph described "agent type" when the card actually shows the access-mode badge (Full access / Sandboxed). Always re-read the rendering component when auditing this paragraph.
- **Create-agent nested controls hide behind the worktree checkbox.** The "Starting branch" picker and "Create a new branch" checkbox are only visible when worktree mode is checked. Docs describing these controls should mention the conditional visibility.
- **CLAUDE.md project structure tree drifts as new feature directories are added.** Check `ls -d apps/server/src/*/` against the tree whenever new packages or route-adjacent dirs appear.
- **API-spec agent-types enum lists go stale.** The Settings section listed only four types; `cursor` was missing. Always check `AGENT_TYPES` array when touching the agent-types endpoint docs.
- **API-spec body schemas lag behind Zod schemas in route handlers.** When a new field is added to a route's Zod schema, the spec often doesn't get updated. Cross-check route handlers directly rather than relying on PRs to flag it.
- **Assisted-update check descriptions drift from implementation.** The check names in `release-metadata.ts` are stable but the check logic in `release-checks.ts` evolves (e.g. `version_converged` reads `release.json`, not the health endpoint). Re-verify descriptions against the actual functions when touching this section.
- **Collapsed sidebar card claims drift from agent-card.tsx layout changes.** PR #558 moved the repo name from the expanded detail card to the collapsed status line and removed the event message from collapsed view. Any future sidebar layout change needs a docs-pane cross-check.
- **New MCP tool categories (e.g. Brain) land without docs section.** PR #569 added 6 brain tools to AGENT_TOOLS and JOB_TOOLS. When a new tool category is added, the "Built-in tools" list AND the README MCP tools section both need updates, plus a conceptual subsection if the feature is new.

## Notes for the next run

- If `next_focus` feels too big for one night, split it and push half back into `backlog` with a concrete description.
- Treat each run as one focused slice. Recent passes all fit comfortably in one PR each. Aim for that size.
- If you notice something that isn't drift but is genuinely missing, add it to `backlog` with enough detail that a future run can act on it without re-discovering the context.
- When the diff since `last_audited_sha` includes a meaningful UI change, it's reasonable to pivot away from `next_focus` to handle the diff-driven update first.

## History

- **2026-04-18** (Agents) — Audited docs-pane "Agents" section. Fixed status-indicator color mapping, added Autonomous Review checkbox and Create-with-prompt flow, clarified auto-naming.
- **2026-04-18** (Repo Tools) — Audited docs-pane "Repo Tools" section. Fixed tool prefix `repo.` → `repo_`, documented `scope`, expanded built-in tool list 7 → 14.
- **2026-04-18** (Reviewers) — Audited docs-pane "Reviewers" section. Removed stale `{{context}}`/`{{diff}}` placeholders, added Review lifecycle subsection.
- **2026-04-18** (Worktrees) — Audited docs-pane "Worktrees" section. Flipped reversed worktree-location default (sibling, not nested).
- **2026-04-19** (Jobs) — Seeded a new docs-pane "Jobs" section (form fields, run lifecycle, on-demand runs, history).
- **2026-04-19** (Media & Sharing) — Audited docs-pane "Media & Sharing" section. Added PDF + text-extension family, split sharing into three subsections.
- **2026-04-20** (Notifications) — Audited docs-pane "Notifications" section. Rewrote into Browser Notifications / Sound Cues / Agent-Initiated subsections; fixed focus-aware suppression framing.
- **2026-04-22** (Status Events) — Audited docs-pane "Status Events" section. Updated "How events are used" copy to reflect three rendered spans.
- **2026-04-23** (Reviewers — round-trip) — Audited docs-pane "Reviewers" section. Fixed `review_status` (progress-ping only), added Round-trip subsection covering parent + reviewer-side tools.
- **2026-04-24** (Agents — terminal type) — Audited docs-pane "Agents" section. Added terminal type, marked Full access / Autonomous Review / Create-with-prompt as CLI-only, noted hidden surfaces for terminal agents.
- **2026-04-25** (Worktrees — CRU-139) — Pivoted to Worktrees because PR #409 renamed checkbox to "Create managed git worktree". Added Branch options subsection (createNewBranch sub-checkbox), branch-preservation behavior on archive, and lockfile-driven deps auto-install.
- **2026-04-26** (Updates — assisted-update / CRU-143) — Added new top-level docs-pane Updates section (release channel, one-click update, assisted update, gate-card, three metadata modes, structured phase progression). Synced CLAUDE.md with AGENTS.md (Assisted Update Release Notes block).
- **2026-04-27** (Reviewers — push-based) — Audited docs-pane "Reviewers" section against PR #416's push-based refactor.
- **2026-04-28** (API spec) — Closed the long-deferred `docs/03-api-spec.md` next_focus.
- **2026-04-29** (Agent lifecycle) — Rewrote `docs/04-agent-lifecycle.md` against `apps/server/src/agents/manager.ts`.
- **2026-04-29** (Ops runbook) — Rewrote `docs/10-operations-runbook.md` against assisted-update + CRU-146.
- **2026-04-30** (Updates v2) — Rewrote Updates one-click + agent-assisted sections for split-button + pending-migrations + failed phase.
- **2026-05-01** (Jobs v2) — Refactored Jobs "Creating a job" into basic/Advanced split; added JOB_TOOLS, auto-review, state-across-runs.
- **2026-05-02** (Personalities) — Added new docs-pane Personalities section.
- **2026-05-03** (Agents v2 — diff badge + tmux scrollback) — Added diff-stats badge and Tmux scrollback subsections to Agents.
- **2026-05-04** (Keyboard shortcuts + rename + auto-check) — Added new docs-pane "Keyboard Shortcuts" section (global hotkeys + command palette). Added "Renaming agents" subsection to Agents. Updated "Checking for updates" in the Updates section to describe automatic background checks and the release-available toast (PR #493).
- **2026-05-05** (Reviewers includeDiff + Media sidebar modes + History pins) — Updated Reviewers "How personas work" to document `includeDiff` param (PR #496). Updated Media sidebar section to describe drawer vs. pinned modes and the pin toggle (next_focus from PR #468). Noted Pins tab in Agent History detail view (PR #499).
- **2026-05-06** (Size-adaptive review diffs + README audit) — Updated Reviewers "How personas work" to document size-adaptive diff behavior (PR #501: diffs >15KB get file-level summaries + git commands instead of inline). Updated README.md: added "shortcuts" and "personalities" to docs section list, added personalities and keyboard shortcuts to features list, fixed JOB_TOOLS list (added 6 missing review round-trip tools).
- **2026-05-07** (API spec v2) — Closed the api-spec `next_focus`. Added: release auto-check endpoints (auto-update-mode, cached-info), SSE event type enumeration (15 types), Personalities CRUD section, diff-stats and prompt-rename agent endpoints. Fixed: History query params (sort values, added search/order, archived-only behavior), Media POST source field, Settings endpoint description.
- **2026-05-09** (Jobs — callable + singleton) — Pivoted from next_focus (Agents history/base-ref) to diff-driven update for PR #510. Added "Show in command palette" and "Single instance" to Jobs advanced settings list. Updated "On-demand runs" to reflect singleton-gated concurrency. Added callable-jobs paragraph to Keyboard Shortcuts command palette section.
- **2026-05-10** (Cursor agent type + templates) — Pivoted from next_focus (sidebar badges) to diff-driven update for PRs #513/#517. Added `cursor` to all agent-type lists in docs-pane (Agents, Personalities, Automations Templates, Automations Jobs, Reviewers). Updated README features list and CLI install table with Cursor. Templates section already existed from PR #515 — no additional docs needed.
- **2026-05-11** (Sidebar badges + template launch override) — Closed the sidebar badges next_focus: added "Sidebar badges" subsection to Agents documenting Attention, Job, and Update badges. Fixed "Launching templates" section: inline play button and command palette now always open a launch dialog (PR #523), and the dialog includes an agent type override selector.
- **2026-05-12** (Template media attachments + reviewer resolution UI) — Diff-driven: PR #528 added `allowMedia` checkbox to templates and startup files/links to the launch dialog. Added "Allow media attachments on launch" to "Creating a template" field list and media-attachment paragraph to "Launching templates". next_focus: added resolution-UI paragraph to Reviewers "Submitting findings" describing Fixed/Ignored statuses, resolution reason display, and commit SHA.
- **2026-05-13** (Agents — history/base-ref) — Closed the Agents history/base-ref next_focus. Fixed "Agent details" paragraph: replaced inaccurate "agent type" claim with correct description of repo name + base/working branch display for worktree agents vs. working directory for non-worktree agents. Added "Starting branch" picker to "Creating an agent" bullet list — was missing from the worktree controls description. Noted history type-filter UI bug (missing Cursor/Terminal) in backlog.
- **2026-05-14** (CLAUDE.md structure tree + Reviewers resolution verification) — Verified next_focus (Reviewers resolution UI paragraph): Fixed/Ignored statuses, resolution reasons, and commit SHA all confirmed accurate against feedback-panel.tsx and MCP tool definitions. Fixed CLAUDE.md project structure tree: added 5 missing server/src directories (media, reviews, routes, server, templates), replaced stale `.dispatch/worktrees/` with actual `job-prompts/` and `job-state/` entries. Verified MCP tool lists (AGENT_TOOLS, JOB_TOOLS, PERSONA_TOOLS) and create-agent dialog fields — all in sync.
- **2026-05-16** (API spec — Templates CRUD) — Added new Templates section to `docs/03-api-spec.md` covering all 6 endpoints (list, get, create, update, delete, launch) with body schemas and multipart launch documentation. Fixed Settings agent-types list (added missing `cursor`). Added `template.changed` SSE event to the events table.
- **2026-05-17** (API spec — Jobs body schemas) — Closed the Jobs POST/PATCH body schema next_focus. Added `POST /jobs` body schema with all 16 fields from `AddJobBodySchema`, field-by-field descriptions, and `PATCH /jobs` note. Added `DELETE /jobs` and `POST /jobs/enable` / `POST /jobs/disable` bodies. Fixed `GET /jobs/history` params from stale `jobId, status, limit, offset` to actual `name, directory, limit`. Added new drift pattern for Zod schema/spec lag.
- **2026-05-18** (Ops runbook — bin scripts + check descriptions) — Closed the ops-runbook bin scripts next_focus. Added `bin/preflight` to Installation section. Added `bin/pack-release` mention to Release Pipeline. Added comprehensive Bin Scripts table (all 9 scripts). Fixed 3 inaccurate assisted-update check descriptions: `version_converged` reads `release.json` not health endpoint, `service_entrypoint` checks `package.json` not launchd plist, `expected_runtime_artifact` also checks `apps/web/dist/index.html`. Added drift pattern for check-description staleness.
- **2026-05-19** (Agents — sidebar collapsed view + create-agent audit) — Diff-driven: PR #558 moved repo name from expanded detail card to collapsed sidebar status line and removed event message from collapsed view. Fixed "Status indicators" section (collapsed card now shows status + time + repo name, not event message). Fixed "Agent details" section (worktree agents no longer show repo name row — just base + working branch). Audited create-agent dialog fields (next_focus): all 6 form fields match docs, no drift found.
- **2026-05-20** (Brain V1 — built-in tools + shared memory) — Diff-driven: PR #569 added Dispatch Brain V1 with 6 new MCP tools (`brain_get_object`, `brain_store_object`, `brain_list_objects`, `brain_delete_object`, `brain_append_event`, `brain_query_events`) to both AGENT_TOOLS and JOB_TOOLS. Added brain tools to docs-pane "Built-in tools" list and "Tools available to job agents" list. Added "Brain (shared memory)" subsection to Repo Tools explaining the concept. Updated "State across runs" to mention Brain as an alternative to filesystem handoff. Added brain tools to README Interactive agents table and Job agents list. Fixed CLAUDE.md project structure tree (added missing `brain/` directory).
