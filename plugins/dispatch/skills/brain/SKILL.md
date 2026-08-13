---
name: brain
description: Record decisions, findings, or state in the repo's shared persistent store so they survive this session. Use when you need to remember something for later, look up what was already decided, or accumulate results across runs.
---

# Shared memory (the brain)

Dispatch gives every repo a shared, persistent store that all agents working in
that repo can read and write. It is the only place where something you learn now
is still available to a different agent next week.

Reach for it when you catch yourself thinking any of these:

- "Someone should know this later" → store an object.
- "Was this already decided?" → read before you re-derive.
- "This run found three more of them" → push onto a list.
- "I want a record of what happened, not just the current state" → append an event.

## Three shapes, three purposes

| Shape      | Mutable? | Use it for                                                       |
| ---------- | -------- | ---------------------------------------------------------------- |
| **Object** | yes      | Current state of one named thing — a decision, a config, an idea |
| **List**   | yes      | An ordered, growing collection — a queue, an inbox, a backlog    |
| **Event**  | no       | History — what happened, when, and what was observed             |

Everything is namespaced by `collection` (a topic) plus `name` (the item). Pick a
stable, descriptive collection name and reuse it; a collection nobody can guess is
a collection nobody will read.

## Objects

```
brain_list_objects  collection, namePrefix?, updatedAfter?, limit?
brain_get_object    collection, name
brain_store_object  collection, name, value, expectedRevision?
brain_delete_object collection, name
```

`brain_list_objects` truncates long strings — it is for finding things, not for
reading them. Call `brain_get_object` for the full value.

**Writes use optimistic concurrency.** Omit `expectedRevision` to create. To
update, pass the `revision` you got from your read. A blind overwrite of an
existing object is rejected on purpose: two agents editing the same object is
normal in Dispatch, and last-write-wins would silently destroy the other one's
work. If the write fails on revision mismatch, re-read, merge, and retry — do not
retry with a bumped number.

`value` is a JSON object. Give it a small, consistent shape and keep using it —
something like `{title, status, details, updated}` — so a later reader can scan a
collection without opening every item.

## Lists

```
brain_list_push    collection, name, items, maxItems?
brain_list_get     collection, name, offset?, limit?
brain_get_list_item collection, name, index
brain_list_set     collection, name, index, value
brain_list_remove  collection, name, index | where { field, equals }
brain_list_delete  collection, name
```

`maxItems` caps the list and rolls the oldest entries off — the right way to keep
a rolling log of the last N results without a cleanup pass. `brain_list_get`
reports indexes and truncates long values; `brain_get_list_item` returns one entry
in full.

`brain_list_remove` takes either an `index` or a `where` object — `{ field,
equals }`, matching the first item whose top-level `field` equals that string.
Indexes shift as items are removed, so prefer `where` when you are removing by
identity rather than by position.

## Events

```
brain_append_event  collection, kind, subject?, tags?, value
brain_query_events  collection?, kind?, subject?, tags?, since?, until?, limit?
brain_get_event     id
brain_delete_events ids | (collection + filters), dryRun?
```

Events are append-only. Use them when the sequence matters — assessments over
time, decisions with a date, observations you want to trend. `kind` is the event
type, `subject` is what it is about; both are how you find it again, so set them
deliberately.

Deletion is permanent and unscoped filter deletes reach further than you expect
(kinds and subjects are reused across collections). Always run a filter delete
with `dryRun: true` first and check the match count.

## Conventions that make the brain usable

- **Read before you write.** It is also just good manners: someone may have
  already recorded the thing you are about to record.
- **Absolute dates, not relative ones.** "Last Tuesday" is meaningless to the
  agent that reads it in a month.
- **Name the agent or PR that produced a finding** inside the value, so a reader
  can trace it back.
- **Don't store what the repo already records.** Code structure, git history, and
  file contents are cheaper to read directly than to keep in sync.
