# Agent checklist progress in the Inbox

The existing agent Inbox lists structured `tasks` blocks in **Agent progress**.
These are the agent's checklists, distinct from task-board `task` cards and from
questions/forms requiring a response. The card shows the author's name (including
archived authors), block text or “Agent checklist”, done/total, and the current
`now` item. Without a current item it shows the next `todo` item; absent statuses
mean `todo`. Empty lists say “No items yet”. Completed lists say “Complete”.

The first feed page carries the newest 12 matching agent checklists, including
replies outside the paginated feed. The API filters by stream and selected view
before applying this bound; later pages omit the collection. Live updates upsert
by block ID and reject older versions. The Inbox deduplicates paged, shown and
supplemental copies by `updatedAt`, then applies the same newest-first bound.
Refetch and reconnect replace the collection from stored state. Completion does
not delete a checklist or move it into an unbounded history: completed and active
lists share the newest-12 budget. There is no dismissal, edit or approval action.

On the root agent page with child messages enabled, all agent checklists in that
stream count. With child messages hidden, the root's own posts for people and
explicitly surfaced top-level outcomes remain visible; child-thread detail is
hidden. A direct child page shows only that child's checklists, independently of
the root toggle. Archived authors do not erase their stored blocks or names.
The existing route/stream authorization still governs access; no other stream's
blocks are imported, including task-only conversations. Task conversations have
no Inbox panel, which remains outside this change's scope.

Displaying a checklist makes no read mutation and adds no “Needs you” badge.
Normal stream reading keeps its existing mark-read behavior. Activation opens
`?thread=<checklist block id>` under the selected agent's root stream, so both a
top-level post and a child-thread reply appear as the original thread root.
The thread's existing read handling marks its replies read; this feature does
not invent a separate checklist unread state or mark its parent thread read.
Deleting a stored block/stream removes it on the normal feed refresh; merely
archiving its author does not. Agent archive/restore and conversation visibility
otherwise follow the existing application behavior.
