# Compact system events — visual checkpoint

Status: visual direction approved personally by the user (69dea286-2dd0-4519-83d9-6af8392bc376). Integrated server metadata and legacy projection; pending code-owner reviews and final CI. Base: PR1439, 0c935fb3a917. Existing persisted events and delivery logic are unchanged.

## Producer inventory

`apps/server/src/chat/service.ts` owns the two explicit system-authored block insertion paths:

- `persistPullRequestNotice`: lifecycle, checks, and merge-risk observations. Existing text blocks carry `pullRequestTransition` metadata and PR attachments. Risk currently receives a special renderer; checks/lifecycle use ordinary text. The risk renderer duplicates its PR resource with the attachment list below it.
- `scheduledNotice`: scheduler informational notices and delivery notices, with `scheduledMessageId`, optional structured presentation, and delivery status. Preserve scheduled-message interaction and real delivery outcome/retry semantics while sharing observation presentation where appropriate.

Task system actors are task activity records, not system-authored feed blocks. Runtime `source: system` envelopes (retry prompts/context) are not persisted informational feed observations. Questions, approvals, reviews and tool output retain their dedicated interactions and authorship.

## Proposed hierarchy

One compact bordered observation, an icon and summary, a semantic badge, then a wrapping metadata line containing Dispatch authorship, time, one resource link and short SHA. Details use the existing Radix/shadcn collapsible and button primitives. Risk wording and classes come from the same shared presentation constants as the PR risk UI. Checks have their own explicit status and never inherit a risk verdict.

The checkpoint renders three risk verdicts (including inconclusive as existing “No recommendation”), three check states, a lifecycle observation and a generic scheduler observation between existing feed Post components. These are staged examples, not evidence of persistence, provenance or history integration.

## Remaining implementation after approval

Define and validate a bounded/versioned trusted-server payload; migrate the inventoried producers; project legacy persisted records without rewriting history; integrate one renderer with resource attachment deduplication; retain delivery metadata and the explanation popover. Verify post/update cannot forge system semantics and preserve sharing/history/recipient/thread invariants. Add focused coverage, persisted isolated-stack validation, real feed/thread interactions, exact-head CI and required reviews. No review/merge policy or provider changes.

## Integrated implementation

The `systemEvent` v1 metadata on existing text blocks is intentionally server-only. `post` resolves text data to null; `update` uses that same sanitizer, and system records retain their existing ownership restrictions. The shared parser bounds the summary/head and validates category/risk/check enums, stripping unknown fields. No new tool or block kind is exposed. Rendering requires actual system authorship before interpreting any metadata. Metadata travels through existing store/history/share/envelope paths; text and attachments remain unchanged for runtime delivery and quoted sharing. Shares keep their own quote interaction and original authorship rather than becoming new Dispatch observations.

Lifecycle/check/risk and scheduler producers now write v1 metadata. Legacy records project from structured provenance (never title matching), with existing risk recommendation strings mapped only for old persisted metadata. Legacy check rollups without structured status show no inferred badge. Generic system text receives an informational fallback. No history migration is needed. Scheduled observations share the outer renderer with controls in expandable content; agent-authored historical schedule cards retain their existing interaction. Questions/approvals/reviews/tool output remain deliberately separate.

The approved revision places the timestamp under the title, removes the redundant Dispatch label, and right-aligns transparent Details; white hover text remains intentional. Runtime timestamps replace the staged fixture time. Real failure/not-attempted delivery metadata and retry controls remain outside the observation presentation unchanged. Check aggregation includes Mixed for neutral/cancelled terminal checks and Pending for unavailable/empty evidence.
