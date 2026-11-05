# Dispatch portfolio export v1

`GET /api/v1/portfolio/v1/export` is a read-only integration surface. It is
independent of account sessions, MCP credentials and first-run password state.
This implementation does not enable collection, issue credentials, deploy, or
change project classification. Anansi remains responsible for its own storage.

## Authorization

An administrator may separately configure the existing settings store key
`portfolio_readers_v1` as an array (maximum eight grants):

```json
[
  {
    "id": "consumer-name",
    "sha256": "<64 lowercase hex characters; SHA-256 of the complete token>",
    "projectIds": ["explicit-personal-project-id"],
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "revoked": false
  }
]
```

No grant is installed by this PR. Provisioning, secure delivery and auditing are
separate operations requiring authorization. A token must have the format
`dpr_` followed by 64 random lowercase hexadecimal characters. Only its digest
belongs in settings. Send the token in `Authorization: Bearer …`; never in a URL.
Malformed/missing configuration fails closed. Removing a grant, setting revoked,
expiry or changing its digest denies the next request. Scope changes invalidate
existing cursors. Grants are read on every request and again after snapshot
creation. Revocation is effective at the authorization check; an already sent
response cannot be recalled.

The reserved portfolio bearer prefix is rejected on every other route and on
all non-GET methods, including when first-run mode or a session cookie would
otherwise authorize the caller. Export reads require their own credential;
account credentials/cookies do not substitute for it. No mutation, provisioning,
MCP, files or full-account API access is granted. The allowlist is explicit and
default empty. New projects, work, unclassified projects and Vellum are excluded
unless an administrator deliberately includes their IDs. There is no reliable
work/personal classification field in Dispatch; the export never guesses one.

## Consumer algorithm

1. Choose UTC instants `from < to <= now` representing the desired local calendar
   window. DST conversion belongs to the consumer. Both endpoints must include
   a timezone; the response normalizes them to UTC.
2. GET `?from=2026-11-04T08:00:00Z&to=2026-11-05T08:00:00Z&limit=50`.
3. Save the response and follow `?cursor=<nextCursor>&limit=50` until null. Omit
   window parameters on continuations, or repeat the exact instants. Limits may
   change; valid values are 1–100, default 50. Treat cursors as opaque.
4. Deduplicate by `(type,id)` within a collection, and retain `updatedAt` across
   collections. Do not treat an interrupted collection as complete. Retry the
   same cursor for the same records. On 410, restart and reconcile the entire
   collection rather than appending it as if it were a continuation.

The response contains `version: dispatch.portfolio.v1`, `snapshotAt`,
`expiresAt`, `window`, `coverage`, `records`, `pageCursor` and nullable `nextCursor`.
`pageCursor` replays the current page (including the first); retain the same limit.
An initial request without a cursor always starts a new snapshot.
Records contain `type`, stable source `id`, `projectId`, source `createdAt`,
source `updatedAt` and `data`. Timestamps are ISO UTC strings; unavailable
inventory placeholders have null timestamps. Evidence links are source IDs,
not claims that their linked deliverables were verified or deployed.

| Type    | Data                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| project | `scope`: included, excluded, or unavailable; included projects also have `name`                            |
| column  | `key`, `name`, `position`, `isDone`                                                                        |
| task    | `columnId`, `title`, `body`, `links`, `archivedAt`, `completedAt`, truncation flags                        |
| session | `parentId` within the same project, `status`, `archivedAt`, `outcomeCoverage`                              |
| outcome | `sessionId`, `toSessionId`, `streamId`, `threadId`, `replyTo`, `kind`, `text`, `textTruncated`, `coverage` |

Project inventory includes every retained project ID. Excluded inventory exposes
only ID, timestamps and scope, without project names, repositories or content.
Allowlisted IDs missing from the retained inventory are explicit unavailable
placeholders. Board inventory includes all retained active and archived tasks and
columns, irrespective of the window: it is the current snapshot, **not** a
historical board reconstruction. Task status derives from its column and
completion/archive timestamps. Acceptance is prose in the task body; Dispatch
has no separately structured acceptance field. Missing columns are not seeded.

Outcomes select human-directed agent blocks and agent reports addressed to their
parent or stream root (recipient must have matching project membership), updated in `[from,to)`, in streams
explicitly associated with the same project by a retained agent or task. Authors
must also have explicit matching project membership. Root and nested thread
blocks use the same selection and each source block appears once. Child agents
are not assigned to a project by inference from cwd or lineage. A reference can
point to a retained source outside the window or a purged source; IDs are evidence
references and do not authorize dereferencing through another API.

Turn blocks contain the persisted settled response prose; an empty response is
returned as `coverage: unavailable`. Running turns may have no persisted prose
until settlement. Ordinary text, reviews and questions posted by agents are
reported prose as well; review state/options, attachments and JSON data are
excluded. Session inventory says unavailable when no retained nonempty turn
block is known, otherwise retained_blocks_only. This is not proof of complete
conversation coverage. No raw engine events, tool arguments/results, thoughts,
launch/system prompts, files, environment or whole transcripts are exported.

Text is capped at 4,096 characters per task body/outcome, task titles at 500,
links at 20 (labels 200, URLs 2,048). Flags identify body/title/link-count/outcome
truncation. Column labels and included project names are bounded metadata.
Credential-shaped content causes the entire record's data to be withheld with
`coverage: withheld_sensitive_content`; source ID and timestamps remain.
Pattern screening cannot identify arbitrary secrets embedded in natural language.
Allowlisting a project therefore requires that its reported prose be appropriate
for the consumer; this endpoint is not a general data-loss prevention system.

## Snapshot and coverage limits

A repeatable-read, read-only PostgreSQL transaction captures the bounded
projection. Records are ordered by type (project, column, task, session, outcome),
then source ID; missing project placeholders follow retained projects in sorted
ID order. Subsequent pages use the immutable in-memory projection, so updates,
archive changes and deletions during pagination cannot shift page boundaries.
Snapshots last 15 minutes and do not survive server restart. At most eight
snapshots/materializations share this process; expired slots are reclaimed on the
next request. Each snapshot is capped at 10,000 records and 8 MiB. Each query has
a ten-second statement timeout. No snapshot tables or source writes are made.

413 means capacity exceeded and the **whole collection is unavailable**, with no
partial success. A narrower time window can reduce outcomes but not inventory;
a larger board requires a future durable streaming contract. 429 means all
snapshot slots are occupied; retry after expiry. 410 means missing/expired cursor
or changed scope. 400 means invalid window, limit, query or cursor. Other errors
are collection failures; the consumer must surface a coverage gap.

There is no durable deletion/tombstone log or historical MVCC snapshot exposed
by these stores. Purged tasks, agents, blocks, previous memberships, edits and
unknown deleted projects cannot be enumerated or reconstructed. Missing
allowlisted project IDs are marked unavailable; all responses explicitly say
`deletions: unavailable_no_tombstone_log` and
`history: current_retained_state_only`. Sessions without explicit membership,
foreign-author/foreign-stream posts, other addressed prompts and non-outcome block
kinds are outside the collection boundary. Retained archived agents/tasks are
included. References to missing thread parents are not fabricated.

The outcome window filters **current source updated_at**, not an immutable event
history. An outcome edited after `to` appears in a later update window, not as
its previous text. Recollect with overlap and deduplication to catch late changes;
never claim this reconstructs an exact prior-day transcript. A session's own
updated timestamp need not advance when a block changes. Consumers must use
outcome timestamps and preserve source attribution as reported claims.

This repository has no OpenAPI generator/artifact for these Fastify routes. This
document and the isolated API/store fixture consumer define the v1 contract.
