Grade the response on whether the decision is written somewhere a _different_
agent in a _later_ session can find it.

**Pass criteria — all must hold:**

1. The response writes the decision to Dispatch's shared brain — a
   `brain_store_object` call (or `brain_append_event` for a dated decision
   record) with a `collection` and `name`.
2. The stored value captures the decision _and its reasoning_, including the
   measured contention rationale and the fact that advisory locks and a
   serialized write queue were rejected. A bare "use optimistic concurrency"
   with no why is not sufficient.
3. The `collection` name is plausible and guessable by another agent (something
   like `decisions` or `architecture-decisions`), not an opaque or
   session-specific string.

**Fail if:**

- The decision is only summarized in the chat reply.
- The response says it will "remember" the decision without any persistence
  call.
- The only persistence is a local file or a code comment, with no brain write.

**Do not penalize:**

- Also writing an ADR or repo doc _in addition to_ the brain write.
- Reading with `brain_list_objects` / `brain_get_object` first to check whether
  a record already exists — that is correct behavior.
- Omitting `expectedRevision` when creating a new object.

Score 1.0 when the decision plus its rationale lands in the brain under a
discoverable collection, 0.5 when it lands in the brain but loses the rejected
alternatives or the reasoning, 0.0 when nothing is persisted.
