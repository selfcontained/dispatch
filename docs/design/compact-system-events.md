# Compact system events — visual checkpoint

Status: staged design only; awaiting the task owner's personal visual approval before producer migration. Base: PR1439, 0c935fb3a917. Existing persisted events and delivery logic are unchanged.

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
