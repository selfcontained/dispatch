---
job: docs-audit
updated_at: 2026-05-12
---

# docs-audit — state handoff

Each run of the docs-audit job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-inventory the whole repo every night.

## last_audited_sha

`d58fc998ebef34318e98fd0c57d980a74b9b42dc` — HEAD at the start of the 2026-05-12 run. v0.20.6 release tag.

## next_focus

**Audit docs-pane "Agents" section — history view and base-ref behavior.** The backlog has deferred agent history items from prior passes. Cross-check the Agents "History" subsection against `activity-pane.tsx` — verify whether the pins/media/feedback tabs described in the docs match the actual rendering. Also verify the base-ref claim (what `baseBranch` does when set) against `apps/server/src/agents/manager.ts`.

## backlog

Items noticed during prior passes but left for later runs. Pick the most relevant one when `next_focus` is empty or already done.

- **docs-pane "Updates" section — `ASSISTED_UPDATE_METADATA_INVALID`.** Low-impact but worth a sentence if the section gets revisited.
- **docs-pane "Updates" section — release-channel deep mechanics.** PR #487 (2026-05-03) may have introduced new user-visible release-detection state — spot-check `release-manager.tsx` next time the Updates section is touched.
- **docs-pane "Status Events" section — `metadata` parameter** — `dispatch_event` accepts an optional `metadata` (Record<string, unknown>) param. Currently undocumented in docs-pane. Revisit only if a feature starts using metadata in a user-visible way.
- **docs-pane "Jobs" section — `JobNotifyConfig` is data-model-only today** — not exposed via any API or UI. Revisit when a UI or API is added.
- **docs-pane "Worktrees" — failure surfaces (PR #409).** Worktree-create failures now mark the agent `stopped` with `last_error` and a blocked latest_event. The docs-pane Worktrees section didn't get the failure UX paragraph — add if the failure path becomes surprising.
- **`docs/04-agent-lifecycle.md` — round-trip back from in-app docs.** If the in-app docs-pane gains a "Lifecycle" or "Architecture" section, link to this doc rather than re-explaining the state machine.
- **`release-notes/AUTHORING.md` — migration manifest authoring is undocumented.** CRU-146 added `update-migrations/*.yaml` manifests with their own evaluator but AUTHORING.md does not cover them yet.
- **`docs/10-operations-runbook.md` — handed-off concerns.** (a) diagnostics jq examples worth re-checking if response shape is rev'd; (b) runbook does not mention `bin/preflight` / `bin/dispatch-stream` / `bin/pack-release`.
- **`docs/03-api-spec.md` — Jobs POST/PATCH body schema.** The spec has the endpoint table but doesn't document the body fields for `POST /jobs` or `PATCH /jobs`. The `callable` and `singleton` fields added in PR #510 are not in the spec; neither are any of the other body fields. Consider adding a body schema subsection next time the api-spec is touched.
- **`docs/03-api-spec.md` — Templates CRUD.** PR #515 added `apps/server/src/routes/templates.ts` but the api-spec has no Templates section. When creating, include the `allowMedia` field (defaults true, PR #528) and the multipart launch endpoint for startup files/links.
- **`docs/03-api-spec.md` — Template launch `agentType` override.** PR #523 added an optional `agentType` field to `POST /templates/:id/launch`. Add to the Templates CRUD section when that section is created.
- **`unknown` AgentStatus is dead code.** Worth a separate cleanup PR (not docs work).
- **README install table — Cursor CLI install instructions are approximate.** The binary defaults to `agent`; the exact npm package / install path should be verified once the CLI is publicly documented by Anysphere.

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
