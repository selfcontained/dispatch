---
job: componentizer
updated_at: 2026-05-17
---

# componentizer — state handoff

Each run of the componentizer job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-scan the whole frontend every time.

## last_audited_sha

`8c264a7c53d0411edd0e922aa0deff8b762d3887`

## next_focus

**File:** `apps/web/src/components/app/feedback-panel.tsx` (1776 lines)
**Strategy:** Extract compound components + mobile variants. This file exports 5 distinct components (ParentFeedbackPanel, FeedbackDetailPanel, ReviewSummaryPanel, MobileFeedbackSheet, MobileReviewSummarySheet). Recommended extractions:

1. Extract `MobileFeedbackSheet` + `MobileReviewSummarySheet` (~430 lines) into `feedback-mobile.tsx`
2. Extract `ReviewSummaryPanel` (~240 lines) into `review-summary-panel.tsx`
3. Extract `useFeedbackData` hook into `use-feedback-data.ts` if a clear data-fetching hook exists

This follows the "mobile variants double component count" pattern identified in prior runs.

## backlog

1. **`apps/web/src/components/app/docs-pane.tsx`** — 1880 lines. Mostly static content organized as `SECTIONS` array. Large by nature (documentation), but the section content blocks could be moved to individual files under a `docs/` directory. Lower priority since it's relatively cohesive and rarely edited for logic changes.

2. **`apps/web/src/components/app/create-agent-dialog.tsx`** — 1446 lines. Large dialog with complex form state. Extract form sections into subcomponents. Extract state management into a custom hook.

3. **`apps/web/src/components/app/activity-pane.tsx`** — 1142 lines. Many chart subcomponents (Heatmap, ActiveHoursGrid, DailyStackedBarChart, DailyTokenChart, ModelBreakdown, ProjectBreakdown). Extract chart components into `activity-charts.tsx` (~500 lines). Extract utility functions into `activity-utils.ts`.

4. **`apps/web/src/components/app/release-manager.tsx`** — 1142 lines. Mixed concerns: release UI, update checking, version comparison. Extract subcomponents by release lifecycle phase.

5. **`apps/web/src/components/app/agent-history-tab.tsx`** — 1141 lines. Multiple subcomponents (AgentHistoryList, EventTimeline, FeedbackTimeline, DetailTabs, AgentHistoryDetail). Extract `AgentHistoryDetail` + `DetailTabs` into `agent-history-detail.tsx` (~340 lines). Extract timeline components into `agent-history-timeline.tsx`.

6. **`apps/web/src/components/app/agents-view.tsx`** — 1026 lines. Single exported component but likely has distinct UI sections. Assess on future run.

7. **`apps/web/src/components/app/settings-pane.tsx`** — 840 lines. Already delegates to sub-settings components but still large. Lower priority since it's already partially extracted.

8. **`apps/web/src/components/app/agent-card.tsx`** — 727 lines. Moderate size, single cohesive component. Lower priority.

9. **`apps/web/src/components/app/jobs-pane.tsx`** — 1599 lines (reduced from 2489). Further extraction possible: SettingsTab + RemoveJobDialog + PromptTab (~500 lines) into `jobs-settings-tab.tsx`, HistoryTab + RunReport (~150 lines) into `jobs-history-tab.tsx`. Defer to a later run since it just went through a split.

## patterns

- **Pane components accumulate features over time.** The `*-pane.tsx` files (jobs, automations, docs, settings, activity) are the worst offenders — they start as a single view and grow tabs, dialogs, and charts without being split.
- **Dialogs stay in parent files.** Add/create/launch dialogs (AddJobDialog, CreateTemplateDialog, LaunchTemplateDialog) are defined inline rather than extracted, even when they're 300+ lines with their own state.
- **Chart/visualization code is inlined.** Recharts components with config, data transformation, and formatting helpers are kept alongside the main component instead of being pulled into dedicated chart files.
- **Mobile variants double component count.** feedback-panel has both desktop and mobile versions of the same panels, doubling the file size.
- **Utility functions live at the top of component files.** Formatters, comparators, and helpers (formatDate, statusClasses, shortPath) could move to shared utils or colocated `*-utils.ts` files.
- **Shared form components get inlined.** Toggle switches, checkbox options, and other reusable form primitives get copy-pasted rather than extracted (now addressed in jobs-utils.tsx and automations-form-fields.tsx as models).

## history

- 2026-05-17: Bootstrap scan completed. Identified 10 candidates, prioritized by impact and extraction clarity. No refactoring performed.
- 2026-05-17: Refactored `jobs-pane.tsx` (2489→1599 lines). Extracted `jobs-helpers.ts` (pure utilities), `jobs-form-fields.tsx` (shared form components), `jobs-add-dialog.tsx` (AddJobDialog + AddJobFlow), `jobs-charts.tsx` (chart components). PR #546.
- 2026-05-17: Refactored `automations-pane.tsx` (2029→377 lines). Extracted `automations-form-fields.tsx` (AgentTypeCombobox, TemplateWorktreeOption, TemplateFullAccessOption), `automations-launch-dialog.tsx` (LaunchTemplateDialog + context/file handling), `automations-create-dialog.tsx` (CreateTemplateDialog), `automations-template-detail.tsx` (TemplateDetailPane + TemplateDetail).
