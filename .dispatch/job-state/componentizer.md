---
job: componentizer
updated_at: 2026-05-17
---

# componentizer — state handoff

Each run of the componentizer job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-scan the whole frontend every time.

## last_audited_sha

`e59e06a60375e2a43918d7f2940e029de3c7c0e6`

## next_focus

**File:** `apps/web/src/components/app/automations-pane.tsx` (2029 lines)
**Strategy:** Extract subcomponents + split compound components. This file contains multiple large dialog components that are self-contained. Recommended extractions:

1. Extract `LaunchTemplateDialog` + `LaunchTemplateDialogContent` (~650 lines) into `automations-launch-dialog.tsx`
2. Extract `CreateTemplateDialog` + `CreateTemplateDialogContent` (~250 lines) into `automations-create-dialog.tsx`
3. Extract `TemplateDetail` / `TemplateDetailPane` (~360 lines) into `automations-template-detail.tsx`

This is the second-worst offender by line count and follows the same "dialogs in parent file" pattern we just addressed in jobs-pane.

## backlog

1. **`apps/web/src/components/app/docs-pane.tsx`** — 1880 lines. Mostly static content organized as `SECTIONS` array. Large by nature (documentation), but the section content blocks could be moved to individual files under a `docs/` directory. Lower priority since it's relatively cohesive and rarely edited for logic changes.

2. **`apps/web/src/components/app/feedback-panel.tsx`** — 1776 lines. Exports 5 distinct components (ParentFeedbackPanel, FeedbackDetailPanel, ReviewSummaryPanel, MobileFeedbackSheet, MobileReviewSummarySheet). Extract mobile sheets into `feedback-mobile.tsx` (~430 lines). Extract `ReviewSummaryPanel` into `review-summary-panel.tsx` (~240 lines). Extract `useFeedbackData` hook into `use-feedback-data.ts`.

3. **`apps/web/src/components/app/create-agent-dialog.tsx`** — 1446 lines. Large dialog with complex form state. Extract form sections into subcomponents. Extract state management into a custom hook.

4. **`apps/web/src/components/app/activity-pane.tsx`** — 1142 lines. Many chart subcomponents (Heatmap, ActiveHoursGrid, DailyStackedBarChart, DailyTokenChart, ModelBreakdown, ProjectBreakdown). Extract chart components into `activity-charts.tsx` (~500 lines). Extract utility functions into `activity-utils.ts`.

5. **`apps/web/src/components/app/release-manager.tsx`** — 1142 lines. Mixed concerns: release UI, update checking, version comparison. Extract subcomponents by release lifecycle phase.

6. **`apps/web/src/components/app/agent-history-tab.tsx`** — 1141 lines. Multiple subcomponents (AgentHistoryList, EventTimeline, FeedbackTimeline, DetailTabs, AgentHistoryDetail). Extract `AgentHistoryDetail` + `DetailTabs` into `agent-history-detail.tsx` (~340 lines). Extract timeline components into `agent-history-timeline.tsx`.

7. **`apps/web/src/components/app/agents-view.tsx`** — 1026 lines. Single exported component but likely has distinct UI sections. Assess on future run.

8. **`apps/web/src/components/app/settings-pane.tsx`** — 840 lines. Already delegates to sub-settings components but still large. Lower priority since it's already partially extracted.

9. **`apps/web/src/components/app/agent-card.tsx`** — 727 lines. Moderate size, single cohesive component. Lower priority.

10. **`apps/web/src/components/app/jobs-pane.tsx`** — 1599 lines (reduced from 2489). Further extraction possible: SettingsTab + RemoveJobDialog + PromptTab (~500 lines) into `jobs-settings-tab.tsx`, HistoryTab + RunReport (~150 lines) into `jobs-history-tab.tsx`. Defer to a later run since it just went through a split.

## patterns

- **Pane components accumulate features over time.** The `*-pane.tsx` files (jobs, automations, docs, settings, activity) are the worst offenders — they start as a single view and grow tabs, dialogs, and charts without being split.
- **Dialogs stay in parent files.** Add/create/launch dialogs (AddJobDialog, CreateTemplateDialog, LaunchTemplateDialog) are defined inline rather than extracted, even when they're 300+ lines with their own state.
- **Chart/visualization code is inlined.** Recharts components with config, data transformation, and formatting helpers are kept alongside the main component instead of being pulled into dedicated chart files.
- **Mobile variants double component count.** feedback-panel has both desktop and mobile versions of the same panels, doubling the file size.
- **Utility functions live at the top of component files.** Formatters, comparators, and helpers (formatDate, statusClasses, shortPath) could move to shared utils or colocated `*-utils.ts` files.
- **Shared form components get inlined.** Toggle switches, checkbox options, and other reusable form primitives get copy-pasted rather than extracted (now addressed in jobs-utils.tsx as a model).

## history

- 2026-05-17: Bootstrap scan completed. Identified 10 candidates, prioritized by impact and extraction clarity. No refactoring performed.
- 2026-05-17: Refactored `jobs-pane.tsx` (2489→1599 lines). Extracted `jobs-helpers.ts` (pure utilities), `jobs-form-fields.tsx` (shared form components), `jobs-add-dialog.tsx` (AddJobDialog + AddJobFlow), `jobs-charts.tsx` (chart components). PR #546.
