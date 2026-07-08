# Provider Quota Usage POC

Status: spike checkpoint
Branch: `spike/provider-quota-snapshots`
Base checkpoint: `f67f66fb Add provider quota tracking POC`

## What This Spike Proves

Dispatch can collect current Codex and Claude quota state, keep append-only quota observations, and render a Usage page that separates current quota status from historical plan-pressure analytics.

The most useful UX shape from the spike is:

- Current provider cards remain detailed, showing windows and provider buckets.
- Historical analytics below the cards stay provider-level.
- Provider-level rollups distinguish short session windows from long duration windows.
- Model-scoped buckets are excluded from provider-level rollups so they do not distort account-plan usage.
- "Left on the table" is most useful as completed-reset history plus average unused values.

## Implemented Scope

Backend:

- `provider_quota_snapshots` stores latest provider quota state.
- `provider_quota_observations` stores append-only historical observations.
- `GET /api/v1/provider-quotas` returns current/latest quota cards.
- `POST /api/v1/provider-quotas/refresh` performs bounded manual refresh.
- `GET /api/v1/provider-quotas/history` accepts Activity-style `start`, `end`, `tz`, and `granularity` params.
- Refresh appends observations tagged as `manual` or `background`.
- Dev seed data creates realistic quota history for Codex and Claude.

Frontend:

- `/usage` page with the existing Activity-style range selector.
- Current cards for Codex and Claude.
- Average utilization chart split by provider and short/long window class.
- Left-on-the-table average cards and time-bucketed bars.
- Success state hides auth/source/account details.

## Auth And Provider Notes

Codex:

- Reads current Codex auth from local Codex credentials.
- Calls ChatGPT WHAM usage endpoint.
- Current live source in validation: `chatgpt-wham`.

Claude:

- Current exercised path reads Claude Code macOS Keychain credentials.
- Calls Anthropic OAuth usage endpoint.
- Current live source in validation: `anthropic-oauth-claude-code-keychain`.

Open questions before production:

- Productize credential discovery without env-var-driven controls.
- Define Linux credential behavior.
- Decide when background refresh may access interactive credential stores.
- Add user-facing controls for refresh cadence/auth status without surfacing raw source names in success UI.

## Historical Data Model

The observation shape is intentionally generic:

- `provider`
- `account_label`
- `account_id`
- `source`
- `window_id`
- `title`
- `kind`
- `scope`
- `observed_at`
- `used_percent`
- `resets_at`
- `window_seconds`
- `status`
- `trigger`
- `error`

This lets new provider buckets appear without schema changes. Provider-specific parsing maps windows into broad `kind` and `scope` values for UI aggregation.

## Source Selection Rules

The dev stack contains both live provider rows and seeded history rows. The spike uses these rules:

- Current cards prefer live/non-`seed-demo` rows when present.
- History chooses one coherent provider/account/source set per provider.
- History can prefer seeded rows when live rows do not have enough coverage for the selected range.
- Completed-window analytics use account-scope rows only.

This avoids mixed live/seed cards while still keeping demo history meaningful.

## UX Decisions

Retained:

- One current card per provider.
- Detailed current rows for windows and buckets.
- Range selector consistent with Activity metrics.
- Provider-level historical summaries.
- Short session vs long duration split.

Changed during review:

- Removed duplicate current card rows caused by seed/live mixing.
- Renamed utilization section to "Average utilization".
- Used averages consistently when labeling values as averages.
- Made left-on-the-table a time-bucketed bar visualization.
- Excluded model-scoped buckets from provider-level rollups.
- Added terse deterministic helper copy under lower section headings.

Deferred:

- Work-hours filtering for M-F and prime working hours.
- Median/percentile options.
- Model bucket detail drilldown.
- Retention and compaction policy.
- Production settings UX.

## Validation

First checkpoint commit:

- Commit: `f67f66fb`
- Commit hook ran formatting, web eslint, and `pnpm run check`.

History/visualization POC validation:

- `pnpm --filter @dispatch/server check`
- `pnpm run check:web`
- `pnpm run finalize:web`
- Playwright `/usage` validation with range switching.
- Final review screenshot: `quota-review-final-2026-07-07-03-06-40-042.png`.

Validation stack used during final review:

- Web: `http://127.0.0.1:60871`
- API: `http://127.0.0.1:60860`
- DB: `60859`
- Cleanup: `dispatch-dev down`

## Known Hardening Items

- Add retention/compaction for append-only observations.
- Revisit whether seeded data should coexist with live data in the same dev DB once the feature matures.
- Replace source-selection heuristics with an explicit account/source model.
- Add route-level integration coverage when the API contract stabilizes.
- Decide how to represent work-hours filters.
- Decide whether short-session usage should default to work-hours-only while weekly windows remain all-hours.
- Keep raw provider payloads out of storage by default; only store normalized observations.
