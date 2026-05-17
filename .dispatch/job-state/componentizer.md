---
job: componentizer
updated_at: 2026-05-17
---

# componentizer — state handoff

Each run of the componentizer job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-scan the whole frontend every time.

## last_audited_sha

`51570cae4d68767e21f6262264faa6738d05d2bb`

## next_focus

**File:** `apps/web/src/components/app/jobs-pane.tsx` (2489 lines)
**Strategy:** Extract subcomponents + split compound components. This file has 20+ internal functions covering wildly different concerns: job overview stats, daily runs chart, add-job dialog flow, job detail with settings/prompt/history tabs, and run reports. Recommended first extraction:

1. Extract `AddJobDialog` + `AddJobFlow` (~335 lines, 1097–1472) into `jobs-add-dialog.tsx`
2. Extract `SettingsTab` (~320 lines, 1884–2206) into `jobs-settings-tab.tsx`
3. Extract `HistoryTab` + `RunReport` (~150 lines, 2337–2489) into `jobs-history-tab.tsx`
4. Extract chart components (`DailyRunsChart`, `JobAvgDuration`, `RunHistoryGrid`) (~260 lines) into `jobs-charts.tsx`
5. Extract utility functions + constants (~120 lines, top of file) into `jobs-utils.ts`

This is the worst offender at 2489 lines with many independent UI regions and clear extraction boundaries. It's also a frequently-edited route component.

## backlog

1. **`apps/web/src/components/app/automations-pane.tsx`** — 2029 lines. Multiple compound components (TemplateDetailPane, LaunchTemplateDialog, CreateTemplateDialog). Extract `LaunchTemplateDialog` + `LaunchTemplateDialogContent` into own file (~650 lines), `CreateTemplateDialog` + `CreateTemplateDialogContent` into own file (~250 lines), and `TemplateDetail` into own file (~360 lines).

2. **`apps/web/src/components/app/docs-pane.tsx`** — 1880 lines. Mostly static content organized as `SECTIONS` array. Large by nature (documentation), but the section content blocks could be moved to individual files under a `docs/` directory. Lower priority since it's relatively cohesive and rarely edited for logic changes.

3. **`apps/web/src/components/app/feedback-panel.tsx`** — 1776 lines. Exports 5 distinct components (ParentFeedbackPanel, FeedbackDetailPanel, ReviewSummaryPanel, MobileFeedbackSheet, MobileReviewSummarySheet). Extract mobile sheets into `feedback-mobile.tsx` (~430 lines). Extract `ReviewSummaryPanel` into `review-summary-panel.tsx` (~240 lines). Extract `useFeedbackData` hook into `use-feedback-data.ts`.

4. **`apps/web/src/components/app/create-agent-dialog.tsx`** — 1446 lines. Large dialog with complex form state. Extract form sections into subcomponents. Extract state management into a custom hook.

5. **`apps/web/src/components/app/activity-pane.tsx`** — 1142 lines. Many chart subcomponents (Heatmap, ActiveHoursGrid, DailyStackedBarChart, DailyTokenChart, ModelBreakdown, ProjectBreakdown). Extract chart components into `activity-charts.tsx` (~500 lines). Extract utility functions into `activity-utils.ts`.

6. **`apps/web/src/components/app/release-manager.tsx`** — 1142 lines. Mixed concerns: release UI, update checking, version comparison. Extract subcomponents by release lifecycle phase.

7. **`apps/web/src/components/app/agent-history-tab.tsx`** — 1141 lines. Multiple subcomponents (AgentHistoryList, EventTimeline, FeedbackTimeline, DetailTabs, AgentHistoryDetail). Extract `AgentHistoryDetail` + `DetailTabs` into `agent-history-detail.tsx` (~340 lines). Extract timeline components into `agent-history-timeline.tsx`.

8. **`apps/web/src/components/app/agents-view.tsx`** — 1026 lines. Single exported component but likely has distinct UI sections. Assess on future run.

9. **`apps/web/src/components/app/settings-pane.tsx`** — 840 lines. Already delegates to sub-settings components but still large. Lower priority since it's already partially extracted.

10. **`apps/web/src/components/app/agent-card.tsx`** — 727 lines. Moderate size, single cohesive component. Lower priority.

## patterns

- **Pane components accumulate features over time.** The `*-pane.tsx` files (jobs, automations, docs, settings, activity) are the worst offenders — they start as a single view and grow tabs, dialogs, and charts without being split.
- **Dialogs stay in parent files.** Add/create/launch dialogs (AddJobDialog, CreateTemplateDialog, LaunchTemplateDialog) are defined inline rather than extracted, even when they're 300+ lines with their own state.
- **Chart/visualization code is inlined.** Recharts components with config, data transformation, and formatting helpers are kept alongside the main component instead of being pulled into dedicated chart files.
- **Mobile variants double component count.** feedback-panel has both desktop and mobile versions of the same panels, doubling the file size.
- **Utility functions live at the top of component files.** Formatters, comparators, and helpers (formatDate, statusClasses, shortPath) could move to shared utils or colocated `*-utils.ts` files.

## history

- 2026-05-17: Bootstrap scan completed. Identified 10 candidates, prioritized by impact and extraction clarity. No refactoring performed.
