# App Refactor Blueprint

## Goals

- Break `apps/web/src/App.tsx` into route/layout/feature boundaries that reflect ownership.
- Push UI state down to the smallest component or feature that fully owns the related behavior.
- Use URL params for shareable navigation state such as selected job, selected agent, active tab, and focused detail views.
- Use React Query for server/request state instead of mirroring API state into app-level component state.
- Keep stable chrome mounted across navigation by using layouts and nested routes instead of branching inside `App.tsx`.

## Verified Current State

- `apps/web/src/router.tsx` already uses React Router, but `DashboardLayout` still manually interprets `location.pathname` and branches most feature UI from `App.tsx`.
- Jobs already uses URL-driven selection:
  - `JobsProvider` reads `jobId`, `section`, and `runId` from `useParams()`.
  - Job selection and detail tab changes navigate with `navigate("/jobs/...")`.
  - This is the model to follow for agents and other shareable selection state.
- Agents currently do not use route params for selection:
  - `selectedAgentId` is local state in `App.tsx`.
  - `expandedAgentId`, `feedbackDetail`, and sidebar visibility are currently high in the tree, with some backed by Jotai atoms in `apps/web/src/lib/store.ts`.

## Remaining Work After This Branch

- The branch moved agent-specific terminal, media, feedback, and create-dialog ownership out of `App.tsx` and into `AgentsView`.
- The branch also removed dead root-owned agent state and dead global atoms that no longer had consumers.
- But the router/layout refactor is still incomplete:
  - `DashboardLayout` still slices `location.pathname` to decide which top-level section is active.
  - `DashboardLayout` still uses an `isAgentsView ? <AgentsView /> : <non-agents shell />` branch instead of letting the router own section/layout selection.
  - The non-agents shell still renders its own `GlassSidebar` and `SidebarShell` path from `App.tsx`, which keeps the root acting as a manual view router.
  - Settings and activity subsection selection are still derived from pathname inspection at the root instead of route-owned layouts.
- This means the branch improved state ownership, but it did not yet complete the route ownership goal.

### What Still Needs To Happen

- Move top-level section selection out of `DashboardLayout` and into explicit router entries.
- Convert the current manual section switch into route-owned layouts with `Outlet`.
- Keep `App.tsx` limited to shared shell responsibilities:
  - auth/theme/branding/health
  - truly shared layout state from `useLayout`
  - shared providers with real cross-section scope
  - shared mobile shell behavior
- Move section-specific route interpretation down:
  - agents routes belong to an agents layout/route subtree
  - settings section/subsection parsing belongs to settings routes
  - activity tab selection belongs to activity routes
  - jobs provider and jobs frame belong to a jobs layout

### Success Criteria For The Follow-Up

- `App.tsx` no longer reads `location.pathname.split("/")` to infer route meaning.
- `App.tsx` no longer branches between agents and non-agents feature trees.
- React Router primitives such as route elements, `useParams`, `useMatch`, and `Outlet` own route meaning instead of manual pathname parsing.
- Each feature subtree owns its own route-derived state and layout frame.

## Target Architecture

### 1. Router owns screen selection

Replace path-derived booleans in `App.tsx` with explicit route components and nested layouts.

Target shape:

- `RootLayout`
- `AuthLayout`
- `AppLayout`
  - persistent shell chrome only
  - shared header/brand/footer/nav frame
  - `Outlet`
- `AgentsLayout`
  - sidebar/workspace/media frame for agents routes
  - `Outlet`
- `JobsLayout`
  - owns the jobs feature provider boundary
  - owns jobs sidebar/detail frame
  - keeps `JobsProvider` mounted across nested jobs navigation
  - `Outlet`
- `SettingsLayout`
  - settings nav plus settings content outlet
  - `Outlet`
- Route leaves
  - `AgentsRoute`
  - `AgentDetailRoute`
  - `JobsRoute`
  - `JobsOverviewRoute`
  - `JobDetailRoute`
  - `ActivityMetricsRoute`
  - `ActivityHistoryRoute`
  - `SettingsHomeRoute`
  - `SettingsSectionRoute`
  - `DesignLabRoute`

`App.tsx` should stop reading `location.pathname` to decide which feature tree renders.

### 2. Layouts own stable chrome, not feature implementation

Layouts should keep durable UI mounted across navigation, but they should not absorb feature-specific state just because they stay mounted.

Good layout responsibilities:

- persistent chrome
- structural panels
- shell-level open/close affordances that are truly shared within that layout
- `Outlet` composition
- feature-scoped providers that must stay mounted across nested routes within that feature
  - example: `JobsProvider` belongs in `JobsLayout`, not `AppLayout` and not individual job leaf routes

Bad layout responsibilities:

- create-agent form state
- selected feedback item
- expanded agent card
- selected agent detail state when it belongs in the URL
- stop/delete dialog state that belongs to a list/card feature

### 3. URL owns shareable navigation state

Move shareable agent navigation state into route params/search params.

Recommended agent routes:

- `/agents`
  - no specific agent selected
- `/agents/:agentId`
  - selected/focused agent
- `/agents/:agentId/feedback/:itemId`
  - specific feedback item open
- `/agents/:agentId/review/:summaryAgentId`
  - review summary open
- Optional search params for ephemeral but shareable UI state
  - `?media=1`
  - `?tab=pins`

Recommended settings routes:

- `/settings`
- `/settings/:section`
- `/settings/:section/:subsection`

Recommended activity routes:

- `/activity/metrics`
- `/activity/history`

Use route params when the state should survive reloads, be linkable, or participate in browser history.

### 4. Feature components own local UI state

Push state down until a real shared owner is required.

Examples:

- `AgentCreationControl`
  - owns create dialog open state
  - owns create form state
  - owns mutation for create agent
  - mounted in the agents sidebar header where the create button lives
- `AgentListSection`
  - owns expanded card state if expansion is purely local to the list
  - owns stop/delete confirmation state if dialogs are only triggered from that list
- `FeedbackSurface`
  - derives what to show from route params
  - owns only UI-local animation state needed for transitions
- `MediaSidebar`
  - owns active tab state unless there is a strong need to sync it elsewhere
  - can persist local tab preference without promoting that preference to app-global state

### 5. React Query owns server state

Default to React Query for:

- agent lists
- agent detail/focused agent lookups
- media queries
- create/start/stop/delete mutations
- feedback item fetch/update actions
- settings fetch/update calls

Avoid patterns where API results are fetched, copied into local state, and then manually synchronized unless the UI is intentionally creating a draft/edit buffer.

### 6. Define a single owner for live server state

The refactor should not leave fetchable data split between React Query caches and parallel ad hoc live state stores.

Target rule:

- React Query is the canonical client cache for fetchable server state such as agents, media, feedback, jobs, and settings.
- SSE handlers should update or invalidate React Query caches directly.
- WebSocket terminal transport state remains outside React Query because it is ephemeral session/UI state, not fetchable server state.

Migration guard:

- Do not introduce a second long-lived owner for agent/media/feedback data during the refactor.
- If an existing hook currently owns live state plus a query, its end-state should be either:
  - a thin wrapper around React Query cache plus cache updates, or
  - a terminal/session transport hook for state that is not modeled as server data.

## Specific Refactor Moves

### Phase 1: Strip route branching out of `App.tsx`

- Introduce `AppLayout` with only shared shell chrome and `Outlet`.
- Move feature rendering into router-defined route components.
- Delete path-derived booleans like `jobsOpen`, `settingsOpen`, `activityOpen`, `designLabOpen` from `App.tsx`.

Success criteria:

- major view selection happens in router config, not inside `App.tsx`
- `App.tsx` no longer switches between Jobs, Settings, Activity, and Design Lab content

### Phase 2: Introduce `AgentsLayout` and route-driven agent selection

- Create agents-specific layout under `/agents/*`.
- Replace in-memory `selectedAgentId` with `:agentId` route param.
- Update agent list interactions to navigate to `/agents/:agentId`.
- Update terminal/media/focus hooks to derive selected agent from params instead of root state.
- In the same phase, either move feedback detail to routes too, or enforce a compatibility guard that clears stale feedback state when the route `agentId` changes.

Success criteria:

- refresh/deep-link/back-forward preserve agent selection
- `selectedAgentId` state is removed from `App.tsx`
- feedback UI cannot remain open for a different parent agent than the current route

### Phase 3: Introduce `JobsLayout`

- Move `JobsProvider` out of `App.tsx` and into a dedicated jobs route subtree.
- Keep jobs sidebar and detail pane mounted under that layout so internal jobs navigation does not remount the provider.
- Define nested jobs routes for overview, selected job, selected tab, and selected run.

Success criteria:

- jobs feature state no longer leaks into `App.tsx`
- `JobsProvider` is scoped to the jobs subtree and persists across `/jobs/*` navigation

### Phase 4: Push agent dialogs and list UI state down

- Move create dialog mount and state into an `AgentCreationControl` inside the sidebar header.
- Move stop/delete dialog state out of `App.tsx` into the agent list feature.
- Re-evaluate whether expanded row state must persist across reloads. If not, remove `expandedAgentIdAtom`.

Success criteria:

- `createOpen`, `deleteConfirmOpen`, `stopConfirmOpen`, `deleteTarget`, `stopTarget` are gone from `App.tsx`
- create/delete/stop flows are owned by the feature that renders the controls

### Phase 5: Route-drive feedback panels

- Replace `feedbackDetailAtom` with route-driven detail state.
- Desktop and mobile feedback surfaces should render from the same route state, not a root atom.
- Keep only local transition state near the feedback UI if needed for animations.

Success criteria:

- opening a feedback item updates the URL
- reloading preserves the focused feedback item
- `feedbackDetailAtom` is removed unless a truly cross-cutting use remains

### Phase 6: Re-scope shell visibility state

- Revisit `leftSidebarOpenAtom` and `mediaSidebarOpenAtom`.
- If they only matter inside one layout, move them into that layout.
- If persistence is desirable, persist locally with a small hook rather than Jotai unless multiple distant consumers truly need shared access.

Success criteria:

- shell visibility state lives in the nearest owning layout
- global atoms exist only for demonstrated cross-cutting needs

## Store Cleanup Targets

Current Jotai atoms to challenge first:

- `leftSidebarOpenAtom`
- `mediaSidebarOpenAtom`
- `feedbackDetailAtom`
- `expandedAgentIdAtom`
- `mediaSidebarTabAtom`

Keep only if there is a clear, current justification that they must coordinate across distant subtrees.

## Proposed File/Module Shape

Possible direction:

- `apps/web/src/layouts/app-layout.tsx`
- `apps/web/src/layouts/agents-layout.tsx`
- `apps/web/src/layouts/settings-layout.tsx`
- `apps/web/src/routes/agents-route.tsx`
- `apps/web/src/routes/agent-detail-route.tsx`
- `apps/web/src/routes/activity-metrics-route.tsx`
- `apps/web/src/routes/activity-history-route.tsx`
- `apps/web/src/routes/settings-route.tsx`
- `apps/web/src/routes/job-detail-route.tsx`
- `apps/web/src/components/app/agents/agent-creation-control.tsx`
- `apps/web/src/components/app/agents/agent-list-section.tsx`
- `apps/web/src/components/app/agents/agent-feedback-surface.tsx`
- `apps/web/src/hooks/use-persistent-boolean.ts`

Exact filenames can vary, but the key rule is that routing, layout, and feature ownership should be reflected in the directory structure.

## Non-Goals

- Do not replace local UI state with new context or global stores unless the coordination problem is real.
- Do not move logic into hooks if the hook is still only called from `App.tsx` and the ownership boundary remains unchanged.
- Do not preserve current persistence behavior blindly. Re-evaluate whether each piece of persisted UI state is actually desirable.

## Review Checklist For Future Changes

- Is this state server state? Use React Query.
- Is this state shareable/navigation state? Put it in the URL.
- Is this state only used by one feature/component? Keep it local.
- Is this state only lifted for convenience? Push it back down.
- Is a layout being used to keep stable chrome mounted, or is it becoming a feature dumping ground?
- Is `App.tsx` only composing providers/layouts/routes, or is feature logic drifting back into it?
