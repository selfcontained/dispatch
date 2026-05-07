---
job: docs-audit
updated_at: 2026-05-06
---

# docs-audit — state handoff

Each run of the docs-audit job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-inventory the whole repo every night.

## last_audited_sha

`e680934cc9de06aa5f8ba2b7ec2e74c29c93b693` — HEAD at the start of the 2026-05-06 run. v0.19.4 release tag.

## next_focus

**Audit docs/03-api-spec.md for the remaining backlog items.** Several API surface gaps have accumulated:

- `GET /api/v1/release/auto-check/mode`, `PUT /api/v1/release/auto-check/mode`, `POST /api/v1/release/auto-check/run` (PR #493) and the SSE `release-info` event are undocumented.
- The Slack-fallback delay claim ("~3s") needs verification against `apps/server/src/notifications/slack.ts`.
- The Media POST body shape (`{ file, description }`) may have changed — check if `description` is optional or if `name` was added.
- Confirm the Streaming section's multipart MJPEG framing claim is still accurate.

This is a focused api-spec pass that closes four backlog items.

## backlog

Items noticed during prior passes but left for later runs. Pick the most relevant one when `next_focus` is empty or already done.

- **docs/03-api-spec.md — multiple endpoints missing.** The full personalities CRUD surface (`GET /personalities`, `POST /personalities`, `PATCH /personalities/:id`, `DELETE /personalities/:id`, `POST /personalities/active`) plus the body shapes (`{ name, prompt }`, `name ≤ 80`, `prompt ≤ 1000`, 409 on duplicate name) are undocumented. The agents-settings endpoint (`POST /api/v1/agents/settings` for `copyModeAssistEnabled`), `GET /api/v1/agents/:id/diff-stats`, and `POST /api/v1/agents/:id/prompt-rename` (PR #482) are also new and missing. Add when an api-spec pass next runs.
- **docs-pane "Reviewers" section — resolution capture UI surfaces.** PR #374 (`8ad64b9`) added resolution reasons + parent summary rendering in `feedback-panel.tsx` (`ResolutionInfoBlock` at line 735, resolution `summary` at lines 1179 / 1570). The docs don't describe what the human sees in the Feedback panel for resolved items; could be a one-paragraph addition to "Submitting findings" or "Round-trip reviews".
- **docs-pane "Agents" section — sidebar badges enumeration.** The Agents section under "Status indicators" / "Agent details" doesn't enumerate every conditional badge that `agent-card.tsx` renders (Job, Update, Attention, full-access). A single "Sidebar badges" subsection in Agents that enumerates them all would close the cross-reference gap.
- **docs-pane "Updates" section — `ASSISTED_UPDATE_METADATA_INVALID`.** Low-impact but worth a sentence if the section gets revisited.
- **docs-pane "Updates" section — release-channel deep mechanics.** PR #487 (2026-05-03) may have introduced new user-visible release-detection state — spot-check `release-manager.tsx` next time the Updates section is touched.
- **docs-pane "Status Events" section — `metadata` parameter** — `dispatch_event` accepts an optional `metadata` (Record<string, unknown>) param. Currently undocumented in docs-pane. Revisit only if a feature starts using metadata in a user-visible way.
- **docs-pane "Jobs" section — `JobNotifyConfig` is data-model-only today** — not exposed via any API or UI. Revisit when a UI or API is added.
- **docs-pane "Worktrees" — failure surfaces (PR #409).** Worktree-create failures now mark the agent `stopped` with `last_error` and a blocked latest_event. The docs-pane Worktrees section didn't get the failure UX paragraph — add if the failure path becomes surprising.
- **`docs/04-agent-lifecycle.md` — round-trip back from in-app docs.** If the in-app docs-pane gains a "Lifecycle" or "Architecture" section, link to this doc rather than re-explaining the state machine.
- **`release-notes/AUTHORING.md` — migration manifest authoring is undocumented.** CRU-146 added `update-migrations/*.yaml` manifests with their own evaluator but AUTHORING.md does not cover them yet.
- **`docs/10-operations-runbook.md` — handed-off concerns.** (a) diagnostics jq examples worth re-checking if response shape is rev'd; (b) runbook does not mention `bin/preflight` / `bin/dispatch-stream` / `bin/pack-release`.
- **`unknown` AgentStatus is dead code.** Worth a separate cleanup PR (not docs work).

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
- **Agent types list accretes silently.** `AGENT_TYPES` in `apps/web/src/lib/agent-types.ts` started as `claude/codex/opencode` and now includes `terminal`.
- **MCP tool sets change by agent type.** The AGENT / JOB / PERSONA tool lists evolve independently.
- **System-prompt injection has a per-flow allowlist.** Personalities are appended only for "regular" launches.
- **Repo tool prefix is `repo_`, not `repo.`.** MCP clients don't support dots in tool names.
- **Push-based prompt injection makes some "what the agent sees" claims wrong.** Cross-check the docs whenever injection-prompts.ts is edited.
- **Media sidebar has two layout modes (drawer / pinned).** Docs claims about "opening the sidebar" should specify which mode is the default (drawer). The pin/unpin toggle and its layout effects are a frequent source of confusion.
- **Automatic update check introduced a new SSE event.** `release-info` as an SSE event type is undocumented in the SSE schema surface.
- **Per-install state files live outside the repo checkout.** `~/.dispatch/release.json`, `~/.dispatch/assisted-update.json`, `~/.dispatch/applied-migrations.json`, `~/.dispatch/cache/release-<tag>.tar.gz`.
- **MCP tool params accrete without docs updates.** `includeDiff` on `dispatch_launch_persona` (PR #496) defaulted to true and wasn't in the docs until this run. Watch for new optional params on existing tools.
- **README MCP tool lists go stale when tool sets expand.** JOB_TOOLS gained review round-trip tools without a README update; cross-check `AGENT_TOOLS`/`JOB_TOOLS`/`PERSONA_TOOLS` in `apps/server/src/shared/mcp/server.ts` whenever the README tools section is touched.

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
